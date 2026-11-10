import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createPrivatePairPreflightCaller, preflightDigest, PRIVATE_PREFLIGHT_ATTEMPTS } from "../../scripts/lib/private-pair-preflight-caller.mjs";
import { releasePair } from "../helpers/private-public-release-pair.js";
import pairs from "../../functions/lib/public-release-pair.js";
import { privatePairReaderCapabilities, privatePairReaderDeployment,
  privatePairReaderInstallation } from "../../workers/src/private-pair-reader-installation";
import { PAIR_READER_CONTRACT } from "../../packages/content-core/src/private-pair-http.mjs";
const db = isolatedFirestore("private-pair-preflight-caller");
const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", version = "22222222-2222-4222-8222-222222222222";
let operationId;
beforeEach(() => { operationId = `probe-${randomUUID()}`; });
function plan(kind = "publisher") {
  const incarnation = "11111111-1111-4111-8111-111111111111";
  const identity = kind === "publisher" ? { pairId: `njpbs-pair-slot-${incarnation}:${incarnation}`, commitSha: "a".repeat(40), environment: "production", journalNamespace: `pair-${incarnation}` }
    : { pairId: "preview-candidate", rendererSha: "a".repeat(40), serializerId: "preview-candidate" };
  return { schemaVersion: 1, operationId, kind, accountId, workerName: kind === "publisher" ? `njpbs-pair-publisher-${incarnation}` : "njpbs-preview-candidate",
    workerVersion: version, identity, installedTargetDigest: "b".repeat(64) };
}
function readerInstallation() {
  const pair = releasePair();
  // Consume the actual slot's producer and the container's shared capability
  // contract, independently of the caller's response parser.
  pair.readerContractDigest = pairs.publicReleaseDigest(PAIR_READER_CONTRACT);
  const capabilities = privatePairReaderCapabilities(pair.commitSha);
  const deployment = privatePairReaderDeployment(pair, "https://reader-a.example.test");
  pair.readerReceiptDigest = pairs.publicReleaseDigest(deployment);
  pair.capabilityDigest = pairs.publicReleaseDigest(capabilities);
  return { input: { schemaVersion: 1, operationId, kind: "reader-installation", accountId,
    workerName: pair.publicWorker.service, workerVersion: pair.publicWorker.versionId,
    identity: pair, installedTargetDigest: "b".repeat(64) },
  result: { seals: privatePairReaderInstallation(pair, deployment.origin),
    publisher: { pairDigest: pairs.publicReleaseDigest(pair), publisher: pair.publisher,
      readerContractDigest: pair.readerContractDigest, capabilities } } };
}
function fixture(input = plan(), overrides = {}) {
  const calls = [], credentials = { api: "fixture-api-token", session: "fixture-session-token", preview: "fixture-preview-token", exchange: "fixture-exchanged-token" };
  const result = overrides.readerResult ?? (input.kind === "publisher" ? { ready: true, pairId: input.identity.pairId, commitSha: input.identity.commitSha, journalNamespace: input.identity.journalNamespace }
    : { ready: true, ...input.identity, workerVersion: version });
  const envelope = value => Response.json({ success: true, result: value });
  const ref = db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(input.operationId);
  let worker;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    const phase = path.endsWith("/subdomain/edge-preview") ? "session" : path.endsWith("/edge-preview") ? "upload"
      : path === "/exchange" ? "exchange" : path === "/__private_pair_preflight" ? "invoke" : "inventory";
    calls.push({ url, init, phase });
    if (phase !== "inventory") expect((await ref.get()).data().steps[phase].state).toBe("started");
    if (overrides.respond) { const answer = await overrides.respond({ phase, url, init, calls }); if (answer) return answer; }
    if (phase === "inventory") return envelope({ subdomain: "owned-account" });
    if (phase === "session") return envelope({ token: credentials.session, ...(overrides.exchange ? { exchange_url: "https://exchange.owned-account.workers.dev/exchange" } : {}) });
    if (phase === "exchange") {
      expect(init.headers?.Authorization).toBeUndefined(); return Response.json({ token: credentials.exchange });
    }
    if (phase === "upload") {
      const metadata = JSON.parse(init.body.get("metadata"));
      expect(metadata.bindings).toEqual([{ name: "PAIR_PREFLIGHT", type: "service", service: input.workerName,
        ...(input.kind === "publisher" ? { entrypoint: "PairPublicationWake" }
          : input.kind === "reader-installation" ? { entrypoint: "PublicReleaseSlotEntrypoint" } : {}) }]);
      expect(init.body.get("wrangler-session-config")).toBe(JSON.stringify({ workers_dev: true, minimal_mode: true }));
      expect(init.headers["cf-preview-upload-config-token"]).toBe(overrides.exchange ? credentials.exchange : credentials.session);
      const source = await init.body.get("probe.mjs").text();
      worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
      return envelope({ preview_token: credentials.preview });
    }
    expect(init.headers["cf-workers-preview-token"]).toBe(credentials.preview);
    expect(init.headers.Authorization).toBeUndefined();
    let invoked = 0;
    const response = await worker.fetch(new Request(url, init), { PAIR_PREFLIGHT: { readerInstallation: async (...args) => {
      invoked++; expect(input.kind).toBe("reader-installation"); expect(args).toEqual([]);
      return structuredClone(result);
    }, preflight: async identity => {
      invoked++; expect(identity).toEqual(input.identity); return { ...result, ...(overrides.health ?? {}), ignored: "not-in-receipt" };
    } } });
    expect(invoked).toBe(1);
    return response;
  };
  const options = { firestore: db, plan: input, readToken: async () => credentials.api,
    assertTargetCurrent: overrides.assertTargetCurrent ?? (async () => input.installedTargetDigest), fetchImpl,
    ...(overrides.clock ? { clock: overrides.clock } : {}), ...(overrides.signal ? { signal: overrides.signal } : {}) };
  return { input, calls, credentials, result, options, ref, caller: createPrivatePairPreflightCaller(options) };
}

