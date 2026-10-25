#!/usr/bin/env node
// Prototype: read Hermes bytecode (.hbc / React Native index.android.bundle) without running it.
// Covers the header, integrity footer, function table and string table for bytecode
// versions 76-99. Disassembly/decompilation is out of scope (use hermes-dec / hbctool).
// Usage:
//   node hbc.mjs file.hbc              # summary: version, integrity, functions, notable strings
//   node hbc.mjs file.hbc --strings    # every string with its kind
//   node hbc.mjs file.hbc --json       # machine-readable
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const MAGIC = 0x1f1903c103bc1fc6n;
const DELTA_MAGIC = ~MAGIC & 0xffffffffffffffffn; // delta-optimized bundles
class FormatError extends Error {}

const parse = (buf) => {
  if (buf.length < 128) throw new FormatError("file is shorter than a Hermes header");
  const magic = buf.readBigUInt64LE(0);
  if (magic !== MAGIC) throw new FormatError(magic === DELTA_MAGIC ? "delta-format Hermes file (not supported)" : "no Hermes bytecode magic");
  const version = buf.readUInt32LE(8);
  if (version < 76 || version > 99) throw new FormatError(`bytecode version ${version} is outside the supported range 76-99`);

  // ---- header (fields depend on the version; the header is padded to 32 bytes) ----
  let pos = 32;
  const u32 = () => { const v = buf.readUInt32LE(pos); pos += 4; return v; };
  const h = { version, sourceHash: buf.subarray(12, 32).toString("hex") };
  for (const k of ["fileLength", "globalCodeIndex", "functionCount", "stringKindCount", "identifierCount", "stringCount", "overflowStringCount", "stringStorageSize"]) h[k] = u32();
  if (version >= 87) { h.bigIntCount = u32(); h.bigIntStorageSize = u32(); }
  h.regExpCount = u32(); h.regExpStorageSize = u32();
  if (version < 97) { h.arrayBufferSize = u32(); h.objKeyBufferSize = u32(); h.objValueBufferSize = u32(); }
  else { h.literalValueBufferSize = u32(); h.objKeyBufferSize = u32(); h.objShapeTableCount = u32(); if (version >= 98) h.numStringSwitchImms = u32(); }
  h.segmentID = u32(); h.cjsModuleCount = u32();
  if (version >= 84) h.functionSourceCount = u32();
  h.debugInfoOffset = u32();
  const options = buf[pos++];
  Object.assign(h, { staticBuiltins: !!(options & 1), cjsModulesStaticallyResolved: !!(options & 2), hasAsync: !!(options & 4) });
  pos = Math.ceil(pos / 32) * 32;

  // ---- integrity footer: SHA-1 of everything before it (since v75) ----
  let integrity = "not checked";
  if (h.fileLength > buf.length) integrity = `truncated: header says ${h.fileLength} bytes, file has ${buf.length}`;
  else {
    const expected = buf.subarray(h.fileLength - 20, h.fileLength);
    const actual = createHash("sha1").update(buf.subarray(0, h.fileLength - 20)).digest();
    integrity = actual.equals(expected) ? "ok (SHA-1 footer matches)" : "MISMATCH (file modified or corrupt)";
  }

  // ---- function headers ----
  const smallSize = version >= 97 ? 12 : 16;
  const headersStart = pos;
  const functions = [];
  for (let i = 0; i < h.functionCount; i++) {
    const at = headersStart + i * smallSize;
    const w0 = buf.readUInt32LE(at), w1 = buf.readUInt32LE(at + 4);
    let f;
    if (version < 97) {
      const w2 = buf.readUInt32LE(at + 8);
      f = { offset: w0 & 0x1ffffff, paramCount: w0 >>> 25, size: w1 & 0x7fff, name: w1 >>> 15, infoOffset: w2 & 0x1ffffff, flags: buf[at + 15] };
    } else if (version === 97) {
      f = { offset: w0 & 0x1ffffff, paramCount: w0 >>> 25, size: w1 & 0x7fff, name: w1 >>> 15, flags: buf[at + 11] };
    } else {
      f = { offset: w0 & 0x1ffffff, paramCount: (w0 >>> 25) & 0x1f, size: w1 & 0x3fff, name: (w1 >>> 14) & 0xff, flags: buf[at + 11] };
    }
    if (f.flags & 0x20) {
      // Overflowed: the full header lives elsewhere; its location is split across fields.
      const largeAt = version < 97 ? ((f.infoOffset << 16) | f.offset) >>> 0 : (f.name * (version >= 98 ? 2 ** 24 : 2 ** 16) + f.offset);
      const r = (n) => buf.readUInt32LE(largeAt + 4 * n);
      f = version >= 98
        ? { offset: r(0), paramCount: r(1), size: r(3), name: r(4), flags: buf[largeAt + 35], overflowed: true }
        : { offset: r(0), paramCount: r(1), size: r(2), name: r(3), flags: buf[largeAt + (version < 97 ? 30 : 23)], overflowed: true };
    }
    f.index = i;
    f.kind = ["normal", "generator", "async", "arrow"][f.flags >> 6] ?? "unknown";
    f.strict = !!(f.flags & 0x04);
    functions.push(f);
  }
  pos = headersStart + h.functionCount * smallSize;
  const align = () => { pos = Math.ceil(pos / 4) * 4; };

  // ---- string kinds, identifier hashes, string tables ----
  align();
  const kinds = [];
  for (let i = 0; i < h.stringKindCount; i++) { const v = u32(); kinds.push(...Array((v & 0x7fffffff)).fill(v >>> 31 ? "identifier" : "string")); }
  align(); pos += 4 * h.identifierCount;
  align();
  const small = [];
  for (let i = 0; i < h.stringCount; i++) { const v = u32(); small.push({ utf16: !!(v & 1), offset: (v >>> 1) & 0x7fffff, length: v >>> 24 }); }
  align();
  const overflow = [];
  for (let i = 0; i < h.overflowStringCount; i++) overflow.push({ offset: u32(), length: u32() });
  align();
  const storageStart = pos;
  if (storageStart + h.stringStorageSize > buf.length) throw new FormatError("string storage runs past the end of the file");
  const strings = small.map((e, i) => {
    const info = e.length === 0xff ? overflow[e.offset] : e;
    if (!info) throw new FormatError(`string ${i} points at a missing overflow entry`);
    const start = storageStart + info.offset;
    const bytes = buf.subarray(start, start + info.length * (e.utf16 ? 2 : 1));
    return { index: i, kind: kinds[i] ?? "string", utf16: e.utf16, text: e.utf16 ? bytes.toString("utf16le") : bytes.toString("latin1"), fileOffset: start };
  });
  for (const f of functions) f.nameText = strings[f.name]?.text ?? `<string ${f.name}>`;
  return { header: h, integrity, functions, strings };
};

