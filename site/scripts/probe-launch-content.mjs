import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://media.services.pbs.org/api/v1/";
const DEFAULT_OUTPUT_PATH = ".cache/launch-content/media-manager-probe.json";

export function buildBasicAuthHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
}

export function buildProbeConfig(env = process.env) {
  const key = env.MEDIA_MANAGER_API_KEY;
  const secret = env.MEDIA_MANAGER_API_SECRET;

  if (!key || !secret) {
    throw new Error("MEDIA_MANAGER_API_KEY and MEDIA_MANAGER_API_SECRET are required");
  }

  const baseUrl = optionalEnv(env.MEDIA_MANAGER_BASE_URL) ?? DEFAULT_BASE_URL;
  const audience = optionalEnv(env.MEDIA_MANAGER_AUDIENCE) ?? "WNJT";
  const pageSize = optionalEnv(env.MEDIA_MANAGER_PAGE_SIZE) ?? "25";
  const url = new URL("shows/", ensureTrailingSlash(baseUrl));
  url.searchParams.set("audience-scope", "local");
  url.searchParams.set("audience", audience);
  url.searchParams.set("page-size", pageSize);

  return {
    audience,
    authorization: buildBasicAuthHeader(key, secret),
    outputPath: env.MEDIA_MANAGER_PROBE_OUTPUT ?? DEFAULT_OUTPUT_PATH,
    url,
  };
}

export async function fetchMediaManagerShows(config, fetchImpl = fetch) {
  const response = await fetchImpl(config.url, {
    headers: {
      Accept: "application/json",
      Authorization: config.authorization,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Media Manager probe failed with HTTP ${response.status}`);
  }

  return JSON.parse(text);
}

export function summarizeProbeResult(payload) {
  const records = Array.isArray(payload?.data) ? payload.data : [];
  const sampleTitles = records
    .map((record) => record?.attributes?.title)
    .filter((title) => typeof title === "string" && title.trim())
    .slice(0, 10);

  return {
    ok: true,
    count: records.length,
    sampleTitles,
  };
}

export async function writeProbeOutput(config, payload) {
  const summary = summarizeProbeResult(payload);
  const output = {
    checkedAt: new Date().toISOString(),
    request: {
      audience: config.audience,
      url: config.url.toString(),
    },
    summary,
  };
  const outputPath = path.resolve(config.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return { outputPath, output };
}

export async function main(env = process.env) {
  const config = buildProbeConfig(env);
  const payload = await fetchMediaManagerShows(config);
  const { outputPath, output } = await writeProbeOutput(config, payload);
  console.log(`Media Manager probe ok: ${output.summary.count} records`);
  console.log(`Wrote ${outputPath}`);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function optionalEnv(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
