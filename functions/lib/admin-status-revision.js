"use strict";

const ADMIN_STATUS_URL = "https://admin.njpbs.org/admin-status.json";
const BUILD_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const MAX_ADMIN_STATUS_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;

class AdminStatusRevisionError extends Error {
  constructor(message = "The deployed Admin revision could not be read") {
    super(message);
    this.name = "AdminStatusRevisionError";
    this.status = 503;
  }
}

function parseProductionAdminRevision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminStatusRevisionError();
  }
  if (value.schemaVersion !== 2) throw new AdminStatusRevisionError();
  if (value.environment !== "Production") throw new AdminStatusRevisionError();
  if (value.status !== "current") throw new AdminStatusRevisionError();
  const revision = value.build?.revision;
  if (typeof revision !== "string" || !BUILD_REVISION_PATTERN.test(revision)) {
    throw new AdminStatusRevisionError();
  }
  return revision;
}

async function readResponseBytes(response) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ADMIN_STATUS_BYTES) {
    throw new AdminStatusRevisionError();
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new AdminStatusRevisionError();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_ADMIN_STATUS_BYTES) throw new AdminStatusRevisionError();
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function readLiveAdminBuildRevision(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = deps.url ?? ADMIN_STATUS_URL;
  let response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AdminStatusRevisionError();
  }
  if (!response || response.ok !== true) throw new AdminStatusRevisionError();
  let payload;
  try {
    payload = JSON.parse((await readResponseBytes(response)).toString("utf8"));
  } catch (error) {
    if (error instanceof AdminStatusRevisionError) throw error;
    throw new AdminStatusRevisionError();
  }
  return parseProductionAdminRevision(payload);
}

module.exports = {
  ADMIN_STATUS_URL,
  AdminStatusRevisionError,
  parseProductionAdminRevision,
  readLiveAdminBuildRevision,
};
