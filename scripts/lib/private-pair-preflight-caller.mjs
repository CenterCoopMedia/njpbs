import { createHash } from "node:crypto";
import pairs from "../../functions/lib/public-release-pair.js";
import pairWork from "../../functions/lib/public-release-pair-work.js";

export const PRIVATE_PREFLIGHT_ATTEMPTS = "privatePairPreflightAttempts";
const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const API = "https://api.cloudflare.com/client/v4";
const SHA = /^[a-f0-9]{40}$/, HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PREVIEW = /^preview-[a-z0-9][a-z0-9-]{0,31}$/;
const DEFINITE_REFUSALS = new Set(["private-preflight-not-ready", "preflight-target-changed", "preflight-target-unavailable",
  "preflight-credential-unavailable", "preflight-clock-invalid", "preflight-input-invalid"]);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
export class PrivatePairPreflightError extends Error {
  constructor(code, uncertain = false) { super("Private pair preflight refused"); this.name = "PrivatePairPreflightError"; this.code = code; this.uncertain = uncertain; }
}
const refuse = (code, uncertain = false) => { throw new PrivatePairPreflightError(code, uncertain); };
const exact = (value, keys) => {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse("preflight-input-invalid");
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
export const preflightDigest = value => createHash("sha256").update("private-pair-preflight-v1\n").update(JSON.stringify(canonical(value))).digest("hex");
function identity(kind, value) {
  if (kind === "reader-installation") {
    try {
      const pair = pairs.parsePublicReleasePair(value);
      pairWork.assertPrivatePairResources(pair);
      return pair;
    } catch { refuse("preflight-input-invalid"); }
  }
  if (kind === "publisher") {
    exact(value, ["pairId", "commitSha", "environment", "journalNamespace"]);
    if (typeof value.pairId !== "string") refuse("preflight-input-invalid");
    const [name, incarnation, extra] = value.pairId.split(":");
    if (extra !== undefined || !matches(UUID, incarnation) || name !== `njpbs-pair-slot-${incarnation}` ||
        !matches(SHA, value.commitSha) || !["production", "development"].includes(value.environment) ||
        typeof value.journalNamespace !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.journalNamespace)) refuse("preflight-input-invalid");
  } else if (kind === "preview") {
    exact(value, ["pairId", "rendererSha", "serializerId"]);
    if (!matches(PREVIEW, value.pairId) || !matches(SHA, value.rendererSha) || value.serializerId !== value.pairId) refuse("preflight-input-invalid");
  } else refuse("preflight-input-invalid");
  return Object.freeze({ ...value });
}
export function parsePrivatePairPreflightPlan(value) {
  exact(value, ["schemaVersion", "operationId", "kind", "accountId", "workerName", "workerVersion", "identity", "installedTargetDigest"]);
  const parsed = identity(value.kind, value.identity);
  const workerName = value.kind === "reader-installation" ? parsed.publicWorker.service
    : value.kind === "publisher" ? `njpbs-pair-publisher-${parsed.pairId.split(":")[1]}` : `njpbs-${parsed.pairId}`;
  if (value.schemaVersion !== 1 || !matches(ID, value.operationId) || value.accountId !== ACCOUNT || value.workerName !== workerName ||
      !matches(UUID, value.workerVersion) || !matches(HEX, value.installedTargetDigest) ||
      value.kind === "reader-installation" && value.workerVersion !== parsed.publicWorker.versionId) refuse("preflight-input-invalid");
  return Object.freeze({ ...value, identity: parsed });
}
/** Reader installation returns sealed RPC facts, never a synthesized health
 * receipt. The frozen full pair binds the deployment, capability and publisher
 * bytes; the owning install writer independently checks their full contract. */
