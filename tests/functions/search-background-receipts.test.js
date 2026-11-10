import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import background from "../../functions/lib/post-background-outputs.js";
import manifests from "../../functions/lib/post-background-record-manifest.js";
import context from "../../functions/lib/public-context-revision.js";
import alerts from "../../functions/lib/post-background-alerts.js";
import authority from "../../functions/lib/public-context-background-reader.js";
import deployment from "../../functions/lib/public-deployment-pointer.js";
import namespace from "../../functions/lib/no-build-record-namespace.js";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";

const rendererSha = "a".repeat(40), contextDigest = context.publicContextDigest(1);
const start = Date.parse("2026-11-01T12:00:00Z");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// These manifests contain only string/number fields; canonical key order is
// the background receipt's documented digest representation.
const manifestDigest = files => hash(JSON.stringify(files.map(file => Object.fromEntries(Object.entries(file).sort(([a], [b]) => a.localeCompare(b))))));

async function fixture({ count = 257, inline = false } = {}) {
  const f = fakeFirestore();
  const run = f.firestore.runTransaction.bind(f.firestore);
  f.firestore.runTransaction = work => run(tx => work({ ...tx, getAll: (...refs) => Promise.all(refs.map(ref => tx.get(ref))) }));
  const stored = new Map();
  const artifacts = { async put(key, bytes) { stored.set(key, Buffer.from(bytes)); }, async get(key) { return stored.get(key); } };
  const signal = new AbortController().signal;
  const after = background.dependency(null);
  let time = start;
  const statuses = [];
  const live = { rendererSha, digest: contextDigest, withdrawalRevision: 0 };
  async function receipt(asset = "/_astro/search-old.js") {
    const task = { output: "search", claim: randomUUID() };
    const paths = ["/pagefind/pagefind.js", "/search/meaning-index.json", asset,
      ...Array.from({ length: count - 3 }, (_, i) => `/pagefind/fragment/${i}.pf_fragment`)];
    const files = paths.map(path => {
      const bytes = Buffer.from(`public ${path}`);
      const key = `post-background-v1/search/${task.claim}/${hash(path)}`;
      stored.set(key, bytes);
      return { path, key, digest: hash(bytes), size: bytes.length, contentType: "application/octet-stream" };
    });
    const ref = await manifests.storeRecordManifest({ manifest: files, task, artifacts, signal });
    return { revision: 1, contextDigest, rendererSha, verifiedAt: start, withdrawalRevision: 0,
      digest: manifestDigest(files), manifest: inline ? files.filter(file => !file.path.startsWith("/_astro/")) : [],
      assets: inline ? files.filter(file => file.path.startsWith("/_astro/")) : [], ...(inline ? {} : { fileManifest: ref }) };
  }
  const good = await receipt();
  const state = { schemaVersion: 1, owner: "post-background-v1", output: "search", contextOnly: true,
    revision: 1, contextDigest, status: "verified", after, receipt: good };
  f.rows.set("cmsBackgroundOutputs/search", state);
  f.rows.set(context.PUBLIC_CONTEXT_PATH, { schemaVersion: 1, revision: 1 });
  f.rows.set("system/publicDeployment", { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    activeDeploymentId: "fixture", activeCommitSha: rendererSha, lastReservedGeneration: 1, newestEligibleGeneration: 1,
    newestEligibleBuildBatchId: "fixture" });
  f.rows.set("system/publicDeployment/aggregateContexts/current", { schemaVersion: 1, operationId: "A".repeat(20),
    contextDigest, runtime: { owner: "cloudflare", release: rendererSha }, servingEstablished: true });
  const owner = background.createPostBackgroundOutputs({ firestore: f.firestore, artifacts,
    readContextInTransaction: async () => live, now: () => time });
  return { ...f, owner, stored, artifacts, signal, state, good, live, receipt, statuses, setTime: value => { time = value; },
    request: path => owner.serve(new Request(`https://example.test${path}`)),
    check: send => alerts.checkPostBackgroundAlerts({ firestore: f.firestore, now: () => time, send,
      log: { info: (_message, status) => statuses.push(status) } }),
    route: path => f.firestore.runTransaction(transaction => authority.readPublicContextBackgroundInTransaction({
      firestore: f.firestore, transaction, path, rendererSha })) };
}

it.each([false, true])("serves both reference and OLD inline search receipts (inline=%s)", async inline => {
  const f = await fixture({ inline, count: inline ? 110 : 4096 });
  for (const path of ["/pagefind/pagefind.js", "/search/meaning-index.json", "/_astro/search-old.js"]) {
    const reply = await f.request(path);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe(`public ${path}`);
    expect(await f.route(path)).toMatchObject({ kind: "background" });
  }
});

