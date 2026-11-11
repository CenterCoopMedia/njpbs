import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLockDelta } from "../../scripts/check-lock-delta.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Public #19 updated Firebase CLI while leaving every production package unchanged.
const historical = "9944eb3b0f2355c1474c6c740360bf7c649505b3";
const sdkUpdate = "42fd0fbe79f7c36c56308b8efe52f9fac79934ab";
let cwd;
const git = (args, input, directory = cwd) => execFileSync("git", args, { cwd: directory, input, encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }, stdio: ["pipe", "pipe", "pipe"] }).trim();
const source = (sha, path) => git(["show", `${sha}:${path}`]);
function replace(path, bytes, parent = historical) {
  git(["read-tree", parent]);
  const blob = git(["hash-object", "-w", "--stdin"], bytes);
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
  return git(["commit-tree", git(["write-tree"]), "-p", parent], "lockfile contract fixture\n");
}
function changed(path, mutate) {
  const value = JSON.parse(source(historical, path));
  mutate(value);
  return replace(path, JSON.stringify(value));
}
before(() => {
  cwd = mkdtempSync(join(tmpdir(), "lock-delta-"));
  git(["init", "--bare", "-q"]);
  const common = git(["rev-parse", "--git-common-dir"], undefined, root);
  mkdirSync(join(cwd, "objects/info"), { recursive: true });
  writeFileSync(join(cwd, "objects/info/alternates"), `${resolve(root, common, "objects")}\n`);
});
after(() => rmSync(cwd, { recursive: true, force: true }));

