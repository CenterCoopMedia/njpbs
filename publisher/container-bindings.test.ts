import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";

const repository = fileURLToPath(new URL("..", import.meta.url));
const account = "b".repeat(32);
const workerTag = "d".repeat(32);
const origin = "https://uploads.example.test";
let fixture: string;
let commit: string;
const preparedDirectories: string[] = [];

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "container-bindings-test-"));
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", fixture, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  for (const directory of ["preview-renderer", "publisher"]) {
    await mkdir(path.join(fixture, directory));
    await writeFile(path.join(fixture, directory, "package.json"), '{"name":"container-fixture","version":"1.0.0","private":true}\n');
    await writeFile(path.join(fixture, directory, "package-lock.json"), JSON.stringify({ name: "container-fixture", version: "1.0.0", lockfileVersion: 3,
      packages: { "": { name: "container-fixture", version: "1.0.0" } } }));
    for (const name of directory === "publisher" ? ["wrangler.json"] : ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
      await writeFile(path.join(fixture, directory, name), await readFile(path.join(repository, directory, name)));
    }
  }
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "commit", "--quiet", "-m", "Add container fixtures");
  commit = git("rev-parse", "HEAD").trim();
});

afterAll(async () => {
  await Promise.all([fixture, ...preparedDirectories].filter(Boolean).map(directory => rm(directory, { recursive: true, force: true })));
});

function prepare(module: string, method: string, settings: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { ${method} as prepare } from ${JSON.stringify(new URL(module, import.meta.url).href)};
    import { readFile } from "node:fs/promises";
    const result = await prepare(${JSON.stringify(commit)}, { sourceRepository: ${JSON.stringify(fixture)} });
    const config = JSON.parse(await readFile(result.configPath, "utf8"));
    process.stdout.write(JSON.stringify({ directory: result.directory, config }));
  `], { cwd: repository, encoding: "utf8", timeout: 5_000,
    env: { PATH: process.env.PATH, HOME: fixture, WRANGLER_SEND_METRICS: "false", ...settings } });
}

for (const method of ["preparePreviewRenderer", "prepareDevPreviewRenderer", "prepareCloudPublisher"]) {
  test(`${method} writes the deploy account into the runtime binding across a process boundary`, () => {
    const result = prepare(method === "prepareCloudPublisher" ? "../scripts/prepare-cloud-publisher.mjs" : "../scripts/prepare-preview-renderer.mjs", method,
      { CLOUDFLARE_ACCOUNT_ID: account, CMS_DEV_ACCESS_ORIGIN: "https://access.example.test", PUBLIC_SHARE_UPLOAD_ORIGIN: origin, CLOUDFLARE_PUBLIC_WORKER_TAG: workerTag });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const { directory, config } = JSON.parse(result.stdout);
    preparedDirectories.push(directory);
    assert.equal(config.account_id, account);
    assert.equal(config.vars.CLOUDFLARE_ACCOUNT_ID, account);
    if (method === "prepareCloudPublisher") {
      assert.equal(config.vars.PUBLIC_SHARE_UPLOAD_ORIGIN, origin);
      assert.equal(config.vars.CLOUDFLARE_PUBLIC_WORKER_TAG, workerTag);
    }
    if (method === "prepareDevPreviewRenderer") assert.equal(config.vars.CMS_DEV_ACCESS_ORIGIN, "https://access.example.test");
  });
}

test("image-only publisher preparation needs no account in a scrubbed process", () => {
  const result = prepare("../scripts/prepare-cloud-publisher.mjs", "prepareCloudPublisher");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { directory, config } = JSON.parse(result.stdout);
  preparedDirectories.push(directory);
  assert.equal(config.account_id, undefined);
  assert.equal(config.vars.CLOUDFLARE_ACCOUNT_ID, "");
  assert.equal(config.vars.CLOUDFLARE_PUBLIC_WORKER_TAG, "");
  assert.equal(config.vars.PUBLIC_SHARE_UPLOAD_ORIGIN, "");
});

test("publisher preparation refuses an invalid supplied account", () => {
  const result = prepare("../scripts/prepare-cloud-publisher.mjs", "prepareCloudPublisher", { CLOUDFLARE_ACCOUNT_ID: "invalid-account" });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID must be configured/);
});


test.each(["http://uploads.example.test", "https://uploads.example.test/",
  "https://uploads.example.test/path", "not a URL"])("publisher preparation refuses an invalid upload origin (%s)", origin => {
  const result = prepare("../scripts/prepare-cloud-publisher.mjs", "prepareCloudPublisher", { PUBLIC_SHARE_UPLOAD_ORIGIN: origin });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_SHARE_UPLOAD_ORIGIN must be an exact HTTPS origin/);
});

test.each(["invalid-tag", "d".repeat(31), `${"d".repeat(32)}\n`])("publisher preparation refuses a malformed supplied Worker tag (%s)", tag => {
  const settings: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: account };
  if (tag !== undefined) settings.CLOUDFLARE_PUBLIC_WORKER_TAG = tag;
  const result = prepare("../scripts/prepare-cloud-publisher.mjs", "prepareCloudPublisher", settings);
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLOUDFLARE_PUBLIC_WORKER_TAG must be configured/);
});

test.each([undefined, ""])("account-configured image preparation does not require an unused Worker tag (%s)", tag => {
  const settings: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: account };
  if (tag !== undefined) settings.CLOUDFLARE_PUBLIC_WORKER_TAG = tag;
  const result = prepare("../scripts/prepare-cloud-publisher.mjs", "prepareCloudPublisher", settings);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { directory, config } = JSON.parse(result.stdout);
  preparedDirectories.push(directory);
  assert.equal(config.account_id, account);
  assert.equal(config.vars.CLOUDFLARE_ACCOUNT_ID, account);
  assert.equal(config.vars.CLOUDFLARE_PUBLIC_WORKER_TAG, "");
});

test.each([undefined, "", "invalid-tag", "d".repeat(31), `${"d".repeat(32)}\n`])("deploy CLI refuses a missing or malformed Worker tag before producing a config (%s)", tag => {
  const settings: Record<string, string> = { PATH: process.env.PATH!, HOME: fixture,
    WRANGLER_SEND_METRICS: "false", CLOUDFLARE_ACCOUNT_ID: account };
  if (tag !== undefined) settings.CLOUDFLARE_PUBLIC_WORKER_TAG = tag;
  const result = spawnSync(process.execPath, [path.join(repository, "scripts/prepare-cloud-publisher.mjs"), commit],
    { cwd: repository, encoding: "utf8", timeout: 5_000, env: settings });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLOUDFLARE_PUBLIC_WORKER_TAG must be configured/);
  assert.equal(result.stdout, "");
});