it("serves lastGood reference search and the single previous asset graph with the existing expiry fences", async () => {
  const f = await fixture();
  f.rows.set("cmsBackgroundOutputs/search", { ...f.state, status: "pending", receipt: null,
    lastGood: { receipt: f.good, after: f.state.after } });
  expect((await f.request("/pagefind/pagefind.js")).status).toBe(200);
  expect(await f.route("/_astro/search-old.js")).toMatchObject({ kind: "background" });
  f.rows.set("cmsBackgroundOutputs/search", { ...f.state, receipt: await f.receipt("/_astro/search-new.js"),
    previousAssets: { good: { receipt: f.good, after: f.state.after }, expiresAt: start + 15_000 } });
  expect((await f.request("/_astro/search-old.js")).status).toBe(200);
  expect(await f.route("/_astro/search-old.js")).toMatchObject({ kind: "background" });
  f.setTime(start + 15_000);
  expect((await f.request("/_astro/search-old.js")).status).toBe(404);
  f.live.withdrawalRevision = 1;
  f.live.digest = context.publicContextDigest(2);
  f.setTime(start + 60_000);
  expect((await f.request("/pagefind/pagefind.js")).status).toBe(503);
});

it.each(["digest", "foreign path", "oversize", "total bytes", "duplicate", "count"])("refuses a search reference with invalid %s", async mode => {
  const f = await fixture();
  const ref = f.good.fileManifest;
  const files = JSON.parse(f.stored.get(ref.key).toString());
  if (mode === "digest") ref.digest = "0".repeat(64);
  if (mode === "foreign path") files[0].path = "/programs/foreign/";
  if (mode === "oversize") files[0].size = 16 * 1024 * 1024 + 1;
  if (mode === "total bytes") files[0].size = files[1].size = 8 * 1024 * 1024;
  if (mode === "duplicate") files[1] = files[0];
  if (mode === "count") ref.count = 4097;
  if (!["digest", "count"].includes(mode)) {
    const bytes = Buffer.from(JSON.stringify(files));
    f.stored.set(ref.key, bytes); ref.digest = hash(bytes); ref.size = bytes.length;
  }
  await expect(manifests.readRecordManifest({ receipt: f.good, output: "search", artifacts: f.artifacts, signal: f.signal,
    scope: randomUUID() })).rejects.toThrow("manifest is unavailable");
});

it("logs once at 80% of the active search cap and clears capacity silently", async () => {
  const f = await fixture({ inline: true, count: Math.ceil(namespace.outputLimits("search").files * 0.8) - 1 });
  const messages = [];
  const send = async message => { messages.push(message); };
  await f.check(send);
  expect(messages).toEqual([]);
  f.state.receipt.manifest.push({ ...f.state.receipt.manifest[0], path: "/pagefind/one-more.pf_fragment" });
  await f.check(send);
  expect(messages).toEqual([]);
  f.state.receipt.digest = hash("another context and claim");
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses.at(-1).observations).toContainEqual({ output: "search", reason: "search_capacity" });
  expect(f.rows.get("system/cmsSearchCapacityAlerts").sentIdentities).toHaveLength(1);
  expect(f.statuses).toHaveLength(1);
  await f.check(send);
  expect(messages).toEqual([]);
  f.state.receipt.manifest.pop();
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses.at(-1).recovered).toBe(true);
  expect(f.statuses).toHaveLength(2);
  expect(f.rows.get("system/cmsSearchCapacityAlerts").sentIdentities).toEqual([]);
});

it.each([false, true])("monitors search bytes before the file warning and clears only below both bounds (inline=%s)", async inline => {
  const f = await fixture({ inline, count: 3 });
  const limits = namespace.outputLimits("search");
  const threshold = Math.ceil(limits.bytes * 0.8);
  const messages = [], send = async message => { messages.push(message); };
  const setBytes = total => {
    if (inline) {
      f.good.manifest[0].size = total - f.good.manifest[1].size - f.good.assets[0].size;
    } else f.good.totalBytes = total;
  };
  setBytes(threshold - 1);
  await f.check(send);
  expect(messages).toEqual([]);
  setBytes(threshold);
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses.at(-1).observations).toContainEqual({ output: "search", reason: "search_capacity" });
  expect(f.rows.get("system/cmsSearchCapacityAlerts").sentIdentities).toHaveLength(1);
  expect(f.statuses).toHaveLength(1);
  f.good.digest = hash("new verified search receipt");
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses).toHaveLength(1);
  // Crossing from byte pressure to file pressure must not clear the warning.
  setBytes(threshold - 1);
  const extra = Array.from({ length: Math.ceil(limits.files * 0.8) - 3 }, () => ({ size: 0 }));
  if (inline) f.good.manifest.push(...extra);
  else f.good.fileManifest.count += extra.length;
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses).toHaveLength(1);
  if (inline) f.good.manifest.pop();
  else f.good.fileManifest.count--;
  await f.check(send);
  expect(messages).toEqual([]);
  expect(f.statuses.at(-1).recovered).toBe(true);
  expect(f.statuses).toHaveLength(2);
  expect(f.rows.get("system/cmsSearchCapacityAlerts").sentIdentities).toEqual([]);
});

