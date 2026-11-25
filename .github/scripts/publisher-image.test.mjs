import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { childFailure, productionConfig, publisherTarget, publishImage, receiptFiles, registryReader, targetSource, verifySource } from "./publisher-image.mjs";

const sha = "a".repeat(40), account = "0123456789abcdef0123456789abcdef";
const digest = `sha256:${"b".repeat(64)}`;
const image = `registry.cloudflare.com/${account}/njpbs-cms-publisher@${digest}`;
const inputFingerprint = "d".repeat(64), imageName = "njpbs-cms-publisher";
const env = { CANONICAL_GITHUB_REPOSITORY: "example/source", CANONICAL_GITHUB_REPOSITORY_ID: "123", GITHUB_REPOSITORY: "example/source", GITHUB_REPOSITORY_ID: "123", GITHUB_WORKFLOW_REF: "example/source/.github/workflows/publisher-image.yml@refs/heads/main" };

test("the publisher image workflow pins external actions to full commits", () => {
  const workflow = readFileSync(new URL("../workflows/publisher-image.yml", import.meta.url), "utf8");
  const actions = [...workflow.matchAll(/^ +(?:- )?uses: +([^\s#]+)/gm)]
    .map(([, action]) => action)
    .filter(action => !action.startsWith("./"));
  assert.ok(actions.length > 0, "Expected external publisher image actions");
  for (const action of actions) assert.match(action, /@[0-9a-f]{40}$/);
});

function sourceFixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "publisher-image-test-"));
  t.after(() => rmSync(cwd, { recursive: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.org", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  writeFileSync(path.join(cwd, "source"), "main");
  git("add", "."); git("commit", "-m", "main fixture");
  const main = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", main);
  return { cwd, git, main };
}

function ciRequest(source, { green = true, jobGreen = true } = {}) {
  return async route => route.includes("/jobs?") ? { total_count: 1, jobs: [{ name: "ci", run_id: 42, head_sha: source, status: "completed", conclusion: jobGreen ? "success" : "failure" }] }
    : { workflow_runs: green ? [{ id: 42, head_sha: source, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/ci.yml", repository: { full_name: "example/source", id: 123 }, head_repository: { full_name: "example/source", id: 123 } }] : [] };
}

test("SHA admission refuses malformed and off-main source before CI lookup", async t => {
  const { cwd, git } = sourceFixture(t);
  const request = () => assert.fail("CI must not run for refused source");
  await assert.rejects(verifySource({ sha: "main", cwd, env, request }), /full deploy SHA/);
  git("checkout", "-b", "unmerged");
  writeFileSync(path.join(cwd, "source"), "unmerged"); git("commit", "-am", "unmerged fixture");
  await assert.rejects(verifySource({ sha: git("rev-parse", "HEAD"), cwd, env, request }));
});

test("SHA admission requires successful main source CI and its ci aggregate", async t => {
  const { cwd, main } = sourceFixture(t);
  for (const options of [{ green: false }, { jobGreen: false }]) {
    await assert.rejects(verifySource({ sha: main, cwd, env, request: ciRequest(main, options) }), /No successful main CI/);
  }
  assert.equal(await verifySource({ sha: main, cwd, env, request: ciRequest(main) }), 42);
  await assert.rejects(verifySource({ sha: main, cwd, env: { ...env, GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace("main", "feature") }, request: ciRequest(main) }), /identity refused/);
});

test("a registry read that fails at the provider is asked again, and a missing tag stays an answer", async () => {
  const statuses = [503, 200, 503, 404], asked = [];
  const reader = async url => {
    asked.push(url);
    const status = statuses.shift();
    return status === 200 ? Response.json({ success: true, result: { password: "fixture" } }) : new Response(null, { status });
  };
  const lookup = await registryReader(account, "fixture-token", imageName, reader);
  assert.equal(await lookup(sha), null);
  assert.equal(asked.length, 4);
  let refused = 0;
  await assert.rejects(registryReader(account, "fixture-token", imageName, async () => { refused += 1; return new Response(null, { status: 403 }); }), /credential refused/);
  assert.equal(refused, 1);
});

test("a rerun reuses the SHA digest; a new image builds once and reads back by digest", async () => {
  for (const existing of [true, false]) {
    let builds = 0, lookups = 0;
    const result = await publishImage({ sha, account, imageName, inputFingerprint, lookup: async tag => {
      lookups++;
      assert.ok(tag === sha || tag === digest);
      return !existing && lookups === 1 ? null : { digest, inputFingerprint };
    }, build: async tag => { builds++; assert.equal(tag, `njpbs-cms-publisher:${sha}`); } });
    assert.equal(result, image); assert.equal(builds, existing ? 0 : 1);
  }
  await assert.rejects(publishImage({ sha, account, imageName, inputFingerprint, lookup: async () => { throw new Error("403"); }, build: () => assert.fail("Lookup failure must not push") }), /403/);
  let calls = 0;
  await assert.rejects(publishImage({ sha, account, imageName, inputFingerprint, lookup: async () => ++calls === 1 ? { digest, inputFingerprint } : null, build: () => assert.fail() }), /readback differs/);
  for (const previousInputs of [undefined, "e".repeat(64)]) {
    await assert.rejects(publishImage({ sha, account, imageName, inputFingerprint, lookup: async () => ({ digest, inputFingerprint: previousInputs }), build: () => assert.fail("Changed inputs must not replace the existing SHA image") }), /different deployment inputs/);
  }
});

test("a failed build reads the registry before failing and never prints child output", async () => {
  let lookups = 0;
  const pushed = await publishImage({ sha, account, imageName, inputFingerprint,
    lookup: async () => ++lookups === 1 ? null : { digest, inputFingerprint }, build: async () => { throw new Error("exit 1 after push"); } });
  assert.equal(pushed, image);
  await assert.rejects(publishImage({ sha, account, imageName, inputFingerprint, lookup: async () => null,
    build: async () => { throw new Error("exit 1"); } }), /exit 1/);
  assert.equal(childFailure({ status: 1, signal: null, stdout: "synthetic-out",
    stderr: "A request failed. Authentication error [code: 10000] token synthetic-private" }),
  "Publisher image command failed (exit 1, code 10000); child output withheld");
  assert.equal(childFailure({ status: null, signal: "SIGKILL", stderr: "synthetic-private" }),
    "Publisher image command failed (exit unknown, signal SIGKILL); child output withheld");
  assert.equal(childFailure({ code: "ENOENT", message: "synthetic-private" }),
    "Publisher image command failed (exit unknown, code ENOENT); child output withheld");
});

test("registry lookup verifies manifest bytes and treats only 404 as absent", async () => {
  const config = Buffer.from(JSON.stringify({ config: { Labels: { "org.njpbs.deployment-input-sha256": inputFingerprint } } }));
  const configDigest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } }));
  const manifestDigest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  let status = 200, header = manifestDigest, redirect = false, corrupt = false;
  const lookup = await registryReader(account, "synthetic-api-token", imageName, async (url, options) => {
    if (options.method === "POST") {
      assert.match(url, /\/containers\/registries\/registry\.cloudflare\.com\/credentials$/);
      assert.deepEqual(JSON.parse(options.body).permissions, ["pull"]);
      return Response.json({ success: true, result: { password: "synthetic-registry-token" } });
    }
    assert.equal(options.method, "GET");
    if (url === "https://storage.example.org/image-config") {
      assert.equal(options.headers?.Authorization, undefined);
      return new Response(config);
    }
    if (url.includes("/blobs/")) return redirect ? new Response(null, { status: 307, headers: { Location: "https://storage.example.org/image-config" } }) : new Response(corrupt ? "changed" : config);
    assert.match(url, /\/manifests\//);
    return new Response(manifest, { status, headers: { "Docker-Content-Digest": header } });
  });
  assert.deepEqual(await lookup(sha), { digest: manifestDigest, inputFingerprint });
  redirect = true; assert.deepEqual(await lookup(sha), { digest: manifestDigest, inputFingerprint });
  redirect = false; corrupt = true; await assert.rejects(lookup(sha), /config digest differs/); corrupt = false;
  status = 404; assert.equal(await lookup(sha), null);
  status = 403; await assert.rejects(lookup(sha), /lookup refused/);
  status = 200; header = digest; await assert.rejects(lookup(sha), /digest differs/);
});

test("receipt config matches release method 3372638c source/config comparison", () => {
  const source = JSON.parse(readFileSync(new URL("../../publisher/wrangler.json", import.meta.url), "utf8"));
  const checkout = "/tmp/example-source";
  const variables = { ...source.vars, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_PUBLIC_WORKER_TAG: "c".repeat(32), PUBLICATION_ENABLED: "true", CMS_MEDIA_R2_ENDPOINT: "https://media.example.org", PUBLIC_GA4_MEASUREMENT_ID: "G-EXAMPLE", PUBLIC_REPORT_ENDPOINT: "https://report.example.org", PUBLIC_TURNSTILE_SITEKEY: "example-key" };
  const prepared = structuredClone(source);
  prepared.main = "/tmp/prepared/source/publisher/worker.ts";
  prepared.account_id = account;
  prepared.containers[0].image = "/tmp/prepared/source/publisher/Dockerfile";
  prepared.containers[0].image_build_context = "/tmp/prepared";
  const config = productionConfig(source, prepared, { checkout, sha, image, variables });
  // Independently apply the method's documented substitutions to exact source.
  const expected = structuredClone(source);
  expected.main = path.join(checkout, "publisher/worker.ts");
  expected.account_id = account;
  expected.vars = { ...variables, PUBLICATION_COMMIT_SHA: sha };
  expected.containers[0].image = image;
  delete expected.containers[0].image_build_context;
  assert.deepEqual(config, expected);
  const files = receiptFiles({ sha, image, config, checkout, runId: "987654321", inputFingerprint });
  const receipt = JSON.parse(files["receipt.json"]);
  assert.deepEqual(receipt, { schema: 1, source_sha: sha, image, config: "publisher.json", config_sha256: createHash("sha256").update(files["publisher.json"]).digest("hex"), workflow_run_id: "987654321", source_checkout: checkout, deployment_input_sha256: inputFingerprint });
  assert.deepEqual(JSON.parse(files[receipt.config]), expected);
  const changed = structuredClone(prepared); changed.containers[0].max_instances = 2;
  assert.throws(() => productionConfig(source, changed, { checkout, sha, image, variables }), /differs from exact source/);
  assert.throws(() => productionConfig({ ...source, main: "other.ts" }, prepared, { checkout, sha, image, variables }), /contract refused/);
  assert.throws(() => productionConfig(source, prepared, { checkout, sha, image: image.replace(/@.*/, ":main"), variables }), /contract refused/);
});

test("a development image uses the same source with only the development names", () => {
  const source = JSON.parse(readFileSync(new URL("../../publisher/wrangler.json", import.meta.url), "utf8"));
  const target = publisherTarget("development"), checkout = "/tmp/example-source";
  assert.equal(targetSource(source, publisherTarget("production")), source);
  const dev = targetSource(source, target);
  assert.equal(dev.name, "njpbs-dev-cms-publisher");
  assert.equal(dev.containers[0].name, "njpbs-dev-cms-publisher");
  assert.deepEqual(dev.r2_buckets, [{ binding: "DURABLE_POST_WITHDRAWALS", bucket_name: "njpbs-dev-cms-publication" }]);
  assert.deepEqual(dev.routes, [{ pattern: "dev-publisher-health.njpbs.org", custom_domain: true }]);
  // Everything else, including the container shape and schedule, is the production source.
  // Development also declares the account pin its container checks; production never has it.
  assert.equal(dev.vars.CMS_DEV_CLOUDFLARE_ACCOUNT_ID, "");
  assert.equal("CMS_DEV_CLOUDFLARE_ACCOUNT_ID" in source.vars, false);
  const strip = config => { const copy = structuredClone(config); for (const key of ["name", "r2_buckets", "routes"]) delete copy[key]; delete copy.containers[0].name; delete copy.vars.CMS_DEV_CLOUDFLARE_ACCOUNT_ID; return copy; };
  assert.deepEqual(strip(dev), strip(source));
  const variables = { ...source.vars, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_PUBLIC_WORKER_TAG: "c".repeat(32), PUBLICATION_ENABLED: "true",
    CMS_DEPLOYMENT_ENVIRONMENT: "development", PUBLICATION_SERIALIZER_ID: "cloudflare-dev-publisher", CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account };
  const devImage = `registry.cloudflare.com/${account}/njpbs-dev-cms-publisher@${digest}`;
  const prepared = structuredClone(dev);
  prepared.main = "/tmp/prepared/source/publisher/worker.ts";
  prepared.containers[0].image_build_context = "/tmp/prepared";
  const config = productionConfig(dev, prepared, { checkout, sha, image: devImage, variables, target });
  assert.equal(config.name, "njpbs-dev-cms-publisher");
  assert.equal(config.vars.CMS_DEPLOYMENT_ENVIRONMENT, "development");
  // The Worker variables are the container's source: a development Worker carries the pin.
  assert.equal(config.vars.CMS_DEV_CLOUDFLARE_ACCOUNT_ID, account);
  const unpinned = { ...variables }; delete unpinned.CMS_DEV_CLOUDFLARE_ACCOUNT_ID;
  for (const pinned of [unpinned, { ...variables, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "" }, { ...variables, CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "e".repeat(32) }]) {
    assert.throws(() => productionConfig(dev, prepared, { checkout, sha, image: devImage, variables: pinned, target }), /contract refused/);
  }
  // A development config refuses the production image name and production variables.
  assert.throws(() => productionConfig(dev, prepared, { checkout, sha, image, variables, target }), /contract refused/);
  for (const [name, value] of [["CMS_DEPLOYMENT_ENVIRONMENT", "production"], ["PUBLICATION_SERIALIZER_ID", "cloudflare-publisher"]]) {
    assert.throws(() => productionConfig(dev, prepared, { checkout, sha, image: devImage, variables: { ...variables, [name]: value }, target }), /contract refused/);
  }
  // Production refuses development variables in the production image.
  const prodPrepared = structuredClone(source);
  prodPrepared.containers[0].image_build_context = "/tmp/prepared";
  assert.throws(() => productionConfig(source, prodPrepared, { checkout, sha, image, variables: { ...variables, PUBLICATION_SERIALIZER_ID: "cloudflare-publisher" } }), /contract refused/);
  assert.throws(() => productionConfig(source, prodPrepared, { checkout, sha, image, variables: { ...unpinned, CMS_DEPLOYMENT_ENVIRONMENT: "production", PUBLICATION_SERIALIZER_ID: "cloudflare-publisher", CMS_DEV_CLOUDFLARE_ACCOUNT_ID: account } }), /contract refused/);
  // The development artifact carries no deployable config.
  const files = receiptFiles({ sha, image: devImage, config, checkout, runId: "1", inputFingerprint, target });
  assert.deepEqual(Object.keys(files), ["receipt.json"]);
  assert.deepEqual(JSON.parse(files["receipt.json"]), { schema: 1, target: "development", source_sha: sha, image: devImage, workflow_run_id: "1", deployment_input_sha256: inputFingerprint });
  assert.throws(() => publisherTarget("staging"), /production or development/);
  assert.throws(() => publisherTarget(undefined), /production or development/);
});