function readerInstallationResult(plan, value) {
  const pair = plan.identity;
  try {
    exact(value, ["seals", "publisher"]);
    exact(value.seals, ["schemaVersion", "status", "deployment", "capabilities"]);
    exact(value.seals.deployment, ["schemaVersion", "environment", "service", "versionId", "commitSha", "contractDigest", "origin"]);
    exact(value.publisher, ["pairDigest", "publisher", "readerContractDigest", "capabilities"]);
  } catch { refuse("private-preflight-not-ready"); }
  const deployment = value.seals.deployment, publisher = value.publisher;
  if (value.seals.schemaVersion !== 1 || value.seals.status !== "verified" || deployment.schemaVersion !== 1 ||
      deployment.environment !== pair.environment || deployment.service !== plan.workerName ||
      deployment.versionId !== plan.workerVersion || deployment.commitSha !== pair.commitSha ||
      deployment.contractDigest !== pair.readerContractDigest ||
      pairs.publicReleaseDigest(deployment) !== pair.readerReceiptDigest ||
      pairs.publicReleaseDigest(value.seals.capabilities) !== pair.capabilityDigest ||
      publisher.pairDigest !== pairs.publicReleaseDigest(pair) ||
      pairs.publicReleaseDigest(publisher.publisher) !== pairs.publicReleaseDigest(pair.publisher) ||
      publisher.readerContractDigest !== pair.readerContractDigest ||
      pairs.publicReleaseDigest(publisher.capabilities) !== pair.capabilityDigest) refuse("private-preflight-not-ready");
  return value;
}
const projectResult = (plan, value) => plan.kind === "reader-installation" ? readerInstallationResult(plan, value) : projectHealth(plan, value);
function projectHealth(plan, value) {
  if (!object(value) || value.ready !== true || value.pairId !== plan.identity.pairId) refuse("private-preflight-not-ready");
  if (plan.kind === "publisher") {
    if (value.commitSha !== plan.identity.commitSha || value.journalNamespace !== plan.identity.journalNamespace) refuse("private-preflight-not-ready");
    return { ready: true, pairId: value.pairId, commitSha: value.commitSha, journalNamespace: value.journalNamespace };
  }
  if (value.rendererSha !== plan.identity.rendererSha || value.serializerId !== plan.identity.serializerId || value.workerVersion !== plan.workerVersion) refuse("private-preflight-not-ready");
  return { ready: true, pairId: value.pairId, rendererSha: value.rendererSha, serializerId: value.serializerId, workerVersion: value.workerVersion };
}
function projectRefusalHealth(plan, value) {
  if (plan.kind === "reader-installation") return null;
  if (value?.ready !== false || value.pairId !== plan.identity.pairId) return null;
  return { ready: false, pairId: value.pairId,
    ...(["billing-disabled", "waiting-for-executor", "not-ready"].includes(value.reason) ? { reason: value.reason } : {}) };
}
function probeSource(plan, requestDigest) {
  if (plan.kind === "reader-installation") return `const challenge=${JSON.stringify(requestDigest)};
export default {async fetch(request,env){
 if(request.method!=='POST'||new URL(request.url).pathname!=='/__private_pair_preflight')return new Response(null,{status:404});
 try{if(request.headers.get('content-type')!=='application/json'||Number(request.headers.get('content-length'))>256)return new Response(null,{status:404});
 const text=await request.text();if(text.length>256||text!==JSON.stringify({challenge}))return new Response(null,{status:404});
 const observed=await env.PAIR_PREFLIGHT.readerInstallation();
 return Response.json(observed,{headers:{'cache-control':'no-store'}});
 }catch{return new Response(null,{status:503,headers:{'cache-control':'no-store'}});}
}};`;
  const keys = plan.kind === "publisher" ? ["ready", "pairId", "commitSha", "journalNamespace", "reason"] : ["ready", "pairId", "rendererSha", "serializerId", "workerVersion", "reason"];
  return `const identity=${JSON.stringify(plan.identity)};const challenge=${JSON.stringify(requestDigest)};const keys=${JSON.stringify(keys)};
export default {async fetch(request,env){
 if(request.method!=='POST'||new URL(request.url).pathname!=='/__private_pair_preflight')return new Response(null,{status:404});
 try{if(request.headers.get('content-type')!=='application/json'||Number(request.headers.get('content-length'))>256)return new Response(null,{status:404});
 const text=await request.text();if(text.length>256||text!==JSON.stringify({challenge}))return new Response(null,{status:404});
 const observed=await env.PAIR_PREFLIGHT.preflight(identity);const result=Object.fromEntries(keys.map(key=>[key,observed?.[key]]));
 return Response.json(result,{headers:{'cache-control':'no-store'}});
 }catch{return new Response(null,{status:503,headers:{'cache-control':'no-store'}});}
}};`;
}
async function boundedJson(response, uncertain) {
  if (!response?.ok || !response.body) { await response?.body?.cancel(); refuse("preflight-http-refused", uncertain); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length;
      if (length > 64 * 1024) refuse("preflight-response-invalid", uncertain); chunks.push(part.value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof PrivatePairPreflightError) throw error;
    refuse("preflight-response-invalid", uncertain);
  } finally { await reader.cancel(); }
}
/** One shared actual transport for publisher/preview health or the closed slot
 * readerInstallation RPC. Session,
 * optional exchange, upload and invocation are durably reserved; no SDK/CLI retries,
 * subdomain registration, target deployment, log tail or session renewal.
 * assertTargetCurrent is the install owner's real provider/registry readback.
 */