it.each(["publisher", "preview"])("executes one real generated service-binding probe for %s with durable phases", async kind => {
  const f = fixture(plan(kind));
  expect(await f.caller(f.input.identity)).toEqual(f.result);
  expect(f.calls.map(value => value.phase)).toEqual(["inventory", "session", "upload", "invoke"]);
  const record = (await f.ref.get()).data();
  expect(record).toMatchObject({ state: "complete", result: f.result });
  expect(record.requestDigest).toBe(preflightDigest({ plan: f.input, callerSourceDigest: record.callerSourceDigest, callerConfigurationDigest: record.callerConfigurationDigest }));
  expect(Object.values(record.steps).every(value => value.state === "complete")).toBe(true);
  for (const credential of Object.values(f.credentials)) expect(JSON.stringify(record)).not.toContain(credential);
  const count = f.calls.length;
  expect(await f.caller(f.input.identity)).toEqual(f.result); expect(f.calls).toHaveLength(count);
});
it("calls only the actual no-argument slot reader RPC and retains its sealed shape across an exact retry", async () => {
  const reader = readerInstallation(), f = fixture(reader.input, { readerResult: reader.result });
  expect(await f.caller(f.input.identity)).toEqual(reader.result);
  const record = (await f.ref.get()).data();
  expect(record).toMatchObject({ state: "complete", request: { kind: "reader-installation", identity: reader.input.identity }, result: reader.result });
  expect(record.result.ready).toBeUndefined();
  const count = f.calls.length;
  expect(await f.caller(f.input.identity)).toEqual(reader.result);
  expect(f.calls).toHaveLength(count);
  for (const credential of Object.values(f.credentials)) expect(JSON.stringify(record)).not.toContain(credential);
});

it.each([
  ["deployment UUID", result => { result.seals.deployment.versionId = version; }],
  ["deployment source", result => { result.seals.deployment.commitSha = "c".repeat(40); }],
  ["deployment origin", result => { result.seals.deployment.origin = "https://other.example.test"; }],
  ["capability bytes", result => { result.seals.capabilities.post.liveBlogVersion = 2; }],
  ["publisher image", result => { result.publisher.publisher.imageDigest = `sha256:${"c".repeat(64)}`; }],
  ["publisher pair", result => { result.publisher.pairDigest = "c".repeat(64); }],
  ["publisher capabilities", result => { result.publisher.capabilities = {}; }],
  ["unexpected root field", result => { result.unexpected = "not-an-installation-field"; }],
])("refuses mismatched reader %s without a success receipt or repeated RPC", async (label, change) => {
  const reader = readerInstallation(), result = structuredClone(reader.result);
  change(result);
  const f = fixture(reader.input, { readerResult: result });
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({ code: "private-preflight-not-ready" });
  const record = (await f.ref.get()).data();
  expect(record.state).toBe("failed");
  expect(record.result).toBeUndefined();
  const count = f.calls.length;
  await expect(f.caller(f.input.identity)).rejects.toThrow("Private pair preflight refused");
  expect(f.calls).toHaveLength(count);
});

