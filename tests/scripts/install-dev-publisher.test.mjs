import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SECRETS, WAIT, assertImageRun, collectVariables, deployCommand, install, parseArguments, target } from "../../scripts/install-dev-publisher.mjs";
import { targetSource } from "../../.github/scripts/publisher-image.mjs";
import { developmentInputs } from "../../scripts/render-development-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = "a".repeat(40), run = "123", account = "b".repeat(32);
const image = `registry.cloudflare.com/${account}/njpbs-dev-cms-publisher@sha256:${"c".repeat(64)}`;
const oldImage = `registry.cloudflare.com/${account}/njpbs-dev-cms-publisher@sha256:${"d".repeat(64)}`;
const fingerprint = "e".repeat(64);
const source = targetSource(JSON.parse(readFileSync(path.join(root, "publisher/wrangler.json"), "utf8")), target);
const publicVars = { ...Object.fromEntries(Object.keys(source.vars).filter(k => k !== "CMS_DEV_CLOUDFLARE_ACCOUNT_ID").map(k => [k, "x"])),
  CLOUDFLARE_ACCOUNT_ID: account, CMS_DEPLOYMENT_ENVIRONMENT: "development", PUBLICATION_ENABLED: "true",
  PUBLICATION_SERIALIZER_ID: "cloudflare-dev-publisher", PUBLICATION_COMMIT_SHA: "" };
const imageRun = { repository: { full_name: "CenterCoopMedia/njpbs" }, path: ".github/workflows/publisher-image.yml", head_branch: "main",
  event: "workflow_dispatch", status: "completed", conclusion: "success", display_title: `Publisher image development ${sha}`, run_attempt: 2 };
const receipt = { schema: 1, target: "development", source_sha: sha, image, workflow_run_id: run, deployment_input_sha256: fingerprint };
const aligned = { runtime: { phase: "ready", commitSha: sha, cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } },
  pointer: { state: "idle", activeCommitSha: sha } };
const secrets = SECRETS.map(name => ({ type: "secret_text", name }));

