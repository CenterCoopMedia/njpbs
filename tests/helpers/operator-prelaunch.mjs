import { mkdtemp, mkdir, writeFile, readFile, rm, open, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/** An isolated real Git/process boundary. Never modifies an author checkout.
 * Both repository code and an ignored preload attempt to consume synthetic FDs;
 * neither may evaluate when the entrypoint rejects tracked source. */
export async function refusedOperatorPrelaunch({ filename, businessPath, mode, reader = false, packetFields = {}, supportingFiles = [] }) {
  const dir = await mkdtemp(join(tmpdir(), "operator-prelaunch-"));
  const marker = join(dir, "evaluated.json"), credentialFile = join(tmpdir(), `operator-fd3-${dir.split("/").pop()}`);
  const git = args => execFileSync("git", ["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  let fd;
  try {
    await mkdir(join(dir, "scripts"));
    await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
    await writeFile(join(dir, ".gitignore"), 'node_modules/\nsite/node_modules/\n');
    await mkdir(join(dir, "config"));
    for (const name of ["scripts/render-development-config.mjs", "config/development-inputs.json"]) {
      await writeFile(join(dir, name), await readFile(fileURLToPath(new URL(`../../${name}`, import.meta.url))));
    }
    const entry = join(dir, "scripts", filename);
    await writeFile(entry, await readFile(fileURLToPath(new URL(`../../scripts/${filename}`, import.meta.url))));
    for (const file of supportingFiles) await writeFile(join(dir, 'scripts', file),
      await readFile(fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url))));
    const payload = `import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},JSON.stringify([readFileSync(0,'utf8'),readFileSync(3,'utf8')]));\n`;
    const business = join(dir, businessPath); await mkdir(dirname(business), { recursive: true }); await writeFile(business, payload);
    if (reader) {
      const preload = join(dir, "site/node_modules/tsx/dist/cjs/index.cjs"); await mkdir(dirname(preload), { recursive: true });
      await writeFile(preload, `const f=require('node:fs');f.writeFileSync(${JSON.stringify(marker)},JSON.stringify([f.readFileSync(0,'utf8'),f.readFileSync(3,'utf8')]));\n`);
    }
    git(["init", "--quiet"]); git(["add", "."]); git(["commit", "--quiet", "-m", "Synthetic operator boundary"]);
    const commit = git(["rev-parse", "HEAD"]);
    if (mode === "dirty-tree") await writeFile(business, `${payload}// changed after reviewed commit\n`);
    const packet = Buffer.from(JSON.stringify({ ...packetFields, operatorCommitSha: mode === "wrong-commit" ? "0".repeat(40) : commit }));
    const packetFile = join(tmpdir(), `operator-packet-${dir.split("/").pop()}.json`);
    await writeFile(packetFile, packet);
    await writeFile(credentialFile, "synthetic-service-account-fd3"); fd = await open(credentialFile, "r");
    const status = git(["status", "--porcelain", "--untracked-files=normal"]);
    if (mode === "wrong-commit" ? Boolean(status) : !status) throw new Error("Invalid isolated source fixture");
    let result;
    try {
      execFileSync(process.execPath, [entry, "--packet", packetFile, "--packet-digest", createHash("sha256").update(packet).digest("hex"), "--apply"],
        { cwd: dir, input: "synthetic-provider-token-stdin", encoding: "utf8", stdio: ["pipe", "pipe", "pipe", fd.fd] });
      result = { status: 0 };
    } catch (error) { result = { status: error.status, stdout: error.stdout, stderr: error.stderr }; }
    await rm(packetFile, { force: true });
    let evaluated = false; try { await access(marker); evaluated = true; } catch { /* No module evaluated. */ }
    return { ...result, evaluated };
  } finally { await fd?.close(); await rm(credentialFile, { force: true }); await rm(dir, { recursive: true, force: true }); }
}