it("recovers an unrelated output while the search capacity warning persists", async () => {
  const f = await fixture({ inline: true, count: Math.ceil(namespace.outputLimits("search").files * 0.8) });
  const messages = [], send = async message => { messages.push(message); };
  await f.check(send);
  f.rows.set("cmsBackgroundOutputs/listings", { ...f.state, output: "listings", status: "pending", receipt: null,
    pendingSince: start - 16 * 60_000 });
  await f.check(send);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain("Public listing output is blocked");
  f.rows.set("cmsBackgroundOutputs/listings", { ...f.state, output: "listings" });
  await f.check(send);
  expect(messages).toHaveLength(1);
  expect(f.rows.get("system/cmsBackgroundAlerts").sentIdentities).toEqual([]);
  await f.check(send);
  expect(messages).toHaveLength(1);
});

it.each(["slow_retry", "fast_retry", "pending"])("keeps a failed aggregate silent after a sibling verifies and search awaits %s", async recovery => {
  const f = await fixture({ inline: true, count: 3 });
  const operationId = "A".repeat(20), runtime = { owner: "cloudflare", release: rendererSha };
  const taskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/search`;
  Object.assign(f.state, { runtime, taskPath, status: "failed", receipt: null, pendingSince: start,
    lastGood: { receipt: f.good, after: f.state.after } });
  f.rows.set("system/publicDeployment/aggregateContexts/current", { schemaVersion: 1, operationId,
    preparationOperationId: operationId, namespaceOperationId: operationId, contextDigest, runtime });
  f.rows.set(`cmsPublishQueue/${operationId}`, { runtime, transport: "public-context-no-build-v1", status: "failed",
    error: "background_generation_failed", publicContext: { contextDigest } });
  f.rows.set(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`, {
    runtime, contextDigest, status: "verified" });
  const task = { schemaVersion: 1, runtime, owner: f.state.owner, revision: f.state.revision, contextDigest,
    output: "search", status: recovery === "pending" ? "pending" : "failed",
    attempts: recovery === "slow_retry" ? 4 : recovery === "fast_retry" ? 2 : 0,
    nextAttemptAt: recovery === "slow_retry" ? null : start + 26 * 60_000, claim: null,
    slowRetryAt: recovery === "slow_retry" ? start + 26 * 60_000 : null,
    lastAttempt: { failureClass: "storage_readback", retryable: true } };
  f.rows.set(taskPath, task);
  const siblingPath = `cmsPublishQueue/${operationId}/backgroundOutputs/listings`;
  f.rows.set("cmsBackgroundOutputs/listings", { ...f.state, output: "listings", status: "verified",
    receipt: f.good, taskPath: siblingPath });
  f.rows.set(siblingPath, { ...task, output: "listings", status: "verified", attempts: 1,
    nextAttemptAt: null, slowRetryAt: null });
  f.setTime(start + 16 * 60_000);
  const messages = [], send = async message => messages.push(message);
  await f.check(send);
  expect(messages).toEqual([]);
  expect((await f.request("/pagefind/pagefind.js")).status).toBe(200);
  Object.assign(task, { status: "failed", attempts: 4, nextAttemptAt: null, slowRetryAt: null });
  await f.check(send);
  expect(messages.some(message => message.includes("Automatic listing recovery is exhausted"))).toBe(true);
  const sent = messages.length;
  await f.check(send);
  expect(messages).toHaveLength(sent);
});

it("reuses all current and predecessor manifests across mixed search, Program and Event reads", async () => {
  const stored = new Map(), scope = randomUUID(), signal = new AbortController().signal;
  let reads = 0;
  const artifacts = { async put(key, bytes) { stored.set(key, bytes); }, async get(key) { reads++; return stored.get(key); } };
  const receipts = [];
  for (const output of ["search", "programs", "events"]) {
    for (let version = 0; version < 2; version++) {
      const task = { output, claim: randomUUID() }, path = output === "search" ? `/pagefind/${version}.pf_fragment` : `/${output}/example-${version}/`;
      const manifest = [{ path, key: `post-background-v1/${output}/${task.claim}/${hash(path)}`,
        digest: hash("public"), size: 6, contentType: "text/plain" }];
      receipts.push({ output, receipt: { fileManifest: await manifests.storeRecordManifest({ manifest, task, artifacts, signal }) } });
    }
  }
  reads = 0;
  for (let round = 0; round < 3; round++) {
    for (const entry of receipts) {
      expect(await manifests.readRecordManifest({ ...entry, artifacts, signal, scope })).toHaveLength(1);
    }
  }
  expect(reads).toBe(6);
});
