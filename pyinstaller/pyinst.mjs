#!/usr/bin/env node
// Prototype: inspect and extract PyInstaller executables (CArchive + PYZ), read-only.
// Usage:
//   node pyinst.mjs app.exe                 # summary + table of contents
//   node pyinst.mjs app.exe --json          # same, machine-readable
//   node pyinst.mjs app.exe --extract DIR   # write entries; scripts/modules become runnable .pyc files
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { inflateSync } from "node:zlib";

const COOKIE_MAGIC = Buffer.from("MEI\x0c\x0b\x0a\x0b\x0e", "latin1");
const TYPECODES = {
  s: "entry-point script", m: "module", M: "package", b: "binary (DLL/so)", z: "PYZ archive", Z: "zipfile",
  x: "data file", o: "runtime option", d: "dependency", l: "symlink", n: "splash resources", e: "extension",
};
// First 2 bytes of the .pyc magic per CPython version (second half is always 0d0a).
const PYC_MAGIC = { 37: 3394, 38: 3413, 39: 3425, 310: 3439, 311: 3495, 312: 3531, 313: 3571, 314: 3627 };

// Top-level stdlib module names: sys.stdlib_module_names from CPython 3.13, the 3.14 additions
// (annotationlib, compression, _ast_unparse, _py_warnings, _zstd) and PyInstaller bootstrap modules.
const STDLIB = new Set(JSON.parse(readFileSync(new URL("./stdlib-names.json", import.meta.url), "utf8")));

class FormatError extends Error {}

// ---------- CArchive ----------

const findCookie = (buf) => {
  // The cookie closes the archive; Authenticode signatures or other overlays may follow it.
  const pos = buf.lastIndexOf(COOKIE_MAGIC);
  if (pos < 0) throw new FormatError("no PyInstaller archive cookie (MEI\\014\\013\\012\\013\\016) found");
  const hasLibName = pos + 88 <= buf.length && /^[\x20-\x7e]*\0/.test(buf.subarray(pos + 24, pos + 88).toString("latin1"));
  const cookieLength = hasLibName ? 88 : 24;
  const packageLength = buf.readUInt32BE(pos + 8);
  const tocOffset = buf.readUInt32BE(pos + 12);
  const tocLength = buf.readUInt32BE(pos + 16);
  const pyver = buf.readInt32BE(pos + 20);
  const pylib = hasLibName ? buf.subarray(pos + 24, pos + 88).toString("latin1").replace(/\0.*$/s, "") : null;
  const packageStart = pos + cookieLength - packageLength;
  if (packageStart < 0 || tocOffset + tocLength > packageLength) throw new FormatError("cookie offsets fall outside the file");
  return { cookieOffset: pos, cookieLength, packageStart, packageLength, tocOffset, tocLength, pyver, pylib, trailingBytes: buf.length - (pos + cookieLength) };
};

const readToc = (buf, cookie) => {
  const entries = [];
  let pos = cookie.packageStart + cookie.tocOffset;
  const end = pos + cookie.tocLength;
  while (pos < end) {
    const entryLength = buf.readUInt32BE(pos);
    if (entryLength < 18 || pos + entryLength > end) throw new FormatError(`bad TOC entry length ${entryLength} at ${pos}`);
    const dataOffset = buf.readUInt32BE(pos + 4);
    const compressedLength = buf.readUInt32BE(pos + 8);
    const length = buf.readUInt32BE(pos + 12);
    const compressed = buf[pos + 16] !== 0;
    const typecode = String.fromCharCode(buf[pos + 17]);
    const name = buf.subarray(pos + 18, pos + entryLength).toString("utf8").replace(/\0+$/, "");
    entries.push({ name, typecode, kind: TYPECODES[typecode] ?? "unknown", fileOffset: cookie.packageStart + dataOffset, compressedLength, length, compressed });
    pos += entryLength;
  }
  return entries;
};

const entryData = (buf, entry) => {
  const raw = buf.subarray(entry.fileOffset, entry.fileOffset + entry.compressedLength);
  return entry.compressed ? inflateSync(raw) : raw;
};

// ---------- minimal marshal reader (enough for PYZ tables of contents) ----------

const readMarshal = (buf, start = 0) => {
  let pos = start;
  const refs = [];
  const int32 = () => { const v = buf.readInt32LE(pos); pos += 4; return v; };
  const value = () => {
    const code = buf[pos++];
    const flag = code & 0x80;
    const type = String.fromCharCode(code & 0x7f);
    let slot = -1;
    if (flag) { slot = refs.length; refs.push(undefined); }
    const keep = (v) => { if (slot >= 0) refs[slot] = v; return v; };
    switch (type) {
      case "N": return null;
      case "T": return true;
      case "F": return false;
      case "i": return keep(int32());
      case "z": case "Z": { const n = buf[pos++]; const s = buf.toString("latin1", pos, pos + n); pos += n; return keep(s); }
      case "a": case "A": { const n = int32(); const s = buf.toString("latin1", pos, pos + n); pos += n; return keep(s); }
      case "u": case "t": { const n = int32(); const s = buf.toString("utf8", pos, pos + n); pos += n; return keep(s); }
      case "s": { const n = int32(); const b = buf.subarray(pos, pos + n); pos += n; return keep(b); }
      case ")": { const n = buf[pos++]; const out = keep([]); for (let i = 0; i < n; i++) out.push(value()); return out; }
      case "(": case "[": { const n = int32(); const out = keep([]); for (let i = 0; i < n; i++) out.push(value()); return out; }
      case "{": { const out = keep(new Map()); for (;;) { if (buf[pos] === 0x30) { pos++; return out; } const k = value(); out.set(k, value()); } }
      case "r": return refs[int32()];
      default: throw new FormatError(`unsupported marshal type ${JSON.stringify(type)} at ${pos - 1}`);
    }
  };
  return value();
};

