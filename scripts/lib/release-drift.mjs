// Read-only drift check of one CMS target: docs/release/drift-check.md.
// Every check runs. A stopping check that fails ends the run with exit 1; a report line never does,
// except with `after`, where a part that differs from the source fails too.
// All provider calls go through `http` (fetch); nothing here writes.
import { createHash, createHmac, createSign } from "node:crypto";
import { CLOUD_WAKE_FUNCTIONS } from "./cms-release-plan.mjs";

const CF = "https://api.cloudflare.com/client/v4";

class Unread extends Error {}
const unread = why => { throw new Unread(why); };
const short = value => /^[0-9a-f]{40,64}$/.test(value ?? "") ? value.slice(0, 12) : String(value);

// The provider name of a live part on this target. A development name is either literal or a variable that holds it.
export function partName(row, environment, env) {
  if (environment === "production") return row.name;
  if (!row.dev) return undefined;
  // config-input: CMS_DEV_API_WORKER, CMS_DEV_PREVIEW_RENDERER, CMS_DEV_ADMIN_PAGES, CLOUDFLARE_DEV_PUBLIC_WORKER
  return /^[A-Z][A-Z0-9_]*$/.test(row.dev) ? env[row.dev]?.trim() || undefined : row.dev;
}

export function createReader(http) {
  async function call(label, url, init = {}) {
    let reply;
    try { reply = await http(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init }); }
    catch { unread(`${label}: no answer`); }
    if (!reply.ok) unread(`${label}: HTTP ${reply.status}`);
    return reply;
  }
  const json = async (label, url, init) => {
    const reply = await call(label, url, init);
    try { return await reply.json(); } catch { unread(`${label}: answer is not JSON`); }
  };
  const cloudflare = async (label, path, token) => {
    if (!token) unread(`${label}: no Cloudflare token`);
    const body = await json(label, `${CF}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (body?.success !== true) unread(`${label}: not a success answer`);
    return body.result;
  };
  async function google(account, scope = "https://www.googleapis.com/auth/cloud-platform") {
    let key;
    try { key = JSON.parse(account ?? ""); } catch { unread("the Firebase service account is not JSON"); }
    if (key?.type !== "service_account" || !key.private_key || !key.client_email) unread("the Firebase service account is incomplete");
    const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope, aud: key.token_uri, iat: now, exp: now + 600 })}`;
    let signature;
    try { signature = createSign("RSA-SHA256").update(head).sign(key.private_key).toString("base64url"); } catch { unread("the Firebase private key is unusable"); }
    const answer = await json("Google token", key.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${signature}` }) });
    if (typeof answer?.access_token !== "string") unread("Google token: no token");
    const headers = { authorization: `Bearer ${answer.access_token}`, "content-type": "application/json" };
    return {
      project: key.project_id,
      get: (label, url) => json(label, url, { headers }),
      post: (label, url, body) => json(label, url, { method: "POST", headers, body: JSON.stringify(body) }),
    };
  }
  return { call, json, cloudflare, google };
}

// Firestore REST values to plain values, for the few fields this check reads.
function plain(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([k, v]) => [k, plain(v)]));
  return undefined;
}

async function liveFunctions(g, project) {
  const functions = [];
  for (let page = ""; ;) {
    const list = await g.get("Functions list", `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/-/functions?pageSize=500${page && `&pageToken=${page}`}`);
    if ((list.unreachable ?? []).length) unread(`Functions list: unreachable ${list.unreachable.join(", ")}`);
    for (const fn of list.functions ?? []) {
      functions.push({ name: fn.name.split("/").at(-1), revision: fn.serviceConfig?.environmentVariables?.CMS_ADMIN_BUILD_REVISION ?? null });
    }
    if (!list.nextPageToken) return functions;
    page = list.nextPageToken;
  }
}

async function documentOf(g, project, path) {
  const reply = await g.get(path, `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`);
  return plain({ mapValue: { fields: reply.fields ?? {} } });
}

// The most frequent revision among live Functions that the source exports: the commit of the live Functions.
function liveFunctionsRevision(functions, exported) {
  const counts = new Map();
  for (const { name, revision } of functions) if (exported.has(name) && revision) counts.set(revision, (counts.get(revision) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function snippetContentSha256(r, token, zone, name) {
  const reply = await r.call("snippet content", `${CF}/zones/${zone}/snippets/${name}/content`, { headers: { authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await reply.arrayBuffer());
  let form;
  try { form = await new Response(bytes, { headers: { "content-type": reply.headers.get("content-type") ?? "" } }).formData(); } catch { unread("snippet content: not a multipart answer"); }
  const file = [...form.values()].find(value => typeof value === "object");
  if (!file) unread("snippet content: no file part");
  return createHash("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");
}

/**
 * Runs every check against one target.
 * - target: { environment, projectId, publicOrigin }
 * - registry: config/release-surfaces.json of the source commit
 * - source: { sha, exported: Set, functionsSha, rendererSha, files: { [path]: text }, snippetSha256, exportsAt(sha) -> Set|null, behind(liveSha) -> { commits, days } }
 * - env: credentials and variables by name (process.env in the workflow), including the Cloudflare
 *   account (CLOUDFLARE_ACCOUNT_ID) and the public zone (CMS_ANALYTICS_CF_ZONE_ID)
 * - compare: facts of the other target (development), or null
 * Returns { lines, failed, facts }.
 */
export async function checkReleaseDrift({ target, registry, source, env, http, after = false, compare = null }) {
  const r = createReader(http), lines = [], facts = { environment: target.environment };
  const production = target.environment === "production";
  let failed = false;
  const stop = (id, name, problems) => {
    if (problems.length) failed = true;
    lines.push(`${problems.length ? "FAIL" : "ok  "} check ${id} ${name}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  };
  const report = (name, text, differs = false) => {
    if (differs && after) failed = true;
    lines.push(`${differs ? (after ? "FAIL" : "diff") : "info"} ${name}: ${text}`);
  };
  const exported = source.exported;
  // A row with `only` names the one target that has the part (the edge snippet and Storage are production's).
  const rows = (registry.live ?? []).filter(row => !row.only || row.only === target.environment);
  const cfToken = production ? env.CLOUDFLARE_API_TOKEN : env.CLOUDFLARE_DEV_WORKER_TOKEN;
  // config-input: CLOUDFLARE_ACCOUNT_ID, CMS_DEV_CLOUDFLARE_ACCOUNT_ID, CMS_ANALYTICS_CF_ZONE_ID
  const ACCOUNT = (production ? env.CLOUDFLARE_ACCOUNT_ID : env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID)?.trim() ?? "";
  const ZONE = env.CMS_ANALYTICS_CF_ZONE_ID?.trim() ?? "";

  let g, functions = [], runtime, pointer;
  try { g = await r.google(env.FIREBASE_SERVICE_ACCOUNT); } catch (error) { if (!(error instanceof Unread)) throw error; g = error; }
  const withGoogle = async work => { if (g instanceof Error) unread(g.message); return work(g); };

  // 1. A live Function that neither the source nor the live commit exports. Firebase asks before it deletes one,
  // and the deploy stops (run 1 of Nov. 25, 2026).
  try {
    functions = await withGoogle(go => liveFunctions(go, target.projectId));
    const revision = liveFunctionsRevision(functions, exported);
    const liveExports = revision ? await source.exportsAt(revision) : null;
    const outside = new Set(rows.filter(row => row.provider === "function").flatMap(row => row.names ?? []));
    const leftovers = functions.map(fn => fn.name).filter(name => !exported.has(name) && !liveExports?.has(name) && !outside.has(name)).sort();
    facts.functions = functions.map(fn => fn.name).sort();
    facts.functionsRevision = revision;
    stop(1, "leftover Functions", leftovers.length
      ? [`${leftovers.join(", ")} ${leftovers.length === 1 ? "is" : "are"} live and exported by neither the source nor the live Functions commit ${short(revision)}${liveExports ? "" : " (its registry was not read)"}`]
      : []);
  } catch (error) { if (!(error instanceof Unread)) throw error; stop(1, "leftover Functions", [`not read: ${error.message}`]); }

  // 2. The smoke fixture is missing or not a draft. The smoke then waits for a Preview button that never comes (run 2, 31 min).
  try {
    let editor;
    try { ({ editor } = JSON.parse(env.CMS_PREVIEW_SMOKE_TARGET ?? "")); } catch { unread("CMS_PREVIEW_SMOKE_TARGET is not set"); }
    const match = /^\/content\/(post|pages)\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/edit$/.exec(editor ?? "");
    if (!match) unread("CMS_PREVIEW_SMOKE_TARGET names no editor path");
    const record = await withGoogle(go => documentOf(go, target.projectId, `${match[1] === "post" ? "cmsPosts" : "cmsPages"}/${match[2]}`))
      .catch(error => { if (error instanceof Unread && / HTTP 404$/.test(error.message)) return null; throw error; });
    const state = !record ? "missing" : record.deleted === true ? "deleted" : record.status ?? "no status";
    facts.fixture = state;
    stop(2, "smoke fixture", state === "draft" ? [] : [`the fixture is ${state}, not draft`]);
  } catch (error) { if (!(error instanceof Unread)) throw error; stop(2, "smoke fixture", [`not read: ${error.message}`]); }

  // 3. A release must not start on top of an unfinished one (the closed fence of Nov. 25, njpbs #676).
  try {
    [pointer, runtime] = await withGoogle(go => Promise.all(["system/publicDeployment", "system/cmsPublicationRuntime"].map(path => documentOf(go, target.projectId, path))));
    facts.schemaVersion = pointer.schemaVersion ?? null;
    const problems = [];
    if (pointer.state !== "idle") problems.push(`the public pointer is ${pointer.state}`);
    const generations = [pointer.activeGeneration, pointer.newestEligibleGeneration, pointer.lastReservedGeneration];
    if (new Set(generations).size !== 1) problems.push(`active, eligible and reserved generations are ${generations.join(", ")}`);
    for (const [name, phase] of [["runtime", runtime.phase], ...(runtime.cloud ? [["runtime cloud part", runtime.cloud.phase]] : [])]) {
      if (phase !== "ready") problems.push(`the ${name} phase is ${phase}`);
    }
    stop(3, "publication idle", problems);
  } catch (error) { if (!(error instanceof Unread)) throw error; stop(3, "publication idle", [`not read: ${error.message}`]); }

  // 4. A live part with no row in the registry: a part that no release deploys and no check reads (the edge snippet, 7 weeks old).
  if (production) {
    const problems = [];
    // Parts of other projects in the shared account come from the RELEASE_DRIFT_OTHER_PARTS variable, never from
    // source (AGENTS.md: no private cloud namespace names in source), and unlisted names are printed only on request,
    // because the workflow log is public.
    // config-input: RELEASE_DRIFT_OTHER_PARTS, RELEASE_DRIFT_SHOW_UNLISTED
    const other = new Set((env.RELEASE_DRIFT_OTHER_PARTS ?? "").split(",").map(name => name.trim()).filter(Boolean));
    const show = env.RELEASE_DRIFT_SHOW_UNLISTED === "1";
    const listed = provider => name => other.has(name) || rows.some(row => row.provider === provider &&
      ((row.names ?? []).includes(name) || (row.prefixes ?? []).some(p => name.startsWith(p))));
    const listings = [
      ["worker", "Workers", () => r.cloudflare("Workers", `/accounts/${ACCOUNT}/workers/scripts`, cfToken), item => item.id],
      ["pages", "Pages projects", () => r.cloudflare("Pages projects", `/accounts/${ACCOUNT}/pages/projects?per_page=100`, cfToken), item => item.name],
      ["container", "containers", () => r.cloudflare("containers", `/accounts/${ACCOUNT}/containers/applications`, cfToken), item => item.name],
      ["snippet", "Snippets", () => r.cloudflare("Snippets", `/zones/${ZONE}/snippets`, env.CLOUDFLARE_SNIPPETS_READ_TOKEN || cfToken), item => item.snippet_name],
    ];
    for (const [provider, label, read, nameOf] of listings) {
      try {
        const items = await read();
        const unlisted = (Array.isArray(items) ? items : []).map(nameOf).filter(name => !listed(provider)(name)).sort();
        if (unlisted.length) problems.push(`${unlisted.length} ${label} with no row${show ? `: ${unlisted.join(", ")}` : " (set RELEASE_DRIFT_SHOW_UNLISTED=1 in a local run to name them)"}`);
      } catch (error) { if (!(error instanceof Unread)) throw error; problems.push(`${label} not read: ${error.message}`); }
    }
    // Report only until a real production run shows the list complete; then this becomes a stopping check.
    lines.push(`info check 4 every live part has a row (report only): ${problems.length ? problems.join("; ") : "ok"}`);
  } else lines.push("info check 4 runs on production only: both targets share the Cloudflare account");

  // 5. A credential the release needs cannot do its read. A release found that only after its first write.
  {
    const problems = [];
    const step = async (name, work) => { try { await work(); } catch (error) { if (!(error instanceof Unread)) throw error; problems.push(`${name}: ${error.message}`); } };
    const holds = async (go, label, url, permissions) => {
      const held = (await go.post(label, url, { permissions })).permissions ?? [];
      const missing = permissions.filter(p => !held.includes(p));
      if (missing.length) unread(`${label}: not held ${missing.join(" ")}`);
    };
    const projectIam = `https://cloudresourcemanager.googleapis.com/v1/projects/${target.projectId}:testIamPermissions`;
    await step("Firebase deploy account", () => withGoogle(async go => {
      await holds(go, "project", projectIam, ["resourcemanager.projects.getIamPolicy", "cloudfunctions.functions.list", "run.services.getIamPolicy",
        "run.services.setIamPolicy", "datastore.entities.get", "datastore.entities.update"]);
      for (const secret of ["CMS_MEDIA_R2_ACCESS_KEY_ID", "CMS_MEDIA_R2_SECRET_ACCESS_KEY"]) {
        await holds(go, secret, `https://secretmanager.googleapis.com/v1/projects/${target.projectId}/secrets/${secret}:testIamPermissions`, ["secretmanager.versions.access"]);
      }
    }));
    await step("Cloudflare deploy token", async () => {
      const name = partName({ name: "njpbs-cms-api", dev: "CMS_DEV_API_WORKER" }, target.environment, env);
      await r.cloudflare("CMS API settings", `/accounts/${ACCOUNT}/workers/scripts/${name}/settings`, cfToken);
    });
    if (production) {
      await step("Admin Access token", async () => {
        const apps = await r.cloudflare("Access applications", `/accounts/${ACCOUNT}/access/apps?per_page=100`, env.CMS_ADMIN_ACCESS_API_TOKEN);
        const admin = (Array.isArray(apps) ? apps : []).filter(app => app?.type === "self_hosted" &&
          [app.domain, ...(app.self_hosted_domains ?? [])].some(domain => domain?.toLowerCase() === "admin.njpbs.org"));
        if (admin.length !== 1) unread(`Access applications for the admin host: ${admin.length}`);
        await r.cloudflare("Access policies", `/accounts/${ACCOUNT}/access/apps/${admin[0].id}/policies?per_page=100`, env.CMS_ADMIN_ACCESS_API_TOKEN);
      });
    }
    // The release tool holds these two on landofjawn; they are checked only where they are set.
    if (env.NJPBS_PUBLISHER_CLOUDFLARE_TOKEN) {
      await step("publisher token", async () => {
        const publisher = partName({ name: "njpbs-cms-publisher", dev: "njpbs-dev-cms-publisher" }, target.environment, env);
        await r.cloudflare("publisher deployments", `/accounts/${ACCOUNT}/workers/scripts/${publisher}/deployments`, env.NJPBS_PUBLISHER_CLOUDFLARE_TOKEN);
      });
    }
    if (production && env.NJPBS_PUBLICATION_R2_CREDENTIAL) await step("publication bucket key", () => headBucket(r, env.NJPBS_PUBLICATION_R2_CREDENTIAL, ACCOUNT));
    stop(5, "release credentials read", problems);
  }

  // Report lines: each live part against the source.
  const expected = { source: source.sha, functions: source.functionsSha, renderer: source.rendererSha };
  for (const row of rows.filter(row => row.read)) {
    const name = partName(row, target.environment, env);
    if (row.name && !name) {
      // A row without a development name is production's alone; a missing variable is a read that failed.
      if (row.dev) report(row.part, `not read: ${row.dev} is not set`, true);
      continue;
    }
    try {
      const { live, want } = await readPart(row, name);
      if (live === want) report(row.part, `equal ${short(want)}`);
      else report(row.part, `differs: live ${short(live)}, source ${short(want)}`, true);
    } catch (error) { if (!(error instanceof Unread)) throw error; report(row.part, `not read: ${error.message}`, true); }
  }
  for (const row of rows.filter(row => row.release && !row.read)) report(row.part, `deployed by ${row.release}; not read: ${row.why}`);

  async function readPart(row, name) {
    switch (row.read) {
      case "functions-revision": {
        if (!functions.length) unread("the Functions list was not read");
        // Only the cloud wake exports are left out by design (cloudWakeEnabled off); any other export must be live.
        const live = new Set(functions.map(fn => fn.name));
        const missing = [...exported].filter(name => !live.has(name)).sort();
        const optional = missing.filter(name => CLOUD_WAKE_FUNCTIONS.includes(name)), required = missing.filter(name => !CLOUD_WAKE_FUNCTIONS.includes(name));
        if (optional.length) report("Cloud wake Functions not live", optional.join(", "));
        const stale = functions.filter(fn => exported.has(fn.name) && fn.revision !== expected.functions);
        const faults = [...(required.length ? [`not live: ${required.join(", ")}`] : []),
          ...(stale.length ? [`${stale.length} Functions at ${[...new Set(stale.map(fn => short(fn.revision)))].join(", ")}`] : [])];
        return { live: faults.length ? faults.join("; ") : expected.functions, want: expected.functions };
      }
      case "firestore-rules":
      case "storage-rules": {
        const release = row.read === "firestore-rules" ? "cloud.firestore" : null;
        const live = await withGoogle(async go => {
          const releases = (await go.get("rules releases", `https://firebaserules.googleapis.com/v1/projects/${target.projectId}/releases?pageSize=100`)).releases ?? [];
          const found = releases.find(item => release ? item.name.endsWith(`/releases/${release}`) : /\/releases\/firebase\.storage\//.test(item.name));
          if (!found) unread("no rules release");
          const ruleset = await go.get("ruleset", `https://firebaserules.googleapis.com/v1/${found.rulesetName}`);
          return ruleset.source?.files?.[0]?.content ?? "";
        });
        const want = source.files[row.file];
        const hash = text => createHash("sha256").update(text ?? "").digest("hex");
        return { live: hash(live), want: hash(want) };
      }
      case "worker-variable": {
        // CMS_API_SOURCE_SHA exists from the drift check's own commit on. A release of an older source leaves that row
        // "differs"; no release goes back before it (review decision, #680).
        const settings = await r.cloudflare(`${name} settings`, `/accounts/${ACCOUNT}/workers/scripts/${name}/settings`, cfToken);
        const binding = (settings?.bindings ?? []).find(b => b.type === "plain_text" && b.name === row.variable);
        return { live: binding ? binding.text : `no ${row.variable}`, want: expected[row.expect] };
      }
      case "pages-commit": {
        const token = production ? cfToken : env.CLOUDFLARE_DEV_PAGES_TOKEN;
        // The canonical deployment is the one that serves the site; its deploy stage must have succeeded.
        const project = await r.cloudflare(`${name} project`, `/accounts/${ACCOUNT}/pages/projects/${name}`, token);
        const serving = project?.canonical_deployment;
        if (serving?.latest_stage?.name !== "deploy" || serving.latest_stage.status !== "success") unread(`${name}: the canonical deployment did not finish its deploy stage`);
        return { live: serving.deployment_trigger?.metadata?.commit_hash ?? "none", want: expected.source };
      }
      case "publication-commit": {
        // The development site sits behind Access; its service token reads the manifest (check-dev-machine-receipt.mjs does the same).
        const access = production ? {} : { "cf-access-client-id": env.CMS_DEV_ACCESS_CLIENT_ID ?? "", "cf-access-client-secret": env.CMS_DEV_ACCESS_CLIENT_SECRET ?? "" };
        const manifest = await r.json("_publication.json", `${target.publicOrigin}/_publication.json`, { headers: access });
        facts.liveSource = manifest.commitSha;
        return { live: manifest.commitSha, want: expected.source };
      }
      case "runtime-pin": {
        if (!runtime) unread("the runtime record was not read");
        const pins = [runtime.commitSha, ...(runtime.cloud ? [runtime.cloud.commitSha] : [])];
        return { live: new Set(pins).size === 1 ? pins[0] : pins.join(" and "), want: expected.source };
      }
      case "preview-runtime": {
        const preview = await withGoogle(go => documentOf(go, target.projectId, "system/cmsPreviewRuntime"));
        return { live: preview.rendererSha, want: expected.renderer };
      }
      case "edge-snippet": {
        const token = env.CLOUDFLARE_SNIPPETS_READ_TOKEN || cfToken;
        const rules = await r.cloudflare("snippet rules", `/zones/${ZONE}/snippets/snippet_rules`, token);
        const active = (rules ?? []).filter(rule => rule.enabled && (row.prefixes ?? []).some(p => rule.snippet_name?.startsWith(p)));
        if (active.length !== 1) unread(`${active.length} enabled rules run this snippet`);
        const host = new URL(target.publicOrigin).host;
        if (active[0].expression !== `http.host eq "${host}"`) return { live: `rule ${active[0].expression}`, want: `rule http.host eq "${host}"` };
        return { live: await snippetContentSha256(r, token, ZONE, active[0].snippet_name), want: source.snippetSha256 };
      }
      default: unread(`unknown read ${row.read}`);
    }
  }

  // Report lines: how far production is behind main, and how development differs from it.
  if (facts.liveSource && source.behind) {
    try {
      const { commits, days } = await source.behind(facts.liveSource);
      report("main ahead of this target", `${commits} commits, oldest unreleased ${days} days old`);
    } catch { report("main ahead of this target", "not read: the live commit is not in this clone"); }
  }
  if (compare) {
    const names = new Set(facts.functions ?? []), other = new Set(compare.functions ?? []);
    const only = (a, b) => [...a].filter(name => !b.has(name)).sort().join(", ") || "none";
    report("Functions only here", only(names, other));
    report("Functions only on development", only(other, names));
    report("pointer schemaVersion", `${facts.schemaVersion} here, ${compare.schemaVersion} on development`);
    report("smoke fixture", `${facts.fixture} here, ${compare.fixture} on development`);
  }
  return { lines, failed, facts };
}

// HEAD of the publication bucket with an S3 signature: proves the key authenticates and can read the bucket.
async function headBucket(r, credential, account) {
  let key;
  try { key = JSON.parse(credential); } catch { unread("the publication key is not JSON"); }
  if (!key?.accessKeyId || !key?.secretAccessKey) unread("the publication key is incomplete");
  const host = `${account}.r2.cloudflarestorage.com`, path = "/njpbs-cms-publication";
  const empty = createHash("sha256").update("").digest("hex");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""), day = stamp.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const names = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["HEAD", path, "", `host:${host}`, `x-amz-content-sha256:${empty}`, `x-amz-date:${stamp}`, "", names, empty].join("\n");
  const hmac = (k, v) => createHmac("sha256", k).update(v).digest();
  const signing = hmac(hmac(hmac(hmac(`AWS4${key.secretAccessKey}`, day), "auto"), "s3"), "aws4_request");
  const signature = createHmac("sha256", signing).update(["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join("\n")).digest("hex");
  await r.call("publication bucket", `https://${host}${path}`, { method: "HEAD", headers: { "x-amz-content-sha256": empty, "x-amz-date": stamp,
    authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${signature}` } });
}
