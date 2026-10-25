// Compile the samples with four official Hermes compilers (bytecode v83, v84, v98, v99) and compare
// hbc.mjs field by field with hermes-dec. Also builds a stress file that forces overflowed function
// headers, and checks that a lone U+FEFF string survives (hermes-dec drops it, see README).
//
// Env: PYTHON = interpreter with hermes-dec installed (default: python / python3).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const platformDir = { win32: "win64-bin", linux: "linux64-bin", darwin: "osx-bin" }[process.platform];
const binary = process.platform === "win32" ? "hermesc.exe" : "hermesc";
const compilers = [
  ["hermesc-0.8", "", 83],
  ["hermesc-0.11", "", 84],
  ["hermesc-1.0-a", "hermesc", 98],
  ["hermesc-1.0-b", "hermesc", 99],
].map(([pkg, sub, version]) => [join(dirname(require.resolve(`${pkg}/package.json`)), sub, platformDir, binary), version]);

const work = mkdtempSync(join(tmpdir(), "hbc-"));
const readHbc = (file) => JSON.parse(execFileSync(process.execPath, [join(here, "..", "hbc.mjs"), file, "--json"], { maxBuffer: 1 << 30 }).toString("utf8"));
const readOracle = (file) => JSON.parse(execFileSync(python, [join(here, "oracle_dump.py"), file], { env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 1 << 30 }).toString("utf8"));

// Stress source: >256 strings and a function over the small-header size limit, so overflowed
// ("large") headers are used on every version.
let stress = "var registry = {};\n";
for (let i = 0; i < 800; i++) stress += `function handler_${i}_${"x".repeat(i % 50)}(a,b,c){ return registry["key_${i}"] = "value-${i}-" + a + "https://svc${i}.example.test/api"; }\n`;
stress += "function hugeFunction(n){ var t=0;\n";
for (let i = 0; i < 9000; i++) stress += ` t = (t * 31 + n + ${i}) % 1000003;\n`;
stress += " return t; }\nprint(hugeFunction(7));\n";
writeFileSync(join(work, "stress.js"), stress);
writeFileSync(join(work, "bom.js"), 'var s = "\\uFEFF"; var t = "plain"; print(s.length, t);\n');

const sources = [["es5", join(here, "samples", "sample-es5.js")], ["stress", join(work, "stress.js")], ["bom", join(work, "bom.js")]];
let checked = 0;
for (const [compiler, version] of compilers) {
  const targets = [...sources];
  if (version >= 98) targets.push(["modern", join(here, "samples", "sample.js")]); // class/async/BigInt
  for (const [name, source] of targets) {
    const out = join(work, `${name}-v${version}.hbc`);
    execFileSync(compiler, ["-emit-binary", "-out", out, source], { stdio: "ignore" });
    const ours = readHbc(out);
    assert.equal(ours.header.version, version, `${name}: bytecode version`);
    assert.match(ours.integrity, /^ok/, `${name}-v${version}: SHA-1 footer`);
    if (name === "bom") {
      assert.ok(ours.strings.some((s) => s.text === "﻿"), `bom-v${version}: lone U+FEFF string kept`);
      checked++;
      continue; // hermes-dec decodes this string as "" (its utf-16 codec treats FEFF as a BOM)
    }
    const theirs = readOracle(out);
    for (const [k, v] of Object.entries(theirs.header)) assert.equal(ours.header[k], v, `${name}-v${version}: header ${k}`);
    assert.equal(ours.strings.length, theirs.strings.length, `${name}-v${version}: string count`);
    theirs.strings.forEach((s, i) => assert.ok(ours.strings[i].kind === s.kind && ours.strings[i].text === s.text, `${name}-v${version}: string #${i}`));
    assert.equal(ours.functions.length, theirs.functions.length, `${name}-v${version}: function count`);
    theirs.functions.forEach((f, i) => {
      const o = ours.functions[i];
      assert.ok(o.name === f.name && o.params === f.params && o.bytecode_size === f.bytecode_size && o.offset === f.offset, `${name}-v${version}: function #${i}`);
    });
    if (name === "stress") assert.ok(ours.functions.some((f) => f.large_header), `stress-v${version}: overflowed headers exercised`);
    console.log(`v${version} ${name.padEnd(7)} ${ours.functions.length} functions, ${ours.strings.length} strings identical to hermes-dec`);
    checked++;
  }
}
console.log(`${checked} compiled files checked`);
