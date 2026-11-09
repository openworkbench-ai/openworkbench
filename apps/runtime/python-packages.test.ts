import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { buildPythonPackages } from "./python-packages.js";

test("package resolution bundles direct/transitive wheels and reuses the exact cached set", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "owb-python-packages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PYTHON;
  t.after(() => { if (previous === undefined) delete process.env.PYTHON; else process.env.PYTHON = previous; });
  const fakePython = join(dir, "python.cjs");
  writeFileSync(fakePython, `#!${process.execPath}
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
assert.deepEqual(args.slice(0,4),['-m','pip','--isolated','download']);
assert.ok(args.includes('--only-binary=:all:'));
assert.equal(args[args.indexOf('--platform')+1],'any');
assert.equal(args[args.indexOf('--python-version')+1],'3.13');
assert.deepEqual(args.slice(args.indexOf('--')+1),['demo==1.0']);
const dest=args[args.indexOf('--dest')+1];
fs.writeFileSync(path.join(dest,'demo-1.0-py3-none-any.whl'),'direct wheel');
fs.writeFileSync(path.join(dest,'dependency-2.0-py3-none-any.whl'),'transitive wheel');
`, { mode: 0o755 });
  process.env.PYTHON = fakePython;
  const manifest = { python: { packages: ["demo==1.0"] } };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const first = await buildPythonPackages(dir);
  assert.ok(!("error" in first), JSON.stringify(first));
  assert.equal(first.wheels.length, 2);
  assert.equal(Buffer.from(first.wheels.find(w => w.name.startsWith("demo-"))!.data, "base64").toString(), "direct wheel");
  process.env.PYTHON = join(dir, "does-not-exist");
  assert.deepEqual(await buildPythonPackages(dir), first);
  assert.ok(readFileSync(join(dir, ".python-packages", "requirements.sha256"), "utf8").length > 0);
  manifest.python.packages = ["other==2.0"];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  assert.ok("error" in await buildPythonPackages(dir));
});

test("package declarations are generic requirements, not host paths or pip switches", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "owb-python-reqs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const requirement of ["--index-url", "demo\n-r/etc/passwd", "demo @ file:///private/demo.whl"]) {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ python: { packages: [requirement] } }));
    assert.ok("error" in await buildPythonPackages(dir));
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({}));
  assert.deepEqual(await buildPythonPackages(dir), { wheels: [] });
});
