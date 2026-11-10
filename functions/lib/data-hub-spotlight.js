"use strict";
/* eslint-disable no-control-regex -- reject control characters at the remote boundary. */
const { parseReportingMapping, reportingStoryUrl } = require("./data-hub-reporting");
const ORIGIN = "https://www.njspotlightnews.org/wp-json/wp/v2/";
const termCache = new Map();
const { reportingQueryKey, reportingPinsKey, parseSpotlightReportingSnapshot } = require("./data-hub-reporting-sources");
const queryIdentity = mapping => ({ tags: mapping.spotlight.tags.map(term => term.id).sort((a,b) => a-b),
  categories: mapping.spotlight.categories.map(term => term.id).sort((a,b) => a-b),
  exclude: mapping.hidden.filter(item => item.source === "spotlight").map(item => Number(item.id)).sort((a,b) => a-b) });
function plainText(value, max) {
  if (typeof value !== "string" || value.length > max * 10) return null;
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…" };
  const decoded = value.replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const cp = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
  }).replace(/\s+/g, " ").trim();
  return decoded && decoded.length <= max && !/[\u0000-\u001f\u007f]/.test(decoded) ? decoded : null;
}
async function readJson(resource, params, { fetchImpl = fetch, signal, budget = { bytes: 0 } } = {}) {
  const url = new URL(resource, ORIGIN);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  let reader;
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", signal: deadline,
      headers: { Accept: "application/json", "User-Agent": "njpbs.org Data Hub reporting" } });
    if (!response.ok || Number(response.headers.get("content-length")) > 256 * 1024 || !response.body) { await response.body?.cancel(); throw new Error("unavailable"); }
    reader = response.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; budget.bytes += value.length;
      if (size > 256 * 1024 || budget.bytes > 2 * 1024 * 1024) throw new Error("bound");
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(result) || result.length > 100) throw new Error("shape");
    return result;
  } catch { throw new Error("Spotlight reporting is unavailable."); }
  finally { if (reader) await reader.cancel().catch(() => {}); }
}
function projectStories(rows, now) {
  const seen = new Set();
  return rows.flatMap(row => {
    const title = plainText(row?.title?.rendered, 300); const href = reportingStoryUrl(row?.link);
    const instant = typeof row?.date_gmt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(row.date_gmt) ? `${row.date_gmt}Z` : "";
    const at = Date.parse(instant);
    const terms = value => Array.isArray(value) && value.length <= 500 && value.every(id => Number.isSafeInteger(id) && id > 0);
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || seen.has(row.id) || !title || !href || !href.startsWith("https://www.njspotlightnews.org/") ||
        !Number.isFinite(at) || at > now || new Date(at).toISOString().slice(0, 19) !== row.date_gmt || !terms(row.tags) || !terms(row.categories)) return [];
    seen.add(row.id);
    return [{ source: "spotlight", id: String(row.id), href, title, publishedAt: new Date(at).toISOString(), tags: [...new Set(row.tags)], categories: [...new Set(row.categories)] }];
  });
}
async function readSpotlightTerms(taxonomy, search, { fetchImpl = fetch, clock = Date.now, signal } = {}) {
  if (!["tags", "categories"].includes(taxonomy) || typeof search !== "string" || search.trim().length < 2 || search.length > 80 || /[\u0000-\u001f\u007f]/.test(search)) {
    throw Object.assign(new Error("Enter a term name from 2 to 80 characters."), { status: 400 });
  }
  const query = search.trim();
  const key = `${taxonomy}:${query.toLowerCase()}`;
  const cached = termCache.get(key); if (cached && cached.expires > clock()) return structuredClone(cached.value);
  const fields = { per_page: 20, _fields: "id,name,slug" };
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const id = /^\d+$/.test(query) ? Number(query) : null;
  const exactQueries = [];
  if (Number.isSafeInteger(id) && id > 0) exactQueries.push({ include: id });
  if (slug) exactQueries.push({ slug });
  // Exact lookups are optional; ordinary search keeps its existing failure behavior.
  let exactFailed = false;
  const exactReads = exactQueries.map(async params => {
    try {
      const rows = await readJson(taxonomy, { ...fields, ...params }, { fetchImpl, signal });
      return rows.filter(row => params.include ? row?.id === params.include : row?.slug === params.slug);
    } catch { exactFailed = true; return []; }
  });
  const results = await Promise.all([...exactReads,
    readJson(taxonomy, { ...fields, search: query }, { fetchImpl, signal })]);
  const seen = new Set();
  const rows = results.flat();
  const terms = rows.flatMap(row => {
    const label = plainText(row?.name, 200);
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || !label || typeof row.slug !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || row.slug.length > 200 || seen.has(row.id)) return [];
    seen.add(row.id);
    return [{ id: row.id, slug: row.slug, label }];
  }).slice(0, 20);
  if (!exactFailed) {
    if (termCache.size >= 128) termCache.delete(termCache.keys().next().value);
    termCache.set(key, { expires: clock() + 15 * 60_000, value: terms });
  }
  return structuredClone(terms);
}

