import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface PythonWheel { name: string; data: string }

/** Resolve normal package requirements without executing package code on the
 * host. Portable wheels are bundled with the app and imported inside Wasm. */
export async function buildPythonPackages(appDir: string): Promise<{ wheels: PythonWheel[] } | { error: string }> {
  let requirements: unknown;
  try { requirements = JSON.parse(readFileSync(join(appDir, "manifest.json"), "utf8")).python?.packages ?? []; }
  catch (err) { return { error: `Cannot read Python requirements: ${(err as Error).message}` }; }
  if (!Array.isArray(requirements) || requirements.some((r) => typeof r !== "string" || !/^[A-Za-z0-9][^\r\n\0@/\\]*$/.test(r))) {
    return { error: "python.packages must contain indexed Python package requirements, with optional extras/version constraints." };
  }
  if (requirements.length === 0) return { wheels: [] };
  const fingerprint = createHash("sha256").update(JSON.stringify({ python: "3.13", requirements })).digest("hex");
  const cache = join(appDir, ".python-packages");
  const readWheels = (dir: string) => {
    const inside = relative(realpathSync(appDir), realpathSync(dir));
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw new Error("Python package cache must stay inside the app directory.");
    let total = 0;
    return readdirSync(dir).filter((name) => name.endsWith(".whl")).sort().map((name) => {
      const path = join(dir, name), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Python wheels must be regular files.");
      total += info.size;
      if (total > 40 << 20) throw new Error("Python wheel bundle exceeds the 40 MiB limit.");
      return { name, data: readFileSync(path).toString("base64") };
    });
  };
  if (existsSync(join(cache, "requirements.sha256")) && readFileSync(join(cache, "requirements.sha256"), "utf8") === fingerprint) {
    try { const wheels = readWheels(cache); if (wheels.length) return { wheels }; }
    catch (err) { return { error: (err as Error).message }; }
  }
  const staging = mkdtempSync(join(appDir, ".python-packages-"));
  try {
    await execFileAsync(process.env.PYTHON ?? "python3", [
      "-m", "pip", "--isolated", "download", "--disable-pip-version-check", "--no-cache-dir",
      "--only-binary=:all:", "--platform", "any", "--implementation", "py", "--abi", "none",
      "--python-version", "3.13", "--dest", staging, "--", ...requirements,
    ], { timeout: 120_000, maxBuffer: 1 << 20 });
    const wheels = readWheels(staging);
    if (wheels.length === 0) return { error: "No Python packages were resolved." };
    writeFileSync(join(staging, "requirements.sha256"), fingerprint);
    rmSync(cache, { recursive: true, force: true });
    renameSync(staging, cache);
    return { wheels };
  } catch (err) {
    const error = err as Error & { stderr?: string; stdout?: string };
    return { error: `Python package resolution failed. A compatible portable wheel is required; native extensions need a Wasm build. Ensure Python 3 and pip are installed.\n${error.stderr || error.stdout || error.message}` };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
