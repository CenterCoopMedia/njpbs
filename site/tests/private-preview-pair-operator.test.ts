// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewProviderFixture } from "../../tests/helpers/private-preview-provider-fixture.js";
import { pair } from "../../tests/helpers/cms-preview-pairs.js";
import { releasePair, pairReference } from "../../tests/helpers/private-public-release-pair.js";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "private-preview-cli-")); directories.push(root);
  await mkdir(path.join(root, "scripts/lib"), { recursive: true }); await mkdir(path.join(root, "functions"));
  for (const name of ["private-preview-pair-provider", "install-private-preview-pair", "public-release-private-install-ledger", "public-release-private-provider", "cms-component-receipt", "private-pair-preflight-caller", "private-preview-packet", "deployment-settings"]) {
    await cp(path.join(repository, `scripts/lib/${name}.mjs`), path.join(root, `scripts/lib/${name}.mjs`));
  }
  for (const file of ["install-private-preview-pair.mjs", "bind-private-preview-packets.mjs"]) await cp(path.join(repository, "scripts", file), path.join(root, "scripts", file));
  await cp(path.join(repository, "scripts/render-development-config.mjs"), path.join(root, "scripts/render-development-config.mjs"));
  await mkdir(path.join(root, "config"));
  await cp(path.join(repository, "config/development-inputs.json"), path.join(root, "config/development-inputs.json"));
  await cp(path.join(repository, "functions/lib"), path.join(root, "functions/lib"), { recursive: true });
  await cp(path.join(repository, "functions/package.json"), path.join(root, "functions/package.json"));
  await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"));
  await mkdir(path.join(root, "site")); await symlink(path.join(repository, "site/node_modules"), path.join(root, "site/node_modules"));
  await mkdir(path.join(root, "site/scripts"));
  for (const file of ["cms-preview-pair-install-credentials.ts", "cms-publication-credentials.ts", "cms-preview-storage-credential.ts"]) {
    await cp(path.join(repository, "site/scripts", file), path.join(root, "site/scripts", file));
  }
  await writeFile(path.join(root, ".gitignore"), "node_modules\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]); git(["config", "user.name", "Fixture Author"]); git(["config", "user.email", "fixture-author@example.org"]); git(["add", "."]); git(["commit", "-qm", "Operator fixture"]);
  const f = await previewProviderFixture({ main: path.join(root, "preview-renderer/worker.ts") });
  const multipartPath = path.join(tmpdir(), `preview-cli-${path.basename(root)}.multipart`); directories.push(multipartPath); await writeFile(multipartPath, f.multipart);
  const operationId = "preview-cli-proof";
  const packet = { schemaVersion: 1, sourceSha: git(["rev-parse", "HEAD"]), pair: f.descriptor, config: f.config, image: f.image,
    multipartPath, multipartDigest: createHash("sha256").update(f.multipart).digest("hex"), resourceOperationId: operationId,
    request: { operationId, expectedRuntimeDigest: "a".repeat(64), expectedCandidatePointerDigest: null,
      bootstrapPublicPair: pairReference(releasePair()), candidate: { sourceSha: f.descriptor.rendererSha, trustedWorkflowSha: "e".repeat(40),
        runId: "100", runAttempt: 1, inputFingerprint: f.prepared.bundleDigest, configurationFingerprint: f.prepared.configurationDigest } } };
  const packetPath = path.join(tmpdir(), `preview-cli-${path.basename(root)}.json`); directories.push(packetPath);
  const run = async (mode = "plan", changes = {}, environment = {}) => {
    await writeFile(packetPath, JSON.stringify({ ...packet, ...changes }));
    return spawnSync(process.execPath, ["--import", "./site/node_modules/tsx/dist/loader.mjs", "scripts/install-private-preview-pair.mjs", mode, packetPath],
      { cwd: root, encoding: "utf8", env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
  };
  const commit = () => { git(["add", "."]); git(["commit", "-qm", "Credential boundary fixture"]); packet.sourceSha = git(["rev-parse", "HEAD"]); };
  return { run, root, packet, packetPath, commit };
}
it("executes actual CLI plan from a clean tracked source with no credential descriptors", async () => {
  const f = await fixture(), result = await f.run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, plan: { operationId: "preview-cli-proof" } });
});
it("refuses source, byte hash and dirty-checkout changes before credentials", async () => {
  const f = await fixture();
  for (const change of [{ sourceSha: "f".repeat(40) }, { multipartDigest: "f".repeat(64) }]) {
    const result = await f.run("plan", change); expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("operation was not confirmed");
  }
  await writeFile(path.join(f.root, "untracked-adapter.js"), "throw new Error('must not run')");
  expect((await f.run()).status).toBe(1);
});
it("production modes refuse emulator routing before requiring credential FD3", async () => {
  const f = await fixture();
  const marker = path.join(f.root, "credential-import-ran");
  await writeFile(path.join(f.root, "site/scripts/cms-publication-credentials.ts"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'boundary reached'); throw new Error('credential boundary'); export function parseCmsPublicationFirebaseServiceAccount(){}`);
  f.commit();
  expect((await f.run("plan")).status).toBe(0);
  for (const mode of ["apply", "qualify", "receipt"]) {
    const result = await f.run(mode, {}, { FIRESTORE_EMULATOR_HOST: "127.0.0.1:18381" });
    expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("operation was not confirmed");
    expect(existsSync(marker)).toBe(false);
  }
  // Positive control: this dedicated fixture reaches only a throwing local
  // sentinel when emulator routing is absent, before any SDK/credential I/O.
  await f.run("receipt", {}, { FIRESTORE_EMULATOR_HOST: "", FIREBASE_AUTH_EMULATOR_HOST: "", FUNCTIONS_EMULATOR: "" });
  expect(existsSync(marker)).toBe(true);
});

it("binds the real OLD/NEW CLI packet bytes offline and refuses swapped roles, aliases and changed bytes", async () => {
  const f = await fixture();
  await f.run(); // Write the original NEW packet outside the clean checkout.
  const old = await previewProviderFixture({ main: path.join(f.root, "preview-renderer/worker.ts"), pair: pair("old", "a") });
  const multipartPath = f.packet.multipartPath + ".old", oldPath = f.packetPath + ".old", manifestPath = f.packetPath + ".binding";
  directories.push(multipartPath, oldPath, manifestPath);
  await writeFile(multipartPath, old.multipart);
  const oldPacket = { ...f.packet, pair: old.descriptor, config: old.config, image: old.image, multipartPath,
    multipartDigest: createHash("sha256").update(old.multipart).digest("hex"), resourceOperationId: "preview-old-proof",
    request: { ...f.packet.request, operationId: "preview-old-proof", candidate: { ...f.packet.request.candidate,
      sourceSha: old.descriptor.rendererSha, runId: "99", inputFingerprint: old.prepared.bundleDigest, configurationFingerprint: old.prepared.configurationDigest } } };
  const oldBytes = JSON.stringify(oldPacket); await writeFile(oldPath, oldBytes);
  const manifest = { schemaVersion: 1, oldRendererSha: old.descriptor.rendererSha, newRendererSha: f.packet.pair.rendererSha,
    OLD: { packetPath: oldPath, packetDigest: createHash("sha256").update(oldBytes).digest("hex") },
    NEW: { packetPath: f.packetPath, packetDigest: createHash("sha256").update(JSON.stringify(f.packet)).digest("hex") } };
  const run = async (value = manifest) => {
    await writeFile(manifestPath, JSON.stringify(value));
    return spawnSync(process.execPath, ["scripts/bind-private-preview-packets.mjs", "plan", manifestPath],
      { cwd: f.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  const result = await run(); expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ productionAuthority: false, binding: {
    OLD: { resourceOperationId: "preview-old-proof" }, NEW: { resourceOperationId: "preview-cli-proof" } } });
  for (const changed of [{ ...manifest, OLD: manifest.NEW, NEW: manifest.OLD }, { ...manifest, OLD: manifest.NEW },
    { ...manifest, NEW: { ...manifest.NEW, packetDigest: "f".repeat(64) } }, { ...manifest, unexpected: "synthetic-private-value" }]) {
    const refused = await run(changed); expect(refused.status).toBe(1); expect(refused.stdout).toBe("");
    expect(refused.stderr).toBe("Private preview packet binding refused\n");
  }
  const marker = path.join(f.root, "unreviewed-binding-import-ran"), helper = path.join(f.root, "scripts/lib/private-preview-packet.mjs");
  await writeFile(helper, `import {writeFileSync as sentinel} from 'node:fs'; sentinel(${JSON.stringify(marker)}, 'must not run');\n` + await readFile(helper, "utf8"));
  const dirty = await run(); expect(dirty.status).toBe(1); expect(dirty.stdout).toBe(""); expect(existsSync(marker)).toBe(false);
});

it("refuses dirty tracked helper code before repository imports in every mode", async () => {
  const f = await fixture(), marker = path.join(f.root, "unreviewed-import-ran");
  const helper = path.join(f.root, "scripts/lib/private-preview-pair-provider.mjs");
  await writeFile(helper, `import {writeFileSync as sentinel} from 'node:fs'; sentinel(${JSON.stringify(marker)}, 'must not run');\n` + await readFile(helper, "utf8"));
  for (const mode of ["plan", "apply", "qualify", "receipt"]) {
    const result = await f.run(mode);
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toContain("operation was not confirmed"); expect(existsSync(marker)).toBe(false);
  }
});