/** The existing external-refresh owner supplies the only scheduled writer. */
async function refreshSpotlightReporting(mappings, previous, { fetchImpl = fetch, clock = Date.now, signal } = {}) {
  if (!Array.isArray(mappings) || mappings.length > 19) throw new Error("Reporting mappings exceed their bound.");
  mappings.forEach(parseReportingMapping);
  previous = parseSpotlightReportingSnapshot(previous);
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  const budget = { bytes: 0 }; const queries = {};
  const unique = [...new Map(mappings.map(mapping => [reportingQueryKey(mapping), mapping])).entries()];
  const pins = [...new Set(mappings.flatMap(mapping => mapping.pins.filter(pin => pin.source === "spotlight").map(pin => Number(pin.id))))].sort((a, b) => a - b);
  const pinKey = reportingPinsKey(mappings); let pinResult = { key: pinKey, checkedAt: null, failed: false, stories: [] };
  const fields = "id,link,date_gmt,title,categories,tags";
  const work = unique.map(([key, mapping]) => async () => {
    const query = queryIdentity(mapping);
    if (!query.tags.length && !query.categories.length) { queries[key] = { checkedAt: new Date(clock()).toISOString(), failed: false, stories: [] }; return; }
    try {
      const rows = await readJson("posts", { status: "publish", orderby: "date", order: "desc", per_page: 25, tax_relation: "OR",
        tags: query.tags.join(","), categories: query.categories.join(","), exclude: query.exclude.join(","), _fields: fields }, { fetchImpl, signal: deadline, budget });
      const stories = projectStories(rows, clock()).filter(story => !query.exclude.includes(Number(story.id)) &&
        (story.tags.some(id => query.tags.includes(id)) || story.categories.some(id => query.categories.includes(id))));
      queries[key] = { checkedAt: new Date(clock()).toISOString(), failed: false, stories };
    } catch { queries[key] = { checkedAt: previous?.queries?.[key]?.checkedAt ?? null, failed: true, stories: previous?.queries?.[key]?.stories ?? [] }; }
  });
  if (pins.length) work.push(async () => {
    try {
      const rows = await readJson("posts", { status: "publish", per_page: 100, include: pins.join(","), _fields: fields }, { fetchImpl, signal: deadline, budget });
      pinResult = { key: pinKey, checkedAt: new Date(clock()).toISOString(), failed: false, stories: projectStories(rows, clock()).filter(story => pins.includes(Number(story.id))) };
    } catch { pinResult = { key: pinKey, checkedAt: previous?.pins?.key === pinKey ? previous.pins.checkedAt : null, failed: true,
      stories: previous?.pins?.key === pinKey ? previous.pins.stories : [] }; }
  });
  for (let offset = 0; offset < work.length; offset += 2) await Promise.all(work.slice(offset, offset + 2).map(run => run()));
  return { schemaVersion: 1, queries: Object.fromEntries(Object.entries(queries).sort(([a], [b]) => a.localeCompare(b))), pins: pinResult };
}
module.exports = { readSpotlightTerms, refreshSpotlightReporting, reportingQueryKey, plainText, projectStories };