function prepared() {
  const directory = mkdtempSync(path.join(tmpdir(), "install-dev-publisher-test-"));
  const config = structuredClone(source);
  config.account_id = account;
  config.vars = { ...config.vars, CLOUDFLARE_ACCOUNT_ID: account, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account, PUBLICATION_COMMIT_SHA: sha };
  config.main = path.join(directory, "source/publisher/worker.ts");
  config.containers[0].image = path.join(directory, "source/publisher/Dockerfile");
  config.containers[0].image_build_context = directory;
  const configPath = path.join(directory, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { commitSha: sha, directory, source: path.join(directory, "source"), configPath, wrangler: path.join(directory, "wrangler.js") };
}

// A fake provider: the deploy moves the Worker to a new version at the commit and starts a rollout.
function harness({ live = oldImage, state = aligned, rollouts = ["progressing", "completed"], health = [503, 200], overrides = {} } = {}) {
  const calls = [], tokens = [];
  let deployedAt = live === image ? 0 : undefined, reads = 0, prep;
  const provider = { version: "v-old", commit: live === image ? sha : "f".repeat(40), image: live, secrets };
  const io = {
    assertSource: () => calls.push("source"),
    github: async route => (calls.push(route), imageRun),
    variables: async environment => environment ? { PUBLISHER_DEVELOPMENT_PUBLIC_VARS_JSON: JSON.stringify(publicVars) }
      : { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account, ...Object.fromEntries(Object.keys(developmentInputs).map(k => [k, "v"])) },
    receipt: async (id, name) => (calls.push(`receipt ${id} ${name}`), structuredClone(receipt)),
    prepare: () => ({ prepared: (prep = prepared()), inputFingerprint: fingerprint }),
    sourceConfig: () => structuredClone(source),
    credential: fd => (tokens.push(fd), "{}"),
    token: fd => (tokens.push(fd), `token-${fd}-${"z".repeat(20)}`),
    firestore: async () => (calls.push("firestore"), state),
    cloudflare: async (_account, route) => {
      if (route.endsWith("/settings")) return { bindings: [...provider.secrets, { type: "plain_text", name: "PUBLICATION_COMMIT_SHA", text: provider.commit }] };
      if (route.endsWith("/deployments")) return { deployments: [{ versions: [{ version_id: provider.version, percentage: 100 }] }] };
      if (route.endsWith("/rollouts")) {
        if (deployedAt === undefined) return [];
        const status = rollouts[Math.min(reads++, rollouts.length - 1)];
        return [{ id: "r-1", created_at: "2026-11-24T00:00:00Z", status, target_configuration: { image } }];
      }
      return { name: "njpbs-dev-cms-publisher", configuration: { image: provider.image } };
    },
    health: async () => health.length > 1 ? health.shift() : health[0],
    deploy: (command, cwd) => {
      calls.push({ command, cwd, config: JSON.parse(readFileSync(command.args[6], "utf8")), keep: readFileSync(command.args[10], "utf8") });
      Object.assign(provider, { version: "v-new", commit: sha, image });
      deployedAt = 0;
    },
    sleep: async () => {},
    ...overrides,
  };
  return { io, calls, tokens, provider, directory: () => prep?.directory };
}

test("arguments name only a commit, an image run and the check flag", () => {
  assert.deepEqual(parseArguments(["--sha", sha, "--image-run", run]), { sha, run, check: false });
  assert.deepEqual(parseArguments(["--sha", sha, "--image-run", run, "--check"]), { sha, run, check: true });
  for (const args of [[], ["--sha", sha], ["--sha", sha, "--image-run", run, "--target", "production"], ["--sha", "abc", "--image-run", run],
    ["--sha", sha, "--image-run", "0"], ["--image-run", run, "--sha", sha]]) assert.throws(() => parseArguments(args), /Usage/);
});

test("the image run must be the successful development publisher-image run for the commit", () => {
  assert.equal(assertImageRun(imageRun, sha), `publisher-image-development-${sha}-2`);
  for (const change of [{ display_title: "Publisher image" }, { conclusion: "failure" }, { head_branch: "feature" },
    { path: ".github/workflows/other.yml" }, { repository: { full_name: "someone/njpbs" } }, { display_title: `Publisher image development ${"b".repeat(40)}` }]) {
    assert.throws(() => assertImageRun({ ...imageRun, ...change }, sha), /not a successful development/);
  }
});

test("variable listing pages to the reported total", () => {
  const all = Array.from({ length: 45 }, (_, i) => ({ name: `V${i}`, value: String(i) }));
  const pages = n => ({ total_count: all.length, variables: all.slice((n - 1) * 30, n * 30) });
  assert.equal(Object.keys(collectVariables(pages)).length, 45);
  assert.throws(() => collectVariables(n => ({ total_count: 46, variables: all.slice((n - 1) * 30, n * 30) })), /incomplete/);
});

test("the deploy names the development Worker, forces one rollout step and keeps every secret", () => {
  const { args, env } = deployCommand({ wrangler: "/w.js", config: "/c.json", secretsFile: "/k.json", sha, token: "t".repeat(40), account });
  assert.deepEqual(args, ["--no-warnings", "/w.js", "deploy", "--name", "njpbs-dev-cms-publisher", "--config", "/c.json",
    "--containers-rollout", "immediate", "--secrets-file", "/k.json", "--message", `install-dev-publisher ${sha}`]);
  assert.deepEqual(Object.keys(env).sort(), ["CI", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_INCLUDE_PROCESS_ENV",
    "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV", "HOME", "PATH", "WRANGLER_SEND_METRICS"]);
});

test("install deploys the receipt image at the commit and reads back version, rollout and health", async () => {
  const h = harness();
  const result = await install({ sha, run, check: false }, h.io);
  assert.deepEqual(result, { schema: 1, target: "development", worker: "njpbs-dev-cms-publisher", source_sha: sha, image,
    previous_version: "v-old", version: "v-new", rollout: "r-1", health: 200, deployed: true });
  const deploy = h.calls.find(call => call.command);
  assert.equal(deploy.keep, "{}\n");
  assert.equal(deploy.config.name, "njpbs-dev-cms-publisher");
  assert.equal(deploy.config.containers[0].image, image);
  assert.equal(deploy.config.vars.PUBLICATION_COMMIT_SHA, sha);
  assert.equal(deploy.config.main, path.join(deploy.cwd, "publisher/worker.ts"));
  assert.deepEqual(h.tokens, [3, 5, 4]);
  assert.equal(existsSync(h.directory()), false);
});

test("check reads everything and never opens the deploy token", async () => {
  const h = harness();
  const result = await install({ sha, run, check: true }, h.io);
  assert.equal(result.deploy_needed, true);
  assert.deepEqual(h.tokens, [3, 5]);
  assert.equal(h.calls.some(call => call.command), false);
});

test("a misaligned runtime or pointer refuses before any Cloudflare credential", async () => {
  for (const state of [{ ...aligned, pointer: { state: "idle", activeCommitSha: "f".repeat(40) } },
    { ...aligned, pointer: { state: "reserved", activeCommitSha: sha } },
    { ...aligned, runtime: { ...aligned.runtime, cloud: { ...aligned.runtime.cloud, commitSha: "f".repeat(40) } } }]) {
    const h = harness({ state });
    await assert.rejects(install({ sha, run, check: false }, h.io), /do not all name this commit/);
    assert.deepEqual(h.tokens, [3]);
  }
});

test("a receipt for production, another commit or other inputs refuses before Firestore", async () => {
  for (const [change, message] of [[{ target: "production" }, /receipt refused/], [{ source_sha: "f".repeat(40) }, /receipt refused/],
    [{ image: image.replace("njpbs-dev-cms-publisher", "njpbs-cms-publisher") }, /receipt refused/],
    [{ deployment_input_sha256: "0".repeat(64) }, /inputs differ/]]) {
    const h = harness({ overrides: { receipt: async () => ({ ...receipt, ...change }) } });
    await assert.rejects(install({ sha, run, check: false }, h.io), message);
    assert.equal(h.calls.includes("firestore"), false);
  }
});

test("variables naming production refuse", async () => {
  const h = harness({ overrides: { variables: async environment => environment
    ? { PUBLISHER_DEVELOPMENT_PUBLIC_VARS_JSON: JSON.stringify({ ...publicVars, CMS_DEPLOYMENT_ENVIRONMENT: "production" }) } : {} } });
  await assert.rejects(install({ sha, run, check: false }, h.io), /do not name the development target/);
});

test("an image already live takes no deploy and still reads back", async () => {
  const h = harness({ live: image });
  const result = await install({ sha, run, check: false }, h.io);
  assert.equal(result.deployed, false);
  assert.deepEqual(h.tokens, [3, 5]);
});

test("a failed rollout, a changed secret set or no health refuses", async () => {
  await assert.rejects(install({ sha, run, check: false }, harness({ rollouts: ["failed"] }).io), /rollout failed/);
  const missing = harness();
  missing.provider.secrets = secrets.slice(1);
  await assert.rejects(install({ sha, run, check: false }, missing.io), /secret names differ/);
  const dropped = harness();
  const deploy = dropped.io.deploy;
  dropped.io.deploy = (...args) => { deploy(...args); dropped.provider.secrets = secrets.slice(1); };
  await assert.rejects(install({ sha, run, check: false }, dropped.io), /secret names changed/);
  await assert.rejects(install({ sha, run, check: false }, harness({ health: [503] }).io), /readback did not complete/);
  assert.equal(WAIT.attempts * WAIT.intervalMs, 900_000);
});

