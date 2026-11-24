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
// The public variables the rendered config carries; the fake Worker serves them once deployed.
const renderedVars = { ...source.vars, ...publicVars, CLOUDFLARE_ACCOUNT_ID: account, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account, PUBLICATION_COMMIT_SHA: sha };
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

// A rollout from version 1 at `current` to version 2 at the receipt image, applied to its one instance.
const rollout = (id, created_at, { current = oldImage, status = "completed", applied = true } = {}) => ({
  id, created_at, status, current_version: 1, target_version: 2, current_configuration: { image: current }, target_configuration: { image },
  progress: { total_instances: 1, version_distribution: { target_version_percentage: applied ? 100 : 0, current_version_instances: applied ? 0 : 1, target_version_instances: applied ? 1 : 0 } },
});
const identity = { repository: "CenterCoopMedia/njpbs", id: "42" };
const applicationId = "0123abcd-0000-4000-8000-000000000000";

// A fake provider: the deploy moves the Worker to a new version at the commit and, when
// the image changes, starts one rollout whose statuses follow `rollouts`.
function harness({ live = oldImage, liveCommit = "f".repeat(40), history = [], lag = false, state = aligned,
  rollouts = ["pending", "progressing", "completed"], health = [503, 200], applications, overrides = {} } = {}) {
  const calls = [], tokens = [];
  let reads = 0, prep;
  const provider = { version: "v-old", commit: liveCommit, record: live, appVersion: 1, secrets, rollouts: history, drift: {}, bucket: "njpbs-dev-cms-publication" };
  const io = {
    identity: () => identity,
    assertSource: () => calls.push("source"),
    github: async route => (calls.push(route), { ...imageRun, repository: { full_name: "CenterCoopMedia/njpbs", id: 42 } }),
    variables: async (_repository, environment) => environment ? { PUBLISHER_DEVELOPMENT_PUBLIC_VARS_JSON: JSON.stringify(publicVars) }
      : { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account, ...Object.fromEntries(Object.keys(developmentInputs).map(k => [k, "v"])) },
    receipt: async (_repository, id, name) => (calls.push(`receipt ${id} ${name}`), structuredClone(receipt)),
    prepare: () => ({ prepared: (prep = prepared()), inputFingerprint: fingerprint }),
    sourceConfig: () => structuredClone(source),
    credential: fd => (tokens.push(fd), "{}"),
    token: fd => (tokens.push(fd), `token-${fd}-${"z".repeat(20)}`),
    firestore: async () => (calls.push("firestore"), state),
    cloudflare: async (_account, route) => {
      if (route.endsWith("/settings")) return { bindings: [...provider.secrets,
        ...Object.entries({ ...renderedVars, ...provider.drift, PUBLICATION_COMMIT_SHA: provider.commit }).map(([name, text]) => ({ type: "plain_text", name, text })),
        { type: "durable_object_namespace", name: "PUBLISHER", class_name: "PublicationRuntime", namespace_id: "ns-dev" },
        { type: "r2_bucket", name: "DURABLE_POST_WITHDRAWALS", bucket_name: provider.bucket }] };
      if (route.endsWith("/deployments")) return { deployments: [{ versions: [{ version_id: provider.version, percentage: 100 }] }] };
      if (route === `containers/applications/${applicationId}/rollouts`) {
        return provider.rollouts.map(r => r.id === "r-new" ? { ...r, status: rollouts[Math.min(reads++, rollouts.length - 1)] } : r);
      }
      if (route === "containers/applications") return applications ?? [{ id: applicationId, name: "njpbs-dev-cms-publisher", version: provider.appVersion,
        active_rollout_id: null, configuration: { image: provider.record }, durable_objects: { namespace_id: "ns-dev" } },
        { id: "ffffffff-0000-4000-8000-000000000000", name: "njpbs-cms-publisher", configuration: { image: "other" } }];
      throw new Error(`unexpected route ${route}`);
    },
    health: async () => health.length > 1 ? health.shift() : health[0],
    deploy: (command, cwd) => {
      calls.push({ command, cwd, config: JSON.parse(readFileSync(command.args[6], "utf8")), keep: readFileSync(command.args[10], "utf8") });
      // An unchanged image starts no rollout; a changed one moves the application from version 1 to 2.
      if (provider.record !== image) {
        provider.rollouts = [...provider.rollouts, rollout("r-new", "2026-11-24T01:00:00Z", { current: provider.record })];
        if (!lag) Object.assign(provider, { record: image, appVersion: 2 });
      }
      Object.assign(provider, { version: "v-new", commit: sha, drift: {}, bucket: "njpbs-dev-cms-publication" });
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
  const ok = { ...imageRun, repository: { full_name: "CenterCoopMedia/njpbs", id: 42 } };
  assert.equal(assertImageRun(ok, sha, identity), `publisher-image-development-${sha}-2`);
  for (const change of [{ display_title: "Publisher image" }, { conclusion: "failure" }, { head_branch: "feature" },
    { path: ".github/workflows/other.yml" }, { repository: { full_name: "someone/njpbs", id: 42 } }, { repository: { full_name: "CenterCoopMedia/njpbs", id: 43 } },
    { display_title: `Publisher image development ${"b".repeat(40)}` }]) {
    assert.throws(() => assertImageRun({ ...ok, ...change }, sha, identity), /not a successful development/);
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
    previous_version: "v-old", version: "v-new", rollout: "r-new", noRollout: false, health: 200, deployed: true });
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
  assert.deepEqual(result.live, { version: "v-old", commit: "f".repeat(40), application: applicationId, image: oldImage });
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

test("emulator or ambient credential settings refuse", () => {
  for (const key of ["FIRESTORE_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    assert.throws(() => parseArguments(["--sha", sha, "--image-run", run], { [key]: "x" }), /emulator/);
  }
});

test("an installed Worker at an applied image takes no deploy and reads back", async () => {
  const history = [{ ...rollout("r-old", "2026-11-24T00:00:00Z"), current_version: 0, target_version: 1 }];
  const h = harness({ live: image, liveCommit: sha, history });
  const result = await install({ sha, run, check: false }, h.io);
  assert.equal(result.deployed, false);
  assert.equal(result.rollout, "r-old");
  assert.deepEqual(h.tokens, [3, 5]);
});

test("a first install at the image with no rollout is installed: noRollout, no deploy", async () => {
  const h = harness({ live: image, liveCommit: sha });
  const result = await install({ sha, run, check: false }, h.io);
  assert.equal(result.deployed, false);
  assert.equal(result.noRollout, true);
  assert.equal(result.rollout, null);
  assert.equal(result.version, "v-old");
  assert.deepEqual(h.tokens, [3, 5]);
});

test("Worker-only drift at the applied image deploys and keeps the earlier state", async () => {
  for (const history of [[], [{ ...rollout("r-old", "2026-11-24T00:00:00Z"), current_version: 0, target_version: 1 }]]) {
    const h = harness({ live: image, liveCommit: "f".repeat(40), history });
    const result = await install({ sha, run, check: false }, h.io);
    assert.equal(result.deployed, true);
    assert.equal(result.noRollout, history.length === 0);
    assert.deepEqual(h.tokens, [3, 5, 4]);
  }
});

test("a public variable drift at the installed commit and image deploys", async () => {
  const history = [{ ...rollout("r-old", "2026-11-24T00:00:00Z"), current_version: 0, target_version: 1 }];
  const h = harness({ live: image, liveCommit: sha, history });
  h.provider.drift = { PUBLICATION_ENABLED: "false" };
  assert.equal((await install({ sha, run, check: true }, harness({ live: image, liveCommit: sha, history }).io)).deploy_needed, false);
  assert.equal((await install({ sha, run, check: true }, h.io)).deploy_needed, true);
  const result = await install({ sha, run, check: false }, h.io);
  assert.equal(result.deployed, true);
});

test("a live withdrawal bucket other than the rendered one deploys", async () => {
  const history = [{ ...rollout("r-old", "2026-11-24T00:00:00Z"), current_version: 0, target_version: 1 }];
  const h = harness({ live: image, liveCommit: sha, history });
  h.provider.bucket = "njpbs-cms-publication";
  assert.equal((await install({ sha, run, check: true }, h.io)).deploy_needed, true);
  assert.equal((await install({ sha, run, check: false }, h.io)).deployed, true);
});

test("an image recorded on the application but not yet applied by its rollout deploys", async () => {
  const pending = [{ ...rollout("r-old", "2026-11-24T00:00:00Z", { status: "progressing", applied: false }) }];
  const h = harness({ live: oldImage, liveCommit: sha, history: pending });
  h.provider.record = image;
  const result = await install({ sha, run, check: true }, h.io);
  assert.equal(result.deploy_needed, true);
});

test("a completed rollout is the applied state while the application record lags", async () => {
  const result = await install({ sha, run, check: false }, harness({ lag: true }).io);
  assert.equal(result.rollout, "r-new");
});

test("a completed rollout that is not applied to every instance keeps waiting", async () => {
  const h = harness();
  const deploy = h.io.deploy;
  h.io.deploy = (...args) => { deploy(...args); h.provider.rollouts = [rollout("r-new", "2026-11-24T01:00:00Z", { applied: false })]; };
  await assert.rejects(install({ sha, run, check: false }, h.io), /readback did not complete/);
});

test("an application bound to another Durable Object namespace refuses", async () => {
  const applications = [{ id: applicationId, name: "njpbs-dev-cms-publisher", configuration: { image: oldImage }, durable_objects: { namespace_id: "ns-other" } }];
  await assert.rejects(install({ sha, run, check: false }, harness({ applications }).io), /not bound to the Worker/);
});

test("a missing or duplicated development application refuses", async () => {
  for (const applications of [[], [{ id: applicationId, name: "njpbs-dev-cms-publisher" }, { id: "ffffffff-0000-4000-8000-000000000000", name: "njpbs-dev-cms-publisher" }]]) {
    await assert.rejects(install({ sha, run, check: false }, harness({ applications }).io), /not unique/);
  }
});

test("a reverted rollout, a changed secret set or no health refuses", async () => {
  await assert.rejects(install({ sha, run, check: false }, harness({ rollouts: ["progressing", "reverted"] }).io), /reverted or replaced/);
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
