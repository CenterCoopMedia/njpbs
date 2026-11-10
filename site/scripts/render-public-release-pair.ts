import { contentLinkRedirect } from "../../packages/content-core/src/content-link.ts";
import { PAIR_STATIC_SOURCE_FILE } from "./public-release-pair-static-source";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import views from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairRenderPlans } from "./public-release-pair-render-plans";
import { parsePublicReleasePairRenderRequest, type PairRenderRequest } from "./public-release-pair-render-request";
import { verifyPublicReleasePairRenderer } from "./public-release-pair-renderer-release.mjs";
import { projectPublicReleasePairReplay, isPublicReleasePairProjection, PAIR_REPLAY_PROVENANCE_FILE } from "./public-release-pair-replay";
import { renderPublicReleasePairAggregates } from "./render-public-release-pair-aggregates";
import { publicReleasePairRequiredBaselineMembers, publicReleasePairHtmlRoute } from "./public-release-pair-aggregate-outputs";
import { parsePublicReleasePairCodePack } from "./public-release-pair-code-pack";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import type { PairAuthorOwner } from "../../functions/lib/public-release-pair-author";

/** This entry is bundled into the sealed graph and runs only in bubblewrap. */
const childStarted = performance.now(), childTimings: Record<string, number> = {};
let childMarked = childStarted;
const childMark = (name: string) => { const now = performance.now(); childTimings[name] = now - childMarked; childMarked = now; };
const raw = JSON.parse(await readFile("/preview/input.json", "utf8"));
const pair = protocol.parsePublicReleasePair(raw.pair), identity = views.parseViewIdentity(raw.identity, pair);
const root = input.parsePublicReleasePairInputRoot(raw.root, pair);
if (protocol.publicReleaseDigest(root.scope) !== protocol.publicReleaseDigest({ kind: identity.kind,
  sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
  snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence })) throw new Error("Input scope differs");
