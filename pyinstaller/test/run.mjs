// Build the sample app with PyInstaller (onefile + onedir), inspect it with pyinst.mjs, extract it,
// run the extracted app.pyc with the same Python and compare its output with the executable's.
// If test/pyinstxtractor.py exists, every extracted file is also compared with pyinstxtractor's output.
//
// Env: PYTHON = interpreter that has PyInstaller installed (default: python / python3).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, "..", "pyinst.mjs");
const app = join(here, "sample-app");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const exe = process.platform === "win32" ? ".exe" : "";
const work = mkdtempSync(join(tmpdir(), "pyinst-"));
const pyVersion = execFileSync(python, ["-c", "import sys;print(f'{sys.version_info[0]}.{sys.version_info[1]}')"]).toString().trim();

const node = (...args) => execFileSync(process.execPath, [tool, ...args], { maxBuffer: 1 << 30 }).toString();
const walk = (dir, base = dir, out = new Map()) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.set(relative(base, p).split(sep).join("/"), p);
  }
  return out;
};

let compared = 0;
for (const mode of ["onefile", "onedir"]) {
  const name = `sample-${mode}`;
  execFileSync(python, ["-m", "PyInstaller", "--log-level", "WARN", "--noconfirm", `--${mode}`, "--name", name,
    "--paths", app, "--add-data", `${join(app, "config.json")}${delimiter}.`,
    "--distpath", join(work, "dist"), "--workpath", join(work, "build", mode), "--specpath", join(work, "build"), join(app, "app.py")], { stdio: "ignore" });
  const binary = mode === "onefile" ? join(work, "dist", name + exe) : join(work, "dist", name, name + exe);
  const expectedOutput = execFileSync(binary).toString();

  const info = JSON.parse(node(binary, "--json"));
  assert.equal(info.python, pyVersion, `${mode}: python version`);
  assert.deepEqual(info.entry_points, ["app"], `${mode}: entry point`);
  const modules = info.pyz.modules.map((m) => m.name);
  for (const m of ["licenselib", "licenselib.checker"]) assert.ok(modules.includes(m), `${mode}: PYZ has ${m}`);

  const out = join(work, "extracted", mode);
  node(binary, "--extract", out);
  const ran = execFileSync(python, [join(out, "app.pyc")], { env: { ...process.env, PYTHONPATH: join(out, "PYZ") } }).toString();
  assert.equal(ran, expectedOutput, `${mode}: extracted app.pyc output equals the executable's`);

  const extractor = join(here, "pyinstxtractor.py");
  if (existsSync(extractor)) {
    const oracleDir = join(work, "oracle", mode);
    execFileSync(python, ["-c", "import os,sys,runpy;os.makedirs(sys.argv[2],exist_ok=True);os.chdir(sys.argv[2]);sys.argv=[sys.argv[1],sys.argv[3]];runpy.run_path(sys.argv[0],run_name='__main__')", extractor, oracleDir, binary], { stdio: "ignore" });
    const oracleRoot = join(oracleDir, readdirSync(oracleDir).find((n) => n.endsWith("_extracted")));
    const strip = (k) => k.replace(/^PYZ\.pyz_extracted\//, "PYZ/").replace(/\.pyc$/, "");
    const theirs = new Map([...walk(oracleRoot)].map(([k, v]) => [strip(k), v]));
    const ours = new Map([...walk(out)].map(([k, v]) => [strip(k), v]));
    for (const [k, p] of theirs) {
      assert.ok(ours.has(k), `${mode}: ${k} missing from our extraction`);
      const body = (file) => (file.endsWith(".pyc") ? readFileSync(file).subarray(16) : readFileSync(file));
      assert.ok(body(p).equals(body(ours.get(k))), `${mode}: ${k} differs from pyinstxtractor`);
      compared++;
    }
    assert.equal(ours.size, theirs.size, `${mode}: same number of files as pyinstxtractor`);
  }
  console.log(`${mode}: Python ${info.python}, ${info.entries.length} archive entries, ${modules.length} PYZ modules, extracted app runs with identical output`);
}
console.log(compared ? `pyinstxtractor: ${compared} files byte-identical` : "pyinstxtractor comparison skipped (test/pyinstxtractor.py not present)");
