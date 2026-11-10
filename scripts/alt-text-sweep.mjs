#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseBrowserCredential } from "./cms-debug-browser.mjs";
import postLeadMedia from "../functions/lib/post-lead-media.js";
const { readPostLeadMedia } = postLeadMedia;

const DEFAULT_BASE_URL = "https://api.example.org"; // scripts/smoke-cms-functions.mjs
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ALLOWED_ENDPOINTS = new Set([
  "cmsListMedia", "cmsUpdateMediaMetadata", "cmsListContent", "cmsGetContent", "cmsSaveContent",
]);
const SAVABLE_STATUSES = new Set(["draft", "published"]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const empty = value => value == null || (typeof value === "string" && !value.trim());
const brief = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 600) : "";
class SkipImage extends Error {}
class ReportWriteError extends Error {}

export function parseArgs(argv) {
  const options = { apply: false, maxCalls: 120, report: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--dry-run") options.apply = false;
    else if (argv[i] === "--max-calls" && /^\d+$/.test(argv[i + 1] ?? "")) options.maxCalls = Number(argv[++i]);
    else if (argv[i] === "--report" && argv[i + 1]) options.report = argv[++i];
    else throw new Error("invalid_arguments");
  }
  if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1) throw new Error("invalid_arguments");
  return options;
}

// The report records only these rule names, never the model's text.
function invalidReply(detail) {
  const error = new Error("invalid_model_reply");
  error.detail = detail;
  return error;
}

function parseJson(text) {
  try { return JSON.parse(text); }
  catch { throw invalidReply("not_json"); }
}