it("refuses a reader operation aimed at publisher, changed UUID, unknown RPC or changed operation reuse", async () => {
  const reader = readerInstallation(), f = fixture(reader.input, { readerResult: reader.result });
  for (const change of [{ workerName: reader.input.identity.publisher.application }, { workerVersion: version }, { kind: "serve" }]) {
    expect(() => createPrivatePairPreflightCaller({ ...f.options, plan: { ...reader.input, ...change } }))
      .toThrow("Private pair preflight refused");
  }
  expect(f.calls).toHaveLength(0);
  await f.caller(f.input.identity);
  const alternate = plan();
  await expect(createPrivatePairPreflightCaller({ ...f.options, plan: alternate })(alternate.identity))
    .rejects.toMatchObject({ code: "preflight-attempt-conflict" });
});

it("does not replay reader authority after a lost reply or return a completed receipt after target drift", async () => {
  const reader = readerInstallation();
  const lost = fixture(reader.input, { readerResult: reader.result,
    respond: ({ phase }) => { if (phase === "invoke") throw new Error("lost reply"); } });
  await expect(lost.caller(lost.input.identity)).rejects.toMatchObject({ code: "preflight-request-uncertain", uncertain: true });
  const count = lost.calls.length;
  await expect(lost.caller(lost.input.identity)).rejects.toMatchObject({ code: "preflight-attempt-uncertain" });
  expect(lost.calls).toHaveLength(count);
  operationId = `probe-${randomUUID()}`;
  const current = readerInstallation(); let target = current.input.installedTargetDigest;
  const completed = fixture(current.input, { readerResult: current.result, assertTargetCurrent: async () => target });
  await completed.caller(completed.input.identity);
  target = "c".repeat(64);
  await expect(completed.caller(completed.input.identity)).rejects.toMatchObject({ code: "preflight-target-changed" });
});
it("journals optional same-account token exchange without sending the API credential to it", async () => {
  const f = fixture(plan(), { exchange: true });
  expect(await f.caller(f.input.identity)).toEqual(f.result);
  expect(f.calls.map(value => value.phase)).toEqual(["inventory", "session", "exchange", "upload", "invoke"]);
});
it("rejects the public rendering slot as the publisher RPC target", () => {
  const input=plan(), f=fixture(input);
  expect(input.workerName).toBe("njpbs-pair-publisher-11111111-1111-4111-8111-111111111111");
  expect(()=>createPrivatePairPreflightCaller({...f.options,plan:{...input,workerName:input.identity.pairId.split(":")[0]}}))
    .toThrow("Private pair preflight refused");
  expect(f.calls).toHaveLength(0);
});
it.each(["session", "upload", "invoke"])("never repeats a %s dispatch after a lost response", async failure => {
  const f = fixture(plan(), { respond: ({ phase }) => { if (phase === failure) throw new Error("fixture provider detail"); } });
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({ code: "preflight-request-uncertain", uncertain: true, message: "Private pair preflight refused" });
  expect((await f.ref.get()).data().state).toBe("uncertain");
  const count = f.calls.length;
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({ code: "preflight-attempt-uncertain" });
  expect(f.calls).toHaveLength(count); expect(f.calls.filter(value => value.phase === failure)).toHaveLength(1);
});
it.each([302, 503])("does not follow or retry provider HTTP %s", async status => {
  const f = fixture(plan(), { respond: ({ phase }) => phase === "upload" ? new Response("provider detail", { status, headers: { location: "https://untrusted.invalid/" } }) : undefined });
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({ code: "preflight-http-refused", uncertain: true });
  expect(f.calls.filter(value => value.phase === "upload")).toHaveLength(1);
  expect(f.calls.every(value => value.init.redirect === "error")).toBe(true);
});
it("refuses an unbound or changed target before session creation and rechecks it around RPC", async () => {
  const f = fixture();
  expect(() => createPrivatePairPreflightCaller({ ...f.options, assertTargetCurrent: undefined })).toThrow("Private pair preflight refused");
  const changed = fixture(plan(), { assertTargetCurrent: async () => "c".repeat(64) });
  await expect(changed.caller(changed.input.identity)).rejects.toMatchObject({ code: "preflight-target-changed" });
  expect(changed.calls).toHaveLength(0); expect((await changed.ref.get()).exists).toBe(false);
  let reads = 0;
  const drifting = fixture(plan(), { assertTargetCurrent: async () => ++reads === 1 ? "b".repeat(64) : "c".repeat(64) });
  await expect(drifting.caller(drifting.input.identity)).rejects.toMatchObject({ code: "preflight-target-changed" });
  expect(drifting.calls.some(value => value.phase === "invoke")).toBe(false);
});
it("rejects changed identity, untrusted exchange host and non-ready or mismatched health", async () => {
  const f = fixture();
  await expect(f.caller({ ...f.input.identity, commitSha: "c".repeat(40) })).rejects.toMatchObject({ code: "preflight-input-invalid" });
  expect(f.calls).toHaveLength(0);
  for (const health of [{ ready: false, reason: "billing-disabled" }, { pairId: "other" }]) {
    operationId = `probe-${randomUUID()}`;
    const bad = fixture(plan(), { health });
    await expect(bad.caller(bad.input.identity)).rejects.toThrow("Private pair preflight refused");
    const record=(await bad.ref.get()).data();
    expect(record.state).toBe("failed");expect(record.refusalCode).toBe("private-preflight-not-ready");
    if(health.ready===false)expect(record.refusalHealth).toEqual({ready:false,pairId:bad.input.identity.pairId,reason:"billing-disabled"});
    const count=bad.calls.length;
    await expect(bad.caller(bad.input.identity)).rejects.toMatchObject({code:"private-preflight-not-ready",uncertain:false,
      ...(health.ready===false?{refusalHealth:record.refusalHealth}:{})});
    expect(bad.calls).toHaveLength(count);
  }
  operationId = `probe-${randomUUID()}`;
  const bad = fixture(plan(), { respond: ({ phase }) => phase === "session" ? Response.json({ success: true, result: { token: "fixture-token", exchange_url: "https://untrusted.invalid/exchange" } }) : undefined });
  await expect(bad.caller(bad.input.identity)).rejects.toMatchObject({ code: "preflight-response-invalid" });
  expect(bad.calls.some(value => value.phase === "exchange")).toBe(false);
});
it("allows one concurrent mutation grant and refuses changed reuse of its operation id", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.caller(f.input.identity), f.caller(f.input.identity)]);
  expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
  expect(f.calls.filter(value => value.phase === "session")).toHaveLength(1);
  const altered = createPrivatePairPreflightCaller({ ...f.options, plan: { ...f.input, workerVersion: "33333333-3333-4333-8333-333333333333" } });
  await expect(altered(f.input.identity)).rejects.toMatchObject({ code: "preflight-attempt-conflict" });
});
it("keeps original completion time, refuses stale results and strips unknown boundary errors", async () => {
  let now = Date.now();
  const f = fixture(plan(), { clock: () => now });
  await f.caller(f.input.identity); const completed = (await f.ref.get()).data().completedAt;
  now += 300_001;
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({ code: "preflight-receipt-expired" });
  expect((await f.ref.get()).data().completedAt).toBe(completed);
  operationId = `probe-${randomUUID()}`;
  const failing = fixture(plan(), { assertTargetCurrent: async () => { throw new Error("fixture private detail"); } });
  await expect(failing.caller(failing.input.identity)).rejects.toMatchObject({ code: "preflight-target-unavailable", message: "Private pair preflight refused" });
});
it("cancels before starting and after a journaled session without sending an upload", async () => {
  const early=fixture(plan(),{signal:AbortSignal.abort()});
  await expect(early.caller(early.input.identity)).rejects.toMatchObject({code:"preflight-cancelled",uncertain:false});
  expect((await early.ref.get()).exists).toBe(false);expect(early.calls).toHaveLength(0);
  const controller=new AbortController();
  const late=fixture(plan(),{signal:controller.signal,respond:({phase})=>{if(phase==="session")controller.abort();}});
  await expect(late.caller(late.input.identity)).rejects.toThrow("Private pair preflight refused");
  expect(late.calls.some(value=>value.phase==="upload")).toBe(false);
  expect((await late.ref.get()).data().state).not.toBe("complete");
});
it("refuses target drift after the actual RPC and leaves no successful receipt", async () => {
  let reads=0;
  const f=fixture(plan(),{assertTargetCurrent:async()=>++reads<3?"b".repeat(64):"c".repeat(64)});
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({code:"preflight-target-changed"});
  expect(f.calls.filter(value=>value.phase==="invoke")).toHaveLength(1);
  expect((await f.ref.get()).data().state).toBe("failed");
});
it("rechecks target readback on completed receipt replay without dispatching another probe", async () => {
  let changed=false;
  const f=fixture(plan(),{assertTargetCurrent:async()=>changed?"c".repeat(64):"b".repeat(64)});
  await f.caller(f.input.identity);const count=f.calls.length;
  changed=true;
  await expect(f.caller(f.input.identity)).rejects.toMatchObject({code:"preflight-target-changed"});
  expect(f.calls).toHaveLength(count);expect((await f.ref.get()).data().state).toBe("complete");
});