const readPyz = (data) => {
  if (data.toString("latin1", 0, 4) !== "PYZ\0") throw new FormatError("PYZ entry does not start with PYZ\\0");
  const pycMagic = data.subarray(4, 8);
  const tocOffset = data.readUInt32BE(8);
  const toc = readMarshal(data, tocOffset);
  const items = (toc instanceof Map ? [...toc.entries()] : toc).map(([name, info]) => {
    const [typecode, offset, length] = info;
    return { name, typecode: ["module", "package", "data", "namespace package"][typecode] ?? `type ${typecode}`, offset, length };
  });
  return { pycMagic, items };
};

// ---------- output ----------

const pycHeader = (magic) => Buffer.concat([magic, Buffer.alloc(12)]); // PEP 552: flags=0, then 8 zero bytes

const safeJoin = (root, name) => {
  const target = normalize(join(root, name));
  if (!target.startsWith(normalize(root) + sep)) throw new FormatError(`refusing to write outside the output folder: ${name}`);
  return target;
};

const inspect = (path) => {
  const buf = readFileSync(path);
  const cookie = findCookie(buf);
  const entries = readToc(buf, cookie);
  const pyzEntry = entries.find((e) => e.typecode === "z");
  const pyz = pyzEntry ? readPyz(entryData(buf, pyzEntry)) : null;
  const major = Math.floor(cookie.pyver / 100);
  const minor = cookie.pyver % 100;
  return {
    buf, cookie, entries, pyz,
    python: `${major}.${minor}`,
    pycMagic: pyz?.pycMagic ?? (PYC_MAGIC[cookie.pyver] ? Buffer.from([PYC_MAGIC[cookie.pyver] & 255, PYC_MAGIC[cookie.pyver] >> 8, 0x0d, 0x0a]) : null),
    layout: entries.some((e) => e.typecode === "b") ? "onefile (binaries embedded)" : "onedir (binaries beside the executable)",
  };
};

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--extract");
if (!file) {
  console.error("usage: node pyinst.mjs <app.exe> [--json] [--extract DIR]");
  process.exit(2);
}
let result;
try {
  result = inspect(file);
} catch (error) {
  if (!(error instanceof FormatError)) throw error;
  console.error(`not a readable PyInstaller executable: ${error.message}`);
  process.exit(1);
}
const { buf, cookie, entries, pyz } = result;
const scripts = entries.filter((e) => e.typecode === "s" && !/^pyi_|^pyiboot/.test(e.name));

if (args.includes("--json")) {
  console.log(JSON.stringify({
    python: result.python, python_library: cookie.pylib, layout: result.layout,
    archive: { start: cookie.packageStart, length: cookie.packageLength, cookie_offset: cookie.cookieOffset, bytes_after_cookie: cookie.trailingBytes },
    entry_points: scripts.map((e) => e.name),
    entries: entries.map(({ name, typecode, kind, fileOffset, compressedLength, length, compressed }) => ({ name, typecode, kind, file_offset: fileOffset, stored_length: compressedLength, length, compressed })),
    pyz: pyz && { pyc_magic: pyz.pycMagic.toString("hex"), modules: pyz.items },
  }, null, 2));
} else {
  console.log(`PyInstaller archive in ${file}`);
  console.log(`  Python ${result.python} (${cookie.pylib ?? "library name not recorded"}), ${result.layout}`);
  console.log(`  archive @${cookie.packageStart}, ${cookie.packageLength} bytes, cookie @${cookie.cookieOffset}${cookie.trailingBytes ? `, ${cookie.trailingBytes} bytes after it (e.g. a signature)` : ""}`);
  console.log(`  entry point script(s): ${scripts.map((e) => e.name).join(", ") || "(none found)"}`);
  const counts = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  console.log(`  ${entries.length} archive entries: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  if (pyz) {
    const top = (name) => name.split(".")[0];
    const own = pyz.items.filter((i) => !STDLIB.has(top(i.name)));
    console.log(`  PYZ: ${pyz.items.length} modules (pyc magic ${pyz.pycMagic.toString("hex")})`);
    console.log(`  non-stdlib modules (app code and third-party packages): ${own.map((i) => i.name).join(", ") || "(none)"}`);
  }
  console.log("");
  for (const e of entries) console.log(`  ${e.typecode}  ${String(e.length).padStart(9)}  @${String(e.fileOffset).padEnd(9)} ${e.name}`);
}

const outIndex = args.indexOf("--extract");
if (outIndex >= 0) {
  const root = normalize(args[outIndex + 1]);
  let written = 0;
  const write = (name, data) => {
    const target = safeJoin(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    written++;
  };
  for (const e of entries) {
    const data = entryData(buf, e);
    if (e.typecode === "s" && result.pycMagic) write(`${e.name}.pyc`, Buffer.concat([pycHeader(result.pycMagic), data]));
    else if (e.typecode === "z") {
      write(e.name, data);
      for (const item of pyz.items) {
        const code = inflateSync(data.subarray(item.offset, item.offset + item.length));
        const rel = item.name.split(".").join("/") + (item.typecode === "package" ? "/__init__.pyc" : ".pyc");
        if (item.typecode === "module" || item.typecode === "package") write(join("PYZ", rel), Buffer.concat([pycHeader(pyz.pycMagic), code]));
      }
    } else if (e.typecode !== "o") write(e.name, data);
  }
  console.log(`\nextracted ${written} files to ${root}`);
}