export function createPrivatePairPreflightCaller({ firestore, plan: raw, readToken, assertTargetCurrent,
  fetchImpl = fetch, clock = Date.now, signal } = {}) {
  const plan = parsePrivatePairPreflightPlan(raw), challenge = preflightDigest(plan);
  const source = probeSource(plan, challenge);
  const metadata = { main_module: "probe.mjs", compatibility_date: "2026-10-28", logpush: false,
    bindings: [{ name: "PAIR_PREFLIGHT", type: "service", service: plan.workerName,
      ...(plan.kind === "publisher" ? { entrypoint: "PairPublicationWake" }
        : plan.kind === "reader-installation" ? { entrypoint: "PublicReleaseSlotEntrypoint" } : {}) }] };
  const callerSourceDigest = createHash("sha256").update(source).digest("hex");
  const callerConfigurationDigest = preflightDigest(metadata);
  const requestDigest = preflightDigest({ plan, callerSourceDigest, callerConfigurationDigest });
  const callerName = `njpbs-private-preflight-${requestDigest.slice(0, 24)}`;
  if (!firestore || typeof readToken !== "function" || typeof assertTargetCurrent !== "function" || typeof fetchImpl !== "function") refuse("private-preflight-unbound");
  const ref = firestore.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(plan.operationId);
  const instant = () => { const time = clock(); if (!Number.isSafeInteger(time) || time < 0) refuse("preflight-clock-invalid"); return new Date(time).toISOString(); };
  const check = value => {
    if (!value || value.schemaVersion !== 1 || value.requestDigest !== requestDigest ||
        preflightDigest({ plan: value.request, callerSourceDigest: value.callerSourceDigest, callerConfigurationDigest: value.callerConfigurationDigest }) !== requestDigest) refuse("preflight-attempt-conflict");
    return value;
  };
  const currentTarget = async () => {
    signal?.throwIfAborted();
    let observation;
    try { observation = await assertTargetCurrent({ plan }); }
    catch { refuse("preflight-target-unavailable"); }
    if (observation !== plan.installedTargetDigest) refuse("preflight-target-changed");
  };
  const step = async (name, run) => {
    signal?.throwIfAborted();
    await firestore.runTransaction(async tx => {
      const value = check((await tx.get(ref)).data());
      if (value.state !== "started" || value.steps?.[name]) refuse("preflight-attempt-uncertain", true);
      tx.update(ref, { [`steps.${name}`]: { state: "started", startedAt: instant() } });
    });
    signal?.throwIfAborted();
    const result = await run();
    await firestore.runTransaction(async tx => {
      const value = check((await tx.get(ref)).data());
      if (value.state !== "started" || value.steps?.[name]?.state !== "started") refuse("preflight-attempt-uncertain", true);
      tx.update(ref, { [`steps.${name}`]: { state: "complete", completedAt: instant() } });
    });
    return result;
  };
  const request = async (url, init = {}, uncertain = false, timeout = 30_000) => {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) }); }
    catch { refuse("preflight-request-uncertain", uncertain); }
    return boundedJson(response, uncertain);
  };
  const api = async (suffix, init, uncertain = false) => {
    let token;
    try { token = await readToken(); } catch { refuse("preflight-credential-unavailable"); }
    if (typeof token !== "string" || !token || /[\r\n]/.test(token)) refuse("preflight-credential-unavailable");
    const envelope = await request(`${API}/accounts/${ACCOUNT}${suffix}`, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }, uncertain);
    if (envelope?.success !== true || !object(envelope.result)) refuse("preflight-response-invalid", uncertain);
    return envelope.result;
  };
  const invoke = async (rawIdentity, progress) => {
    if (preflightDigest(identity(plan.kind, rawIdentity)) !== preflightDigest(plan.identity)) refuse("preflight-input-invalid");
    const previous = await ref.get();
    if (previous.exists) {
      const value = check(previous.data());
      if (value.state === "failed") {
        const error = new PrivatePairPreflightError(DEFINITE_REFUSALS.has(value.refusalCode) ? value.refusalCode : "preflight-attempt-failed");
        const health = projectRefusalHealth(plan, value.refusalHealth);
        if (health) error.refusalHealth = health;
        throw error;
      }
      if (value.state !== "complete") refuse("preflight-attempt-uncertain", true);
      // A retry can read its original receipt; it cannot refresh its timestamp.
      const time = clock(), completed = Date.parse(value.completedAt);
      if (!Number.isSafeInteger(time) || typeof value.completedAt !== "string" || !Number.isFinite(completed) ||
          time < completed || time - completed > 300_000) refuse("preflight-receipt-expired");
      if (value.resultDigest !== preflightDigest(value.result)) refuse("preflight-attempt-conflict");
      await currentTarget();
      return projectResult(plan, value.result);
    }
    await currentTarget();
    const subdomain = (await api("/workers/subdomain")).subdomain;
    if (typeof subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) refuse("preflight-subdomain-missing");
    progress.reserved = true;
    await firestore.runTransaction(async tx => {
      if ((await tx.get(ref)).exists) refuse("preflight-attempt-uncertain", true);
      tx.create(ref, { schemaVersion: 1, request: plan, callerSourceDigest, callerConfigurationDigest, requestDigest,
        state: "started", startedAt: instant(), steps: {} });
    });
    let refusalHealth = null;
    try {
      const session = await step("session", () => api("/workers/subdomain/edge-preview", undefined, true));
      let sessionToken = session.token;
      if (session.exchange_url) {
        let url;
        try { url = new URL(session.exchange_url); } catch { refuse("preflight-response-invalid", true); }
        if (url.protocol !== "https:" || url.port || url.username || url.password ||
            !new RegExp(`^[a-z0-9-]+\\.${subdomain}\\.workers\\.dev$`).test(url.hostname)) refuse("preflight-response-invalid", true);
        const exchanged = await step("exchange", () => request(url.href, undefined, true));
        sessionToken = exchanged.token;
      }
      if (typeof sessionToken !== "string" || !sessionToken || /[\r\n]/.test(sessionToken)) refuse("preflight-response-invalid", true);
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.set("probe.mjs", new Blob([source], { type: "application/javascript+module" }), "probe.mjs");
      form.set("wrangler-session-config", JSON.stringify({ workers_dev: true, minimal_mode: true }));
      const uploaded = await step("upload", () => api(`/workers/scripts/${callerName}/edge-preview`, {
        method: "POST", body: form, headers: { "cf-preview-upload-config-token": sessionToken },
      }, true));
      if (typeof uploaded.preview_token !== "string" || !uploaded.preview_token || /[\r\n]/.test(uploaded.preview_token)) refuse("preflight-response-invalid", true);
      await currentTarget();
      const observed = await step("invoke", () => request(`https://${callerName}.${subdomain}.workers.dev/__private_pair_preflight`, {
        method: "POST", headers: { "content-type": "application/json", "cf-workers-preview-token": uploaded.preview_token },
        body: JSON.stringify({ challenge }),
      }, true, 180_000));
      refusalHealth = projectRefusalHealth(plan, observed);
      const result = projectResult(plan, observed);
      await currentTarget();
      await firestore.runTransaction(async tx => {
        const value = check((await tx.get(ref)).data());
        if (value.state !== "started" || value.steps?.invoke?.state !== "complete") refuse("preflight-attempt-uncertain", true);
        tx.update(ref, { state: "complete", result, resultDigest: preflightDigest(result), completedAt: instant() });
      });
      return result;
    } catch (error) {
      const controlled = error instanceof PrivatePairPreflightError ? error : new PrivatePairPreflightError(signal?.aborted ? "preflight-cancelled" : "preflight-attempt-uncertain", true);
      await firestore.runTransaction(async tx => {
        const value = check((await tx.get(ref)).data());
        if (value.state !== "complete") tx.update(ref, { state: controlled.uncertain ? "uncertain" : "failed", refusalCode: controlled.code,
          ...(refusalHealth ? { refusalHealth } : {}) });
      }).catch(() => undefined);
      throw controlled;
    }
  };
  return async input => {
    const progress = { reserved: false };
    try {
      if (signal?.aborted) refuse("preflight-cancelled");
      return await invoke(input, progress);
    }
    catch (error) {
      if (error instanceof PrivatePairPreflightError) throw error;
      // SDK and injected-boundary errors may quote credentials; keep no cause.
      throw new PrivatePairPreflightError(signal?.aborted ? "preflight-cancelled" : "preflight-boundary-unavailable", progress.reserved);
    }
  };
}
