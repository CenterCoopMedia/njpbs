import { setTimeout as pause } from "node:timers/promises";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export class FunctionsDeployInventoryError extends Error { name = "FunctionsDeployInventoryError"; }

const PROJECTS = new Set(["njpbs-site", "njpbs-site-dev"]);
const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function liveFunctionTrigger(event) {
  const eventFilters = {}, eventFilterPathPatterns = {};
  if (event != null && (typeof event !== "object" || Array.isArray(event) || typeof event.eventType !== "string" ||
      !event.eventType || !Array.isArray(event.eventFilters ?? []))) throw new FunctionsDeployInventoryError("Invalid live Functions trigger");
  for (const filter of event?.eventFilters ?? []) {
    if (!filter || typeof filter.attribute !== "string" || !filter.attribute || typeof filter.value !== "string") {
      throw new FunctionsDeployInventoryError("Invalid live Functions event filter");
    }
    if (filter.operator === "match-path-pattern") eventFilterPathPatterns[filter.attribute] = filter.value;
    else if (!filter.operator) eventFilters[filter.attribute] = filter.value;
    else throw new FunctionsDeployInventoryError("Invalid live Functions event filter");
  }
  if (event?.pubsubTopic && event.eventType === "google.cloud.pubsub.topic.v1.messagePublished") eventFilters.topic = event.pubsubTopic;
  if (event?.resource) eventFilters.resource = event.resource;
  return { eventType: event?.eventType, eventFilters, eventFilterPathPatterns, triggerRegion: event?.triggerRegion };
}

// Both APIs can return partial all-location inventories. Never approve force
// deployment from an unreachable region or an incomplete pagination walk.
export async function readFunctionsDeployInventory(projectId, request, { includeMetadata = false } = {}) {
  if (!PROJECTS.has(projectId)) throw new FunctionsDeployInventoryError("Invalid Functions inventory project");
  const functions = [];
  for (const version of ["v1", "v2"]) {
    const url = `https://cloudfunctions.googleapis.com/${version}/projects/${projectId}/locations/-/functions`;
    const seen = new Set();
    let pageToken;
    do {
      const page = await request(url, pageToken);
      if (!page || typeof page !== "object" || Array.isArray(page) ||
          Object.keys(page).some(key => !["functions", "unreachable", "nextPageToken"].includes(key)) ||
          !Array.isArray(page.functions ?? []) || !Array.isArray(page.unreachable ?? []) ||
          (page.unreachable ?? []).length ||
          (page.nextPageToken !== undefined && typeof page.nextPageToken !== "string")) {
        throw new FunctionsDeployInventoryError("Functions deployment inventory is incomplete");
      }
      for (const fn of page.functions ?? []) {
        const platform = version === "v1" || fn.environment === "GEN_1" ? "gcfv1" :
          fn.environment === "GEN_2" ? "gcfv2" : undefined;
        if (!platform) throw new FunctionsDeployInventoryError("Invalid live Functions platform");
        functions.push({ ...(includeMetadata ? { ...fn, inventoryApiVersion: version } : {}),
          name: fn.name, labels: fn.labels, platform, ...liveFunctionTrigger(fn.eventTrigger) });
      }
      pageToken = page.nextPageToken;
      if (pageToken && seen.has(pageToken)) throw new FunctionsDeployInventoryError("Repeated Functions inventory page");
      seen.add(pageToken);
    } while (pageToken);
  }
  return functions;
}

export function functionDeployManifest(names, source) {
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== "string" || !NAME.test(name)) ||
      new Set(names).size !== names.length || Object.keys(source).length !== names.length ||
      names.some(name => !Object.hasOwn(source, name))) throw new FunctionsDeployInventoryError("Functions source differs from the exact manifest");
  return names.flatMap(name => {
    const endpoint = source[name].__endpoint;
    const regions = endpoint?.region ?? ["us-central1"];
    if (!["gcfv1", "gcfv2"].includes(endpoint?.platform) || !Array.isArray(regions) ||
        !regions.length || regions.some(region => typeof region !== "string" || !/^[a-z]+-[a-z]+\d$/.test(region))) {
      throw new FunctionsDeployInventoryError("Invalid Functions source deployment identity");
    }
    const eventType = endpoint.eventTrigger?.eventType;
    if (endpoint.eventTrigger && (typeof eventType !== "string" || !eventType)) throw new FunctionsDeployInventoryError("Invalid Functions source trigger");
    return regions.map(region => ({ name, region, platform: endpoint.platform, ...(eventType ? {
      eventType, eventFilters: endpoint.eventTrigger.eventFilters ?? {},
      eventFilterPathPatterns: endpoint.eventTrigger.eventFilterPathPatterns ?? {},
      triggerRegion: endpoint.eventTrigger.region,
    } : {}) }));
  });
}