export function parseModelReply(output) {
  let value = typeof output === "string" ? parseJson(output) : output;
  // Current Claude Code prints the whole event list for --output-format json;
  // the answer is in its final result event.
  if (Array.isArray(value)) value = value.findLast(event => isObject(event) && event.type === "result");
  if (isObject(value) && value.is_error === true) throw invalidReply("cli_error");
  if (isObject(value) && typeof value.result === "string") {
    value = parseJson(value.result.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  }
  if (!isObject(value) || typeof value.alt !== "string" || typeof value.description !== "string" ||
      typeof value.people !== "boolean") throw invalidReply("missing_fields");
  if (!value.alt.trim()) throw invalidReply("alt_empty");
  if (value.alt.length > 125) throw invalidReply("alt_too_long");
  if (/[\r\n]/.test(value.alt)) throw invalidReply("alt_line_break");
  if (value.description.length > 400) throw invalidReply("description_too_long");
  // Names cannot be detected reliably from free text. The prompt forbids them; staff review is required.
  return { alt: value.alt.trim(), description: value.description.trim(), people: value.people };
}

// A reply that broke one of these rules gets one retry that restates the rule.
const RETRY_NOTES = {
  alt_too_long: "Your previous alt text was longer than 125 characters. Keep alt text under 100 characters.",
  alt_line_break: "Your previous alt text had a line break. Write alt text as one line.",
  description_too_long: "Your previous description was longer than 400 characters. Keep the description under 300 characters.",
};

export async function claudeModel({ imagePath, title, context, retryNote = "" }, runCli = execFile) {
  const prompt = `Read the image at ${JSON.stringify(imagePath)} with the Read tool. Return only JSON with keys alt, description, people. Alt must be at most 125 characters; aim for 100 or fewer. Description must be at most 400 characters; aim for 300 or fewer. people is a boolean. Describe only what is visible. Never name or guess the identity of a person, even if the title or context names them. Use generic descriptions of people, their actions, clothing, and setting. Do not include a person's name in either text field. Document title: ${JSON.stringify(brief(title))}. Nearby text: ${JSON.stringify(brief(context))}.${retryNote ? ` ${retryNote}` : ""}`;
  const stdout = await new Promise((resolve, reject) => {
    const child = runCli("claude", ["-p", "--model", "claude-opus-5-5", "--effort", "medium", "--output-format", "json",
      "--restricted", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none",
      "--tools", "Read", "--allowedTools", "Read"],
      { cwd: dirname(imagePath), timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
      (error, output) => error ? reject(error) : resolve(output));
    child.stdin.end(prompt);
  });
  return parseModelReply(stdout);
}

export function createCmsClient({ fetchImpl, credential, apiKey, baseUrl = DEFAULT_BASE_URL, now = Date.now }) {
  if (!apiKey || !/^https?:\/\//.test(baseUrl)) throw new Error("invalid_configuration");
  let session;
  async function token() {
    if (session && now() < session.expiresAt - 60_000) return session.idToken;
    const refresh = Boolean(session);
    const url = refresh
      ? `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`
      : `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, refresh
      ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }), signal: AbortSignal.timeout(30_000) }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...credential, returnSecureToken: true }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error("authentication_failed");
    const data = await response.json();
    const idToken = data.idToken ?? data.id_token;
    const refreshToken = data.refreshToken ?? data.refresh_token;
    const expiresIn = Number(data.expiresIn ?? data.expires_in);
    if (!idToken || !refreshToken || !Number.isFinite(expiresIn)) throw new Error("authentication_failed");
    session = { idToken, refreshToken, expiresAt: now() + expiresIn * 1000 };
    return idToken;
  }
  return async function call(endpoint, body, headers = {}) {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) throw new Error("endpoint_not_allowed");
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}`, ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = new Error(`cms_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}

function imageUrl(asset) {
  const thumbnails = asset.thumbnails;
  if (thumbnails && typeof thumbnails === "object") {
    const entries = Array.isArray(thumbnails) ? thumbnails : Object.values(thumbnails);
    const candidates = entries.map(item => typeof item === "string" ? { url: item, width: 960 } : item)
      .filter(item => isObject(item) && typeof item.url === "string" && /^https?:\/\//.test(item.url))
      .filter(item => item.width === undefined || (Number.isFinite(Number(item.width)) && Number(item.width) >= 320));
    candidates.sort((a, b) => Math.abs(Number(a.width ?? 960) - 960) - Math.abs(Number(b.width ?? 960) - 960));
    if (candidates.length) return candidates[0].url;
  }
  return asset.url;
}

export async function downloadImage(asset, { fetchImpl, tempRoot = tmpdir() }) {
  const url = imageUrl(asset);
  if (url === asset.url && Number(asset.sizeBytes) > MAX_IMAGE_BYTES) throw new SkipImage("image_too_large");
  if (url === asset.url && !IMAGE_TYPES.has(asset.mimeType)) throw new SkipImage("unsupported_image_type");
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("invalid_image_url");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("image_download_failed");
  const type = (response.headers.get("content-type") || asset.mimeType || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) { await response.body.cancel(); throw new SkipImage("unsupported_image_type"); }
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    throw new SkipImage("image_too_large");
  }
  const dir = await mkdtemp(join(tempRoot, "njpbs-alt-"));
  const extension = type.includes("webp") ? "webp" : type.includes("png") ? "png" : type.includes("gif") ? "gif" : "jpg";
  const path = join(dir, `image.${extension}`);
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > MAX_IMAGE_BYTES ? new SkipImage("image_too_large") : null, chunk);
    } }), createWriteStream(path, { mode: 0o600 }));
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// Mirrors the recommended alt fields in editor-admin.ts and missingAltTextCount.
// card_grid has an image but no alt field, so no valid field exists for this sweep to fill.
export function findImageUses(collection, document) {
  const uses = [];
  const add = (holder, altKey, assetKey, decorativeKey, path, context) => {
    if (isObject(holder) && typeof holder[assetKey] === "string" && holder[assetKey] &&
        empty(holder[altKey]) && holder[decorativeKey] !== true) {
      uses.push({ holder, altKey, assetId: holder[assetKey], path, context: brief(context) });
    }
  };
  if (collection === "cmsPosts") {
    if (document.type === "post") {
      if (document.leadMedia === undefined)
        add(document, "heroImageAlt", "heroImage", "heroImageDecorative", "heroImageAlt", document.heroImageCaption || document.excerpt);
      else {
        const lead = readPostLeadMedia(document);
        if (lead?.kind === "image") add(lead.data, "alt", "assetId", "altDecorative", "leadMedia.data.alt", lead.data.caption || document.excerpt);
      }
    }
    if (document.type === "sponsor") add(document, "logoAlt", "logoAssetId", "logoDecorative", "logoAlt", document.name);
  }
  const hero = document.homeHero;
  if (isObject(hero) && hero.mode === "manual" && Array.isArray(hero.items)) {
    const seen = new Set();
    let shown = 0;
    for (const [index, item] of hero.items.entries()) {
      if (!isObject(item) || !brief(item.title) || !validHeroHref(item.href) || seen.has(item.href)) continue;
      seen.add(item.href);
      if (++shown > (hero.limit ?? 10)) break;
      add(item, "alt", "imageAssetId", "altDecorative", `homeHero.items[${index}].alt`, `${item.title} ${item.summary ?? ""}`);
    }
  }
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  let heading = "";
  for (const [index, block] of blocks.entries()) {
    if (!isObject(block) || block.visible === false || !isObject(block.data)) continue;
    if (block.type === "headline") heading = brief(block.data.text);
    const data = block.data;
    if (block.type === "image") add(data, "alt", "assetId", "altDecorative", `blocks[${index}].data.alt`, `${heading} ${data.caption ?? ""}`);
    const listKey = block.type === "image_gallery" ? "images" : block.type === "promotion_playlist" ? "cards" : null;
    if (listKey && Array.isArray(data[listKey])) {
      for (const [itemIndex, item] of data[listKey].entries()) {
        add(item, "alt", block.type === "image_gallery" ? "assetId" : "imageAssetId", "altDecorative",
          `blocks[${index}].data.${listKey}[${itemIndex}].alt`, `${heading} ${item?.caption ?? item?.title ?? ""} ${item?.summary ?? ""}`);
      }
    }
  }
  return uses;
}

function validHeroHref(value) {
  if (typeof value !== "string" || /[\s\\]/.test(value) || !/^(https?:\/\/|\/(?!\/))/.test(value)) return false;
  try { const url = new URL(value, "https://njpbs.org"); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

export async function runSweep({ apply = false, maxCalls = 120, call, model = claudeModel, fetchImpl = fetch, tempRoot = tmpdir(), onProgress = async () => {} }) {
  const report = { mode: apply ? "apply" : "dry_run", modelCalls: 0, assetsScanned: 0, documentsScanned: 0,
    changes: [], skipped: [], errors: [], stopped: null };
  let consecutiveErrors = 0;
  const failed = (target, error) => {
    if (error instanceof ReportWriteError) throw error;
    const safeReasons = new Set(["invalid_model_reply", "invalid_image_url", "image_download_failed", "image_too_large", "authentication_failed"]);
    const reason = error?.status ? `cms_${error.status}` : safeReasons.has(error?.message) ? error.message : "operation_failed";
    report.errors.push(reason === "invalid_model_reply" && error.detail ? { target, reason, detail: error.detail } : { target, reason });
    if (++consecutiveErrors >= 3) report.stopped = "three_consecutive_errors";
  };
  const succeeded = () => { consecutiveErrors = 0; };
  const canContinue = () => !report.stopped && report.modelCalls < maxCalls;
  async function suggest(asset, title, context) {
    const image = await downloadImage(asset, { fetchImpl, tempRoot });
    try {
      try { report.modelCalls++; return parseModelReply(await model({ imagePath: image.path, title, context })); }
      catch (error) {
        const retryNote = RETRY_NOTES[error?.detail];
        if (!retryNote || report.modelCalls >= maxCalls) throw error;
        report.modelCalls++;
        return parseModelReply(await model({ imagePath: image.path, title, context, retryNote }));
      }
    } finally { await image.cleanup(); }
  }
  const assets = new Map();
  for (let page = 1; canContinue(); page++) {
    let listing;
    try { listing = await call("cmsListMedia", { kinds: ["image"], sort: "createdAt", direction: "asc", page }); }
    catch (error) { failed(`media page ${page}`, error); break; }
    for (const asset of listing.records ?? []) {
      if (!canContinue()) break;
      if (asset?.lifecycle !== "active" || asset.kind !== "image" ||
          asset.altDecorative === true || asset.decorative === true) continue;
      assets.set(asset.id, asset);
      report.assetsScanned++;
      if (!empty(asset.altText)) continue;
      try {
        const reply = await suggest(asset, asset.name, asset.description);
        const metadata = { altText: reply.alt, altTextGenerated: true };
        if (empty(asset.description) && reply.description) metadata.description = reply.description;
        if (apply) {
          try { await call("cmsUpdateMediaMetadata", { assetId: asset.id, metadata }, { "If-Match": asset.etag }); }
          catch (error) {
            if (error.status === 412) { report.skipped.push({ assetId: asset.id, reason: "etag_conflict" }); continue; }
            throw error;
          }
        }
        report.changes.push({ assetId: asset.id, fieldPath: "altText", oldValue: asset.altText ?? "", newText: reply.alt });
        if (metadata.description) report.changes.push({ assetId: asset.id, fieldPath: "description", oldValue: asset.description ?? "", newText: reply.description });
        await onProgress(report);
        succeeded();
      } catch (error) {
        if (error instanceof SkipImage) report.skipped.push({ assetId: asset.id, reason: error.message });
        else failed(`asset ${asset.id}`, error);
      }
    }
    if (page >= (listing.pageCount ?? 1)) break;
  }
  if (!canContinue()) { if (!report.stopped) report.stopped = "max_calls"; return report; }

  const documents = [];
  try {
    const pages = await call("cmsListContent", { view: "pages" });
    for (const page of pages.pages ?? []) documents.push({ collection: "cmsPages", id: page.id, title: page.title });
    for (let page = 1; ; page++) {
      const list = await call("cmsListContent", { query: `v=1&page=${page}` });
      for (const record of list.records ?? []) documents.push({ collection: "cmsPosts", id: record.id, title: record.title });
      if (page >= (list.pageCount ?? 1)) break;
    }
  } catch (error) { failed("content list", error); return report; }
  for (const item of documents) {
    if (!canContinue()) break;
    try {
      const response = await call("cmsGetContent", { collection: item.collection, id: item.id });
      if (!response.found || !isObject(response.document)) continue;
      const document = response.document;
      report.documentsScanned++;
      // A save to a draft stays a draft. A save to a published document starts a
      // draft revision and leaves the public page unchanged until staff publish it.
      // In review, approved and scheduled content is skipped, so reviewed text
      // never changes after its review.
      if (!SAVABLE_STATUSES.has(document.status)) {
        report.skipped.push({ collection: item.collection, id: item.id, reason: "reviewed_or_scheduled_status", status: document.status ?? "unknown" });
        continue;
      }
      const pending = [];
      for (const use of findImageUses(item.collection, document)) {
        if (!canContinue()) break;
        try {
          let asset = assets.get(use.assetId);
          if (!asset) {
            const found = await call("cmsListMedia", { assetIds: [use.assetId] });
            asset = found.records?.find(row => row.id === use.assetId && row.kind === "image" && row.lifecycle === "active");
            if (asset) assets.set(asset.id, asset);
          }
          if (!asset || asset.altDecorative === true || asset.decorative === true) {
            report.skipped.push({ collection: item.collection, id: item.id, fieldPath: use.path, reason: "image_unavailable_or_decorative" });
            continue;
          }
          const reply = await suggest(asset, document.title ?? item.title, use.context);
          pending.push({ ...use, alt: reply.alt });
          succeeded();
        } catch (error) {
          if (error instanceof SkipImage) report.skipped.push({ collection: item.collection, id: item.id, fieldPath: use.path, reason: error.message });
          else failed(`${item.collection}/${item.id}/${use.path}`, error);
          if (report.stopped) break;
        }
      }
      if (pending.length && !report.stopped) {
        const changes = pending.map(use => ({ collection: item.collection, id: item.id, fieldPath: use.path, oldValue: use.holder[use.altKey] ?? "", newText: use.alt }));
        if (apply) {
          if (!Number.isSafeInteger(document.version) || document.version < 1) {
            report.skipped.push({ collection: item.collection, id: item.id, reason: "missing_version" });
            continue;
          }
          const overlay = {};
          for (const use of pending) {
            use.holder[use.altKey] = use.alt;
            if (use.path.startsWith("blocks[")) overlay.blocks = document.blocks;
            else if (use.path.startsWith("homeHero.")) overlay.homeHero = document.homeHero;
            else if (use.path.startsWith("leadMedia.")) overlay.leadMedia = document.leadMedia;
            else overlay[use.altKey] = use.alt;
          }
          try { await call("cmsSaveContent", { collection: item.collection, id: item.id, baseVersion: document.version, document: overlay }); }
          catch (error) {
            if (error.status === 409) { report.skipped.push({ collection: item.collection, id: item.id, reason: "version_conflict" }); continue; }
            throw error;
          }
        }
        report.changes.push(...changes);
        await onProgress(report);
      }
    } catch (error) { failed(`${item.collection}/${item.id}`, error); }
  }
  if (!report.stopped && report.modelCalls >= maxCalls) report.stopped = "max_calls";
  return report;
}

async function readCredential() {
  if (process.stdin.isTTY) throw new Error("invalid_credential");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024) throw new Error("invalid_credential");
  }
  return parseBrowserCredential(input);
}

async function main() {
  let lock;
  const lockPath = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "njpbs-alt-text-sweep.lock");
  try {
    const options = parseArgs(process.argv.slice(2));
    lock = await open(lockPath, "wx", 0o600);
    await lock.writeFile(String(process.pid));
    const persist = async report => {
      if (!options.report) return;
      const tempPath = `${options.report}.tmp-${process.pid}`;
      try {
        await writeFile(tempPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        await rename(tempPath, options.report);
      } catch { throw new ReportWriteError("report_write_failed"); }
    };
    // Check the report destination before any CMS write, then replace it atomically
    // after each committed change so an interrupted apply keeps a useful record.
    await persist({ mode: options.apply ? "apply" : "dry_run", changes: [], skipped: [], errors: [], state: "starting" });
    const credential = await readCredential();
    const call = createCmsClient({ fetchImpl: fetch, credential, apiKey: process.env.NJPBS_FIREBASE_WEB_API_KEY,
      baseUrl: process.env.VITE_FUNCTIONS_BASE_URL || DEFAULT_BASE_URL });
    const report = await runSweep({ ...options, call, onProgress: persist });
    if (options.report) await persist(report);
    else process.stdout.write(`${JSON.stringify(report)}\n`);
    process.stdout.write(`Alt-text sweep: ${report.mode}, ${report.modelCalls} model calls, ${report.changes.length} field changes, ${report.skipped.length} skipped, ${report.errors.length} errors${report.stopped ? `, stopped: ${report.stopped}` : ""}.\n`);
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Alt-text sweep failed: ${["invalid_arguments", "invalid_credential", "invalid_configuration", "EEXIST"].includes(error?.code || error?.message) ? error.code || error.message : "run_error"}.\n`);
    process.exitCode = 1;
  } finally {
    if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