const files = new Map(root.files.map(file => [file.name, file]));
const verifiedFiles = new Map<string, Uint8Array>();
let verifiedBytes = 0;
async function readFrozenFile(name: string) {
  const file = files.get(name);
  if (!file) throw new Error("Missing frozen dependency");
  const before = verifiedFiles.get(name);
  if (before) return new Uint8Array(before);
  const bytes = await readFile(path.join("/pair/inputs", name));
  if (bytes.byteLength !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("Frozen dependency differs");
  // This process sees one read-only task mount. Keep bounded, already verified
  // bytes; each independent projector still validates its original identities.
  if (bytes.length <= 1024 * 1024 && verifiedFiles.size < 128 && verifiedBytes + bytes.length <= 8 * 1024 * 1024) {
    verifiedFiles.set(name, new Uint8Array(bytes)); verifiedBytes += bytes.length;
  }
  return bytes;
}
async function read(name: string) { return JSON.parse(Buffer.from(await readFrozenFile(name)).toString("utf8")); }
const plans = await openPublicReleasePairRenderPlans(root, readFrozenFile), plan = plans.plan;
const provenance = plan.routes.some(route => isPublicReleasePairProjection(route.renderer)) ? await read(PAIR_REPLAY_PROVENANCE_FILE) : null;
const directory = fileURLToPath(new URL("../", import.meta.url));
childMark("inputMs");
await verifyPublicReleasePairRenderer(directory, pair);
childMark("compiledVerificationMs");
// The graph is sealed before import; neither templates nor projectors can make
// live provider requests. Each route gets only its own frozen resource map.
let resourceFetch: typeof fetch = async () => { throw new Error("Missing frozen resource"); };
globalThis.fetch = (...args) => resourceFetch(...args);
const now = new Date(plan.renderedAt), frozenTime = now.getTime();
// Templates that use Date.now/new Date share the captured render instant too.
const OriginalDate = Date;
globalThis.Date = new Proxy(OriginalDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [frozenTime]); },
  apply() { return new OriginalDate(frozenTime).toString(); },
  get(target, key) { return key === "now" ? () => frozenTime : Reflect.get(target, key); },
});
const renderer = await import(pathToFileURL(path.join(directory, "server/entry.mjs")).href);
if (renderer.rendererSha !== pair.commitSha) throw new Error("Renderer source differs");
childMark("rendererImportMs");
const targets = new Map<string, { receipt: Awaited<ReturnType<typeof projectPublicReleasePairReplay>>["receipt"]; status: number }>();
function useFrozenResources(request: PairRenderRequest) {
  const resources = new Map(request.resources.map(resource => [resource.url, resource]));
  resourceFetch = async (target, options) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    const resource = resources.get(url), method = options?.method ?? (target instanceof Request ? target.method : "GET");
    if (!resource || method !== "GET") throw new Error("Missing frozen resource");
    const packed = await read(resource.file);
    if (!packed || Object.keys(packed).join(",") !== "bodyBase64" || typeof packed.bodyBase64 !== "string") throw new Error("Invalid frozen resource");
    const body = Buffer.from(packed.bodyBase64, "base64");
    if (body.toString("base64") !== packed.bodyBase64) throw new Error("Invalid frozen resource encoding");
    return new Response(body, { headers: { "content-type": resource.contentType } });
  };
}
async function renderPlan(plan: typeof plans.ordinaryPlan, prefix: string) {
for (let index = 0; index < plan.routes.length; index++) {
  const route = plan.routes[index], expected = plan.expectedOutputs[index];
  const request = parsePublicReleasePairRenderRequest(await read(route.inputFile), route);
  useFrozenResources(request);
  const source = request.read as Record<string, any>;
  const homeSources = request.homeSourcesFile === null ? undefined : await read(request.homeSourcesFile);
  const replayContext = { pair, identity, route, request,
    provenance, inputDigest: files.get(route.inputFile)!.digest, provenanceDigest: files.get(PAIR_REPLAY_PROVENANCE_FILE)?.digest ?? "",
    renderedAt: plan.renderedAt, homeSources, readFrozenFile };
  const replay = isPublicReleasePairProjection(route.renderer) ? await projectPublicReleasePairReplay(replayContext) : null;
  if (replay && !targets.has(route.path)) targets.set(route.path, { receipt: replay.receipt, status: expected.status });
  let html: string | undefined, location: string | undefined;
  if (route.renderer === "post") {
    const slug = route.path.match(/^\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/)?.[1];
    if (!slug) throw new Error("Post route differs");
    const content = replay!.content;
    if (!content || content.target.pagePath !== route.path) throw new Error("Post input differs");
    const outbound = content.posts[0] && contentLinkRedirect(content.posts[0]);
    if ((expected.status === 302) !== Boolean(outbound)) throw new Error("Content link status differs");
    if (outbound) location = outbound.headers.get("location")!;
    else html = await renderer.renderPublishedPost(content);
  } else if (route.renderer === "page") {
    const content = replay!.content;
    if (content.target.pagePath !== route.path) throw new Error("Page route differs");
    const outbound = content.pages[0] && contentLinkRedirect(content.pages[0]);
    if ((expected.status === 302) !== Boolean(outbound)) throw new Error("Content link status differs");
    if (outbound) location = outbound.headers.get("location")!;
    else html = await renderer.renderPublicReleasePairProjection(replayContext, replay!.receipt);
  } else if (route.renderer === "context") {
    const content = replay!.content;
    if (content.target.pagePath !== route.path) throw new Error("Context route differs");
    const outbound = content.pages[0] && contentLinkRedirect(content.pages[0]);
    if ((expected.status === 302) !== Boolean(outbound)) throw new Error("Content link status differs");
    if (outbound) location = outbound.headers.get("location")!;
    else html = await renderer.renderPublicReleasePairProjection(replayContext, replay!.receipt);
  } else if (route.renderer === "record") {
    const content = replay!.content as import("../src/lib/published-record-render").PublishedRecordContent;
    if (!content) throw new Error("Record input differs");
    // The existing record projector supplies canonical paths and alias owners.
    if (expected.status === 308) {
      const records = content.target.family === "programs" ? content.programs : content.events;
      const record = records.find(record => ("programId" in record ? record.programId : record.eventId) === content.target.documentId);
      location = content.target.documentId === null && route.path === "/shows/" ? "/programs/" : record?.path;
      if (!location || location === route.path) throw new Error("Record alias differs");
    } else html = await renderer.renderPublicReleasePairProjection(replayContext, replay!.receipt);
  } else if (route.renderer === "redirect") {
    if (!source || source.kind !== "redirect" || source.path !== route.path || typeof source.location !== "string" ||
        !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(source.location) ||
        source.location.split("/").some((part: string) => part === "." || part === "..") || source.location === route.path) {
      throw new Error("Redirect input differs");
    }
    location = source.location;
  } else if (route.renderer === "json") {
    if (source === undefined || source === null) throw new Error("JSON input is missing");
    html = JSON.stringify(source);
  } else if (route.renderer === "withdrawal") {
    if (!source || source.kind !== "withdrawn" || source.path !== route.path) throw new Error("Withdrawal input differs");
  }
  const body = html === undefined ? Buffer.alloc(0) : Buffer.from(html);
  if (expected.status === 200 && !body.length || body.length > views.BODY_BYTES_LIMIT) throw new Error("Rendered output differs");
  await writeFile(`/preview/dist/${prefix}${index}.body`, body, { mode: 0o600, flag: "wx" });
  if (replay) await writeFile(`/preview/dist/${prefix}${index}.target.json`, JSON.stringify(replay.receipt), { mode: 0o600, flag: "wx" });
  if (location) await writeFile(`/preview/dist/${prefix}${index}.location`, location, { mode: 0o600, flag: "wx" });
}
}
await renderPlan(plans.ordinaryPlan, "");
if (plans.aggregatePlan) await renderPlan(plans.aggregatePlan, "aggregate-");
childMark("routesMs");
if (files.has("code-pack.json")) {
  const pack = parsePublicReleasePairCodePack(await read("code-pack.json"), pair), ownedPaths = new Set(plan.routes.map(route => route.path));
  const actions: Array<{ path: string; role: string; kind: string; status: number; mime: string; size: number; sha256: string; file: string;
    owner?: PairAuthorOwner; location?: string }> = [];
  const authorHtml: Array<{ path: string; file: string }> = [];
  resourceFetch = async () => { throw new Error("Author rendering cannot fetch mutable resources"); };
  for await (const author of renderer.renderPublicReleasePairAuthors({ pair, identity, root, readFrozenFile })) {
    if (ownedPaths.has(author.path) || author.body.length > views.BODY_BYTES_LIMIT) throw new Error("Author output differs");
    ownedPaths.add(author.path);
    const file = `aux-${actions.length}.body`;
    await writeFile(`/preview/dist/${file}`, author.body, { mode: 0o600, flag: "wx" });
    actions.push({ path: author.path, role: "auxiliary", kind: "author", status: author.status, mime: author.contentType,
      size: author.body.length, sha256: createHash("sha256").update(author.body).digest("hex"), file, owner: author.owner,
      ...(author.location === null ? {} : { location: author.location }) });
    if (author.status === 200) authorHtml.push({ path: author.path, file });
  }
  childMark("authorsMs");
  const expected = publicReleasePairRequiredBaselineMembers(pack, ownedPaths);
  if (!Array.isArray(raw.baselineFiles) || raw.baselineFiles.length !== expected.length) throw new Error("Frozen baseline is incomplete");
  const baselineFiles = new Map<string, { path: string; file: string; bytes: number; digest: string }>();
  for (let index = 0; index < expected.length; index++) {
    const value = raw.baselineFiles[index], member = expected[index];
    if (!value || Object.keys(value).sort().join() !== "bytes,digest,file,path" || value.path !== member.path || value.file !== `${index}.bin` ||
        value.bytes !== member.size || value.digest !== member.sha256) throw new Error("Frozen baseline differs");
    baselineFiles.set(value.path, value);
  }
  const readBaseline = async (path: string) => {
    const file = baselineFiles.get(path); if (!file) throw new Error("Frozen baseline missing");
    const bytes = await readFile(`/pair/baseline/${file.file}`);
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.digest) throw new Error("Frozen baseline differs");
    return new Uint8Array(bytes);
  };
  async function* html() {
    const entries = [...plans.selected.filter(value => value.output.status === 200 && value.output.contentType.startsWith("text/html")).map(value =>
      ({ path: value.route.path, read: async () => new Uint8Array(await readFile(`/preview/dist/${value.filePrefix}${value.index}.body`)) })),
    ...authorHtml.map(author => ({ path: author.path, read: async () => new Uint8Array(await readFile(`/preview/dist/${author.file}`)) })),
    ...expected.filter(member => member.mime.startsWith("text/html")).map(member => ({ path: publicReleasePairHtmlRoute(member.path), read: () => readBaseline(member.path) }))]
      .sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
    for (const entry of entries) yield { path: entry.path, bytes: await entry.read() };
  }
  let semanticPriorBytes: Uint8Array | undefined;
  if (raw.semanticPrior !== undefined) {
    try {
      const prior = raw.semanticPrior;
      if (!prior || Object.keys(prior).sort().join() !== "bytes,digest" || !Number.isSafeInteger(prior.bytes) || prior.bytes < 1 ||
          prior.bytes > views.BODY_BYTES_LIMIT || !/^[a-f0-9]{64}$/.test(prior.digest) || (await stat("/pair/semantic-prior.json")).size !== prior.bytes) throw new Error("Optional semantic input differs");
      const bytes = await readFile("/pair/semantic-prior.json");
      if (bytes.length !== prior.bytes || createHash("sha256").update(bytes).digest("hex") !== prior.digest) throw new Error("Optional semantic input differs");
      semanticPriorBytes = bytes;
    } catch { semanticPriorBytes = new Uint8Array(); } // A suspect optional cache triggers complete fresh inference.
  }
  const auxiliary = await renderPublicReleasePairAggregates({ pair, root, renderedAt: plan.renderedAt, readFrozenFile, readBaseline, semanticPriorBytes,
    html, targets: [...targets.values()], ownedPaths });
  childMark("aggregatesMs");
  for (let index = 0; index < auxiliary.files.length; index++) {
    const file = auxiliary.files[index], role = file.path.startsWith("/pagefind/") ? "search" : file.path.startsWith("/api/v1/content/") ? "content-feed" : "auxiliary";
    const kind = role === "search" ? "pagefind" : role === "content-feed" ? "content-feed-page" : composite.publicReleasePairCompositeAuxiliaryKind(file.path);
    if (!kind) throw new Error("Unexplained aggregate output");
    const outputFile = `aux-${actions.length}.body`;
    await writeFile(`/preview/dist/${outputFile}`, file.bytes, { mode: 0o600, flag: "wx" });
    actions.push({ path: file.path, role, kind, status: 200, mime: file.mime, size: file.bytes.length,
      sha256: createHash("sha256").update(file.bytes).digest("hex"), file: outputFile });
  }
  if (files.has(PAIR_STATIC_SOURCE_FILE)) {
    if (!Array.isArray(raw.staticAliases) || raw.staticAliases.length > views.VIEW_OUTPUT_LIMIT) throw new Error("Static alias inventory is missing");
    const aliases = []; let previous = "";
    for (let index = 0; index < raw.staticAliases.length; index++) {
      const alias = raw.staticAliases[index];
      if (!alias || Object.keys(alias).sort().join() !== "canonicalPath,collection,documentId,path" || typeof alias.path !== "string" ||
          alias.path <= previous) throw new Error("Static alias inventory differs");
      previous = alias.path; let body: Uint8Array;
      if (alias.collection === "cmsAuthorProfilesPublic") {
        resourceFetch = async () => { throw new Error("Static author aliases cannot fetch mutable resources"); };
        body = await renderer.renderPublicReleasePairStaticAuthorAlias({ pair, identity, root, readFrozenFile }, alias.path);
      } else {
        const aliasRoute = plan.routes.find(route => route.path === alias.path), canonicalRoute = plan.routes.find(route => route.path === alias.canonicalPath);
        if (!aliasRoute || !canonicalRoute || aliasRoute.renderer !== "redirect") throw new Error("Static alias request is missing");
        const request = parsePublicReleasePairRenderRequest(await read(canonicalRoute.inputFile), canonicalRoute);
        const aliasRequest = parsePublicReleasePairRenderRequest(await read(aliasRoute.inputFile), aliasRoute);
        const homeSources = request.homeSourcesFile === null ? undefined : await read(request.homeSourcesFile);
        const context = { pair, identity, route: canonicalRoute, request, homeSources, provenance,
          inputDigest: files.get(canonicalRoute.inputFile)!.digest, provenanceDigest: files.get(PAIR_REPLAY_PROVENANCE_FILE)!.digest,
          renderedAt: plan.renderedAt, readFrozenFile };
        useFrozenResources(request);
        const replay = await projectPublicReleasePairReplay(context);
        body = await renderer.renderPublicReleasePairStaticAlias(context, replay.receipt,
          { route: aliasRoute, request: aliasRequest, inputDigest: files.get(aliasRoute.inputFile)!.digest });
      }
      if (!body.length || body.length > views.BODY_BYTES_LIMIT) throw new Error("Static alias output differs");
      const file = `static-alias-${index}.body`;
      await writeFile(`/preview/dist/${file}`, body, { flag: "wx", mode: 0o600 });
      aliases.push({ path: alias.path, canonicalPath: alias.canonicalPath, file, bytes: body.length, digest: createHash("sha256").update(body).digest("hex") });
    }
    await writeFile("/preview/dist/static-aliases.json", JSON.stringify({ schemaVersion: 1, aliases }), { flag: "wx", mode: 0o600 });
  }
  childMark("auxiliaryOutputMs");
  await writeFile("/preview/dist/auxiliary.json", JSON.stringify({ schemaVersion: 1, actions,
    metrics: { ...auxiliary.metrics, child: { ...childTimings, totalMs: performance.now() - childStarted } } }), { mode: 0o600, flag: "wx" });
}