// Strings that usually matter first when looking at an app.
const NOTABLE = [
  ["url", /^(https?|wss?):\/\/\S+$/i],
  ["key-like", /^(pk|sk|rk)_(test|live)_|^AIza[0-9A-Za-z_-]{20,}|^AKIA[0-9A-Z]{16}$|^ghp_|^xox[abp]-|^eyJ[a-zA-Z0-9_-]{10,}\./],
  ["path", /^\/[A-Za-z0-9_\-./{}:]+$/],
  ["email", /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i],
];

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: node hbc.mjs <file.hbc> [--strings] [--json]"); process.exit(2); }
let r;
try { r = parse(readFileSync(file)); } catch (e) {
  if (!(e instanceof FormatError)) throw e;
  console.error(`not readable as Hermes bytecode: ${e.message}`);
  process.exit(1);
}
const { header: h } = r;
if (args.includes("--json")) {
  console.log(JSON.stringify({ header: h, integrity: r.integrity,
    functions: r.functions.map(({ index, nameText, paramCount, size, offset, kind, strict, overflowed }) => ({ index, name: nameText, params: paramCount, bytecode_size: size, offset, kind, strict, ...(overflowed ? { large_header: true } : {}) })),
    strings: r.strings.map(({ index, kind, utf16, text, fileOffset }) => ({ index, kind, encoding: utf16 ? "utf16" : "latin1", text, offset: fileOffset })) }, null, 2));
  process.exit(0);
}
console.log(`Hermes bytecode v${h.version} in ${file}`);
console.log(`  ${h.fileLength} bytes, integrity ${r.integrity}, source hash ${h.sourceHash}`);
console.log(`  ${h.functionCount} functions, ${h.stringCount} strings (${h.identifierCount} identifiers, ${h.overflowStringCount} long), ${h.regExpCount} regexps${h.bigIntCount ? `, ${h.bigIntCount} BigInts` : ""}${h.cjsModuleCount ? `, ${h.cjsModuleCount} CommonJS modules` : ""}${h.hasAsync ? ", uses async" : ""}`);
if (args.includes("--strings")) {
  for (const s of r.strings) console.log(`  #${String(s.index).padEnd(5)} ${s.kind.padEnd(10)} ${JSON.stringify(s.text)}`);
  process.exit(0);
}
const named = r.functions.filter((f) => f.nameText !== "");
console.log(`\n  functions: ${named.length} named, ${r.functions.length - named.length} anonymous (bundlers wrap modules in unnamed factories)`);
for (const f of named.slice(0, 40)) console.log(`    #${String(f.index).padEnd(4)} ${f.nameText.padEnd(24)} ${String(f.paramCount).padStart(2)} params  ${String(f.size).padStart(6)} bytes @0x${f.offset.toString(16)}${f.kind !== "normal" ? `  (${f.kind})` : ""}`);
if (named.length > 40) console.log(`    ... ${named.length - 40} more named (use --json)`);
const notable = r.strings.filter((s) => s.kind === "string").flatMap((s) => NOTABLE.filter(([, re]) => re.test(s.text)).map(([tag]) => [tag, s]));
console.log("\n  notable strings:");
for (const [tag, s] of notable.slice(0, 50)) console.log(`    ${tag.padEnd(9)} #${String(s.index).padEnd(5)} ${JSON.stringify(s.text)}`);
const nonAscii = r.strings.filter((s) => s.utf16);
if (nonAscii.length) console.log(`    utf-16    ${nonAscii.slice(0, 5).map((s) => JSON.stringify(s.text)).join(", ")}${nonAscii.length > 5 ? ", ..." : ""}`);