export function loadFunctionSource(projectId, root = new URL("../../", import.meta.url)) {
  if (!PROJECTS.has(projectId)) throw new FunctionsDeployInventoryError("Invalid Functions source project");
  const development = projectId === "njpbs-site-dev";
  const entry = development ? "dev-index.js" : "index.js";
  const pkg = JSON.parse(readFileSync(new URL("functions/package.json", root), "utf8"));
  const config = JSON.parse(readFileSync(new URL(development ? "firebase.dev.json" : "firebase.json", root), "utf8"));
  if (pkg.main !== entry || config.functions?.source !== "functions" ||
      config.functions?.codebase !== (development ? "dev" : "default")) {
    throw new FunctionsDeployInventoryError("Functions source entry point or codebase differs");
  }
  // SDK discovery needs the same project tuple as the actual Firebase deploy.
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  return createRequire(import.meta.url)(fileURLToPath(new URL(`functions/${entry}`, root)));
}

export function loadFunctionDeployManifest(names, projectId, root = new URL("../../", import.meta.url)) {
  return functionDeployManifest(names, loadFunctionSource(projectId, root));
}

function assertSameFunctionTrigger(source, live, projectId) {
  if (source.eventType !== live.eventType) throw new FunctionsDeployInventoryError("Functions deployment would change a live trigger type");
  const filters = { ...(source.eventFilters ?? {}) };
  if (typeof filters.topic === "string" && !filters.topic.startsWith("projects/")) {
    filters.topic = `projects/${projectId}/topics/${filters.topic}`;
  }
  if (!isDeepStrictEqual(filters, live.eventFilters ?? {}) ||
      !isDeepStrictEqual(source.eventFilterPathPatterns ?? {}, live.eventFilterPathPatterns ?? {}) ||
      (source.triggerRegion !== undefined && source.triggerRegion !== live.triggerRegion)) {
    throw new FunctionsDeployInventoryError("Functions deployment would change live trigger routing");
  }
}

export function assertNoFunctionDeletions(manifest, functions, { projectId, codebase, only }) {
  const expectedCodebase = projectId === "njpbs-site-dev" ? "dev" : "default";
  if (!PROJECTS.has(projectId) || codebase !== expectedCodebase || !Array.isArray(manifest) || !manifest.length ||
      manifest.some(fn => !fn || typeof fn.name !== "string" || !NAME.test(fn.name) ||
        typeof fn.region !== "string" || !/^[a-z]+-[a-z]+\d$/.test(fn.region) || !["gcfv1", "gcfv2"].includes(fn.platform) ||
        (fn.eventType !== undefined && (typeof fn.eventType !== "string" || !fn.eventType))) ||
      !Array.isArray(functions)) throw new FunctionsDeployInventoryError("Invalid Functions deployment manifest");
  if (only !== undefined && (projectId !== "njpbs-site" || !Array.isArray(only) || !only.length ||
      only.some(name => typeof name !== "string" || !NAME.test(name) ||
        (name !== codebase && !manifest.some(fn => fn.name === name))))) {
    throw new FunctionsDeployInventoryError("Invalid Functions deployment filter");
  }
  const desired = new Map(manifest.map(fn => [`${fn.name}:${fn.region}:${fn.platform}`, fn]));
  if (desired.size !== manifest.length) throw new FunctionsDeployInventoryError("Duplicate Functions deployment identity");
  for (const fn of functions) {
    const match = fn?.name?.match(/^projects\/([^/]+)\/locations\/([^/]+)\/functions\/([A-Za-z][A-Za-z0-9-]*)$/);
    if (!match || match[1] !== projectId || !["gcfv1", "gcfv2"].includes(fn.platform) ||
        (fn.labels !== undefined && (!fn.labels || typeof fn.labels !== "object" || Array.isArray(fn.labels)))) {
      throw new FunctionsDeployInventoryError("Invalid live Functions deployment identity");
    }
    const liveCodebase = fn.labels?.["firebase-functions-codebase"] ?? "default";
    if (typeof liveCodebase !== "string" || !liveCodebase) throw new FunctionsDeployInventoryError("Invalid live Functions codebase");
    if (liveCodebase !== codebase) continue;
    // Firebase's single-name filters also select a same-name group (name-*).
    // Out-of-filter Functions cannot be deleted by this forced batch; their
    // explicit retirement remains the workflow's separate operation.
    if (only && !only.includes(codebase) && !only.includes(match[3].split("-")[0])) continue;
    if (!desired.has(`${match[3]}:${match[2]}:${fn.platform}`)) {
      throw new FunctionsDeployInventoryError("Functions deployment would delete or rename a live function");
    }
    const source = desired.get(`${match[3]}:${match[2]}:${fn.platform}`);
    assertSameFunctionTrigger(source, fn, projectId);
  }
}

export async function requestDeploymentInventory(client, url, pageToken, wait = pause) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Bound retries here instead of multiplying them with the HTTP client's.
      return (await client.request({ url, method: "GET", params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) }, retry: false })).data;
    } catch (error) {
      const value = error?.response?.status ?? error?.status;
      const status = Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
      const retryable = !error?.response || status === 429 || (status >= 500 && status <= 599);
      if (attempt === attempts || !retryable) {
        // Provider errors can contain response bodies and authorization headers.
        const code = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"].includes(error?.code)
          ? error.code : Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 999 ? error.code : undefined;
        throw new Error(`Could not verify deployed function inventory (${status !== undefined ? `HTTP ${status}`
          : code !== undefined ? `code ${code}` : "HTTP unavailable"}, attempt ${attempt} of ${attempts})`);
      }
      await wait(attempt * 1000);
    }
  }
}