test("real historical lockfile pair records dev-only changes and exact raw digests", () => {
  const record = checkLockDelta(`${historical}^`, historical, { cwd });
  assert.equal(record.changed, true);
  assert.equal(record.lockfiles.length, 5);
  const rootLock = record.lockfiles.find(lock => lock.path === "package-lock.json");
  const cli = rootLock.packages.find(change => change.path === "node_modules/firebase-tools");
  assert.equal(cli.old.version, "15.26.0");
  assert.equal(cli.new.version, "15.31.0");
  assert.equal(cli.new.role, "dev");
  assert(record.lockfiles.every(lock => lock.production.length === 0));
  const bytes = git(["show", `${historical}:package-lock.json`]) + "\n";
  assert.equal(rootLock.newSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(checkLockDelta(`${historical}^`, historical, { cwd }), record);
});

test("equal historical locks report no dependency change and accept real workspace links", () => {
  const record = checkLockDelta(historical, historical, { cwd });
  assert.equal(record.changed, false);
  assert(record.lockfiles.every(lock => lock.oldSha256 === lock.newSha256 && !lock.packages.length && !lock.production.length));
});

test("a separate preview-worker lock change using public SDK history cannot claim dependency equality", () => {
  const path = "preview-renderer/package-lock.json";
  const fixture = JSON.parse(source(historical, path));
  // Reuse the exact registry entries from public #24 in an isolated preview lock.
  fixture.packages["node_modules/firebase-admin"] = JSON.parse(source(historical, "site/package-lock.json"))
    .packages["node_modules/firebase-admin"];
  const old = replace(path, JSON.stringify(fixture));
  fixture.packages["node_modules/firebase-admin"] = JSON.parse(source(sdkUpdate, "site/package-lock.json"))
    .packages["node_modules/firebase-admin"];
  const sha = replace(path, JSON.stringify(fixture), old);
  const record = checkLockDelta(old, sha, { cwd });
  assert.equal(record.changed, true);
  assert.deepEqual(record.lockfiles.filter(lock => lock.oldSha256 !== lock.newSha256).map(lock => lock.path), [path]);
  const preview = record.lockfiles.find(lock => lock.path === path);
  const sdk = preview.packages.find(change => change.path === "node_modules/firebase-admin");
  assert.equal(sdk.old.version, "14.2.0");
  assert.equal(sdk.new.version, "14.5.0");
  assert.equal(sdk.new.role, "dev");
});

test("the separately deployed preview-worker lock enforces integrity, source and production install-script policy", () => {
  for (const [mutate, error] of [
    [entry => { delete entry.integrity; }, /^preview-renderer\/package-lock.json: package integrity/],
    [entry => { entry.resolved = "https://example.test/pkg.tgz"; }, /^preview-renderer\/package-lock.json: non-registry/],
    [entry => { entry.hasInstallScript = true; }, /^preview-renderer\/package-lock.json: unreviewed production/],
  ]) {
    const sha = changed("preview-renderer/package-lock.json", lock => mutate(lock.packages["node_modules/@aws-sdk/client-s3"]));
    assert.throws(() => checkLockDelta(historical, sha, { cwd }), { message: error });
  }
});

test("moving a real dev package into production records a closure addition even at the same version", () => {
  const sha = changed("site/package-lock.json", lock => { delete lock.packages["node_modules/playwright"].dev; });
  const site = checkLockDelta(historical, sha, { cwd }).lockfiles.find(lock => lock.path === "site/package-lock.json");
  assert.equal(site.packages[0].old.role, "dev");
  assert.equal(site.packages[0].new.role, "prod");
  assert.equal(site.production[0].old, null);
  assert.equal(site.production[0].new.version, "1.61.1");
});

for (const [name, mutate, error] of [
  ["missing integrity", entry => { delete entry.integrity; }, /integrity/],
  ["foreign registry", entry => { entry.resolved = "https://example.test/pkg.tgz"; }, /source/],
  ["registry lookalike", entry => { entry.resolved = "https://registry.npmjs.org.example.test/pkg.tgz"; }, /source/],
  ["git source", entry => { entry.version = "git+https://example.test/pkg.git"; }, /source/],
  ["file source", entry => { entry.resolved = "file:../pkg"; }, /source/],
  ["non-workspace link", entry => { entry.link = true; entry.resolved = "../pkg"; }, /link/],
  ["new production install script", entry => { entry.hasInstallScript = true; }, /unreviewed production install script/],
]) {
  test(`real Functions lock refuses ${name}`, () => {
    const sha = changed("functions/package-lock.json", lock => mutate(lock.packages["node_modules/firebase-functions"]));
    assert.throws(() => checkLockDelta(historical, sha, { cwd }), error);
  });
}

test("same-version integrity changes remain visible in the production delta", () => {
  const sha = changed("functions/package-lock.json", lock => {
    lock.packages["node_modules/firebase-functions"].integrity = `sha512-${"A".repeat(86)}==`;
  });
  const lock = checkLockDelta(historical, sha, { cwd }).lockfiles.find(lock => lock.path === "functions/package-lock.json");
  assert.equal(lock.production.length, 1);
  assert.equal(lock.production[0].old.version, lock.production[0].new.version);
  assert.notEqual(lock.production[0].old.integrity, lock.production[0].new.integrity);
});

test("own install hooks and direct tarball manifest sources are refused", () => {
  for (const [mutate, error] of [
    [pkg => { pkg.scripts.prepare = "node install.js"; }, /lifecycle hook/],
    [pkg => { pkg.dependencies.astro = "https://registry.npmjs.org/astro/-/astro-7.2.0.tgz"; }, /non-registry dependency source/],
  ]) {
    const sha = changed("site/package.json", mutate);
    assert.throws(() => checkLockDelta(historical, sha, { cwd }), error);
  }
});

test("CLI writes a deterministic record whose announced SHA-256 hashes the exact file", () => {
  const output = join(cwd, "delta.json"), summary = join(cwd, "summary.md");
  const stdout = execFileSync(process.execPath, [join(root, "scripts/check-lock-delta.mjs"), `${historical}^`, historical,
    "--output", output, "--summary", summary], { cwd, encoding: "utf8" });
  const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
  assert(stdout.startsWith(`Record SHA-256: ${digest}\n`));
  assert.equal(readFileSync(summary, "utf8"), stdout);
  assert(stdout.includes("15.26.0 (dev) | 15.31.0 (dev)"));
});
