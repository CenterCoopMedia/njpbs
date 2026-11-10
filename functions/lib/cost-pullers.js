"use strict";

const { createHash, createHmac } = require("node:crypto");
const { periodFor, shiftPeriod, usdToCents } = require("./cost-ledger");

const REQUEST_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;
const SOURCE_TIMEOUT_MS = 25_000;
const MAX_REQUEST_ATTEMPTS = 3;
const MAX_PAGES = 20;

const PULLERS = Object.freeze([
  { id: "gcp", flag: "COST_LEDGER_GCP_PULL", lines: Object.freeze(["gcp-cloud"]) },
  { id: "cloudflare", flag: "COST_LEDGER_CLOUDFLARE_PULL", lines: Object.freeze(["cloudflare"]) },
  { id: "aws", flag: "COST_LEDGER_AWS_PULL", lines: Object.freeze(["aws-s3", "aws-lightsail", "aws-other"]) },
  { id: "github", flag: "COST_LEDGER_GITHUB_PULL", lines: Object.freeze(["github-actions", "github-other"]) },
]);

function flagOn(flags, name) {
  return flags?.[name] === true || flags?.[name] === "true";
}

function numberToCents(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fixed = value.toFixed(6).replace(/\.?0+$/, "");
    return usdToCents(fixed === "" || fixed === "-" ? "0" : fixed);
  }
  return usdToCents(value);
}

function addCents(total, value) {
  const next = total + value;
  if (!Number.isSafeInteger(next)) throw new Error("Billing total is out of range.");
  return next;
}

// Accumulate base-ten integers at a shared scale, then round the total once.
// Number inputs use their JSON-decoded decimal representation, including e-notation.
function sumDecimalCents(values) {
  let total = 0n;
  let scale = 0;
  for (const value of values) {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
    if (!match) throw new Error("Amount is not a dollar value.");
    const fraction = match[3] || "";
    const exponent = Number(match[4] || 0);
    if (Math.abs(exponent) > 400 || fraction.length > 400) throw new Error("Amount is out of range.");
    const nextScale = Math.max(0, fraction.length - exponent);
    let amount = BigInt(`${match[1]}${match[2]}${fraction}`);
    if (exponent > fraction.length) amount *= 10n ** BigInt(exponent - fraction.length);
    if (nextScale > scale) {
      total *= 10n ** BigInt(nextScale - scale);
      scale = nextScale;
    }
    total += amount * 10n ** BigInt(scale - nextScale);
  }
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const decimal = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return usdToCents(`${total < 0n ? "-" : ""}${decimal}`);
}

function parseBigQueryTotal(body) {
  if (body?.totalRows === "0" || body?.totalRows === 0) {
    return [{ lineId: "gcp-cloud", amountCents: 0 }];
  }
  const cell = body?.rows?.[0]?.f?.[0]?.v;
  if (cell == null) throw new Error("Billing export returned no total.");
  return [{ lineId: "gcp-cloud", amountCents: usdToCents(String(cell)) }];
}

function parseCloudflareHistory(body, period) {
  if (!body || body.success !== true || !Array.isArray(body.result)) {
    throw new Error("Cloudflare billing history was not recognized.");
  }
  let total = 0;
  for (const item of body.result) {
    if (!item || typeof item.occurred_at !== "string") {
      throw new Error("Cloudflare billing date is missing.");
    }
    const stamp = new Date(item.occurred_at);
    if (Number.isNaN(stamp.getTime())) throw new Error("Cloudflare billing date is invalid.");
    if (periodFor(stamp) !== period) continue;
    if (typeof item.currency !== "string" || item.currency.toUpperCase() !== "USD") {
      throw new Error("Cloudflare billing history includes a non-USD amount.");
    }
    if (["credit", "refund", "payment"].includes(item.type)) continue;
    if (item.type !== "invoice") throw new Error("Cloudflare billing item type was not recognized.");
    if (item.status !== "CLOSED") throw new Error("Cloudflare billing invoice status was not recognized.");
    if (typeof item.amount !== "number") throw new Error("Cloudflare billing amount is missing.");
    total = addCents(total, numberToCents(item.amount));
  }
  return [{ lineId: "cloudflare", amountCents: total }];
}

function parseCostExplorer(body) {
  const periods = body?.ResultsByTime;
  if (!Array.isArray(periods)) throw new Error("Cost Explorer result was not recognized.");
  const totals = { "aws-s3": [], "aws-lightsail": [], "aws-other": [] };
  for (const period of periods) {
    if (!Array.isArray(period?.Groups)) {
      throw new Error("Cost Explorer result was not recognized.");
    }
    for (const group of period.Groups) {
      const service = group?.Keys?.[0] || "";
      const metric = group?.Metrics?.UnblendedCost;
      if (!metric || (metric.Unit && metric.Unit !== "USD")) {
        throw new Error("Cost Explorer returned a non-USD amount.");
      }
      const lineId = service === "Amazon Simple Storage Service"
        ? "aws-s3"
        : service === "Amazon Lightsail"
          ? "aws-lightsail"
          : "aws-other";
      totals[lineId].push(metric.Amount);
    }
  }
  return Object.entries(totals).map(([lineId, amounts]) => ({ lineId, amountCents: sumDecimalCents(amounts),
    ...(periods.some((period) => period.Estimated === true) ? { estimated: true } : {}),
  }));
}

function parseGithubUsage(body) {
  if (!Array.isArray(body?.usageItems)) {
    throw new Error("GitHub billing usage was not recognized.");
  }
  const actions = [];
  const other = [];
  for (const item of body.usageItems) {
    if (String(item?.product || "").toLowerCase() === "actions") actions.push(item.netAmount);
    else other.push(item?.netAmount);
  }
  return [
    { lineId: "github-actions", amountCents: sumDecimalCents(actions) },
    { lineId: "github-other", amountCents: sumDecimalCents(other) },
  ];
}

const PARSERS = Object.freeze({
  gcp: parseBigQueryTotal,
  cloudflare: parseCloudflareHistory,
  aws: parseCostExplorer,
  github: parseGithubUsage,
});

function credentialReady(id, env) {
  if (id === "gcp") {
    return Boolean(env.COST_LEDGER_GCP_BILLING_SA && env.COST_LEDGER_GCP_BILLING_TABLE && env.COST_LEDGER_GCP_PROJECT);
  }
  if (id === "cloudflare") {
    return Boolean(env.COST_LEDGER_CLOUDFLARE_API_TOKEN && /^[a-f0-9]{32}$/.test(env.COST_LEDGER_CLOUDFLARE_ACCOUNT_ID || ""));
  }
  if (id === "aws") {
    return Boolean(env.COST_LEDGER_AWS_ACCESS_KEY_ID && env.COST_LEDGER_AWS_SECRET_ACCESS_KEY);
  }
  return Boolean(env.COST_LEDGER_GITHUB_TOKEN &&
    /^[A-Za-z0-9-]+$/.test(env.COST_LEDGER_GITHUB_ACCOUNT || "") &&
    ["user", "org"].includes(env.COST_LEDGER_GITHUB_ACCOUNT_TYPE));
}

function billingTableName(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Billing export table is not configured.");
  }
  return `\`${parts.join(".")}\``;
}

function githubUsageUrl(env, period) {
  const account = env.COST_LEDGER_GITHUB_ACCOUNT;
  if (!/^[A-Za-z0-9-]+$/.test(account || "") ||
      !["user", "org"].includes(env.COST_LEDGER_GITHUB_ACCOUNT_TYPE)) {
    throw new Error("GitHub account is not configured.");
  }
  const [year, month] = period.split("-");
  const root = env.COST_LEDGER_GITHUB_ACCOUNT_TYPE === "org"
    ? `https://api.github.com/organizations/${account}/settings/billing/usage`
    : `https://api.github.com/users/${account}/settings/billing/usage`;
  return `${root}?year=${year}&month=${Number(month)}`;
}

function costExplorerBody(period, nextPageToken = null) {
  const end = shiftPeriod(period, 1);
  const request = {
    TimePeriod: { Start: `${period}-01`, End: `${end}-01` },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  };
  if (nextPageToken) request.NextPageToken = nextPageToken;
  return JSON.stringify(request);
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hashHex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signAwsRequest({
  method,
  host,
  path = "/",
  query = "",
  headers,
  body = "",
  accessKeyId,
  secretAccessKey,
  region,
  service,
  amzDate,
}) {
  const payloadHash = hashHex(body);
  const signed = {
    ...headers,
    host,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(signed).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(signed[name]).trim().replace(/ +/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hashHex(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  return {
    payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function timeoutError(message) {
  const error = new Error(message);
  error.timedOut = true;
  return error;
}

function timeoutLike(error) {
  return error?.timedOut === true || error?.name === "AbortError" || error?.name === "TimeoutError";
}

function withTimeout(work, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function createRequestBudget(timeoutMs = SOURCE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return {
    remaining() {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError("Cost pull timed out.");
      return remaining;
    },
  };
}

function retryDelay(attempt, budget) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(250 * attempt, budget.remaining())));
}

function anyFlagOn(flags) {
  return PULLERS.some((puller) => flagOn(flags, puller.flag));
}

async function fetchWithRetry(fetchImpl, url, options, label, settings = {}) {
  if (typeof fetchImpl !== "function") throw new Error(`${label} transport is unavailable.`);
  const attempts = settings.attempts ?? MAX_REQUEST_ATTEMPTS;
  const timeoutMs = settings.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const budget = settings.budget ?? createRequestBudget();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      const requestTimeout = Math.min(timeoutMs, budget.remaining());
      response = await withTimeout(
        () => fetchImpl(url, { ...options, signal: AbortSignal.timeout(requestTimeout) }),
        requestTimeout,
        `${label} request timed out.`,
      );
    } catch (error) {
      if (timeoutLike(error) || attempt === attempts) throw new Error(`${label} request failed.`);
      await retryDelay(attempt, budget);
      continue;
    }
    if (response?.ok) return response;
    if (!retryableStatus(response?.status) || attempt === attempts) {
      throw new Error(`${label} request failed.`);
    }
    await retryDelay(attempt, budget);
  }
  throw new Error(`${label} request failed.`);
}

async function readJson(response, budget, label) {
  return withTimeout(
    () => response.json(),
    budget.remaining(),
    `${label} response timed out.`,
  );
}

async function fetchCloudflareHistory(period, env, fetchImpl = globalThis.fetch) {
  const account = env.COST_LEDGER_CLOUDFLARE_ACCOUNT_ID;
  const items = [];
  const budget = createRequestBudget();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchWithRetry(
      fetchImpl,
      `https://api.cloudflare.com/client/v4/accounts/${account}/billing/history?per_page=50&page=${page}`,
      { headers: { Authorization: `Bearer ${env.COST_LEDGER_CLOUDFLARE_API_TOKEN}` } },
      "Cloudflare billing",
      { budget },
    );
    const body = await readJson(response, budget, "Cloudflare billing");
    if (body.success !== true || !Array.isArray(body.result)) {
      throw new Error("Cloudflare billing history was not recognized.");
    }
    items.push(...body.result);
    const info = body.result_info;
    if (typeof info?.next_page === "boolean") {
      if (!info.next_page) break;
    } else if (info?.total_count != null && Number.isFinite(Number(info.total_count))) {
      if (page * Number(info.per_page || 50) >= Number(info.total_count)) break;
    } else {
      throw new Error("Cloudflare billing history did not say whether more pages exist.");
    }
    if (page === MAX_PAGES) throw new Error("Cloudflare billing history did not fit in 20 pages.");
  }
  return { success: true, result: items, period };
}

async function fetchGithubUsage(period, env, fetchImpl = globalThis.fetch) {
  const budget = createRequestBudget();
  const initialUrl = new URL(githubUsageUrl(env, period));
  initialUrl.searchParams.sort();
  let url = initialUrl.href;
  const seen = new Set();
  const usageItems = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (seen.has(url)) throw new Error("GitHub billing repeated a next link.");
    seen.add(url);
    const response = await fetchWithRetry(fetchImpl, url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.COST_LEDGER_GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "njpbs-cost-ledger",
      },
    }, "GitHub billing", { budget });
    const body = await readJson(response, budget, "GitHub billing");
    if (!Array.isArray(body?.usageItems)) throw new Error("GitHub billing usage was not recognized.");
    usageItems.push(...body.usageItems);
    // No offline endpoint contract promises numeric pagination: follow advertised
    // links, including their page/per_page values, and stop when none is present.
    const link = response.headers?.get("link") || "";
    const next = link.split(",").find((part) => /;\s*rel="next"(?:\s*;|\s*$)/i.test(part));
    if (!next) return { usageItems };
    const target = /<([^>]+)>/.exec(next)?.[1];
    if (!target) throw new Error("GitHub billing next link is invalid.");
    const parsed = new URL(target, url);
    if (parsed.origin !== initialUrl.origin || parsed.pathname !== initialUrl.pathname
      || parsed.username || parsed.password || parsed.hash
      || parsed.searchParams.get("year") !== initialUrl.searchParams.get("year")
      || parsed.searchParams.get("month") !== initialUrl.searchParams.get("month")) {
      throw new Error("GitHub billing next link is outside the requested account or month.");
    }
    parsed.searchParams.sort();
    url = parsed.href;
    if (seen.has(url)) throw new Error("GitHub billing repeated a next link.");
    if (page === MAX_PAGES) throw new Error("GitHub billing usage did not fit in 20 pages.");
  }
}

async function fetchCostExplorer(period, env, fetchImpl = globalThis.fetch, now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const pages = [];
  const seenTokens = new Set();
  const budget = createRequestBudget();
  let nextPageToken = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = costExplorerBody(period, nextPageToken);
    const signed = signAwsRequest({
      method: "POST",
      host: "ce.us-east-1.amazonaws.com",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage",
      },
      body,
      accessKeyId: env.COST_LEDGER_AWS_ACCESS_KEY_ID,
      secretAccessKey: env.COST_LEDGER_AWS_SECRET_ACCESS_KEY,
      region: "us-east-1",
      service: "ce",
      amzDate,
    });
    const response = await fetchWithRetry(fetchImpl, "https://ce.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSInsightsIndexService.GetCostAndUsage",
        "X-Amz-Date": amzDate,
        Authorization: signed.authorization,
      },
      body,
    }, "Cost Explorer", { budget });
    const result = await readJson(response, budget, "Cost Explorer");
    if (!Array.isArray(result?.ResultsByTime)) {
      throw new Error("Cost Explorer result was not recognized.");
    }
    pages.push(...result.ResultsByTime);
    nextPageToken = result.NextPageToken;
    if (!nextPageToken) break;
    if (seenTokens.has(nextPageToken)) throw new Error("Cost Explorer repeated a page token.");
    seenTokens.add(nextPageToken);
    if (page === MAX_PAGES) throw new Error("Cost Explorer result did not fit in 20 pages.");
  }
  return { ResultsByTime: pages };
}

async function defaultGoogleAccessToken(credentials, budget = createRequestBudget()) {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
  });
  const client = await withTimeout(
    () => auth.getClient(),
    Math.min(AUTH_TIMEOUT_MS, budget.remaining()),
    "Billing export credential could not be used.",
  );
  const token = await withTimeout(
    () => client.getAccessToken(),
    Math.min(AUTH_TIMEOUT_MS, budget.remaining()),
    "Billing export credential could not be used.",
  );
  if (!token?.token) throw new Error("Billing export credential could not be used.");
  return token.token;
}

async function fetchBigQueryTotal(period, env, fetchImpl = globalThis.fetch, { getAccessToken = defaultGoogleAccessToken } = {}) {
  const table = billingTableName(env.COST_LEDGER_GCP_BILLING_TABLE);
  const project = env.COST_LEDGER_GCP_PROJECT;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project || "")) {
    throw new Error("Billing export project is not configured.");
  }
  let credentials;
  try {
    credentials = JSON.parse(env.COST_LEDGER_GCP_BILLING_SA);
  } catch {
    throw new Error("Billing export credential is not valid JSON.");
  }
  const budget = createRequestBudget();
  let token;
  try {
    token = await getAccessToken(credentials, budget);
  } catch {
    throw new Error("Billing export credential could not be used.");
  }
  const invoiceMonth = String(period || "").replace("-", "");
  if (!/^\d{6}$/.test(invoiceMonth)) throw new Error("Billing month is not valid.");
  const queryTimeoutMs = Math.max(1, Math.min(8_000, budget.remaining() - 1_000));
  const response = await fetchWithRetry(
    fetchImpl,
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `SELECT IF(COUNTIF(currency IS NULL OR currency != 'USD') > 0, ERROR('Non-USD billing export currency'), CAST(ROUND(COALESCE(SUM(cost + IFNULL((SELECT SUM(credit.amount) FROM UNNEST(credits) AS credit), 0)), 0), 2) AS NUMERIC)) AS total_cost, COUNT(*) AS row_count FROM ${table} WHERE invoice.month = '${invoiceMonth}'`,
        useLegacySql: false,
        maximumBytesBilled: "1073741824",
        maxResults: 10,
        timeoutMs: queryTimeoutMs,
      }),
    },
    "Billing export",
    { attempts: 1, budget },
  );
  const first = await readJson(response, budget, "Billing export");
  if (first?.jobComplete !== true) throw new Error("Billing export query did not complete.");
  if (Number(first.rows?.[0]?.f?.[1]?.v) === 0) {
    throw new Error("Billing export month has no rows yet.");
  }
  const jobId = first?.jobReference?.jobId;
  const rows = [...(first.rows || [])];
  const seenTokens = new Set();
  let nextPageToken = first.pageToken;
  for (let page = 1; nextPageToken; page += 1) {
    if (page > MAX_PAGES || seenTokens.has(nextPageToken) || typeof jobId !== "string") {
      throw new Error("Billing export result did not fit in 20 pages.");
    }
    seenTokens.add(nextPageToken);
    const pageResponse = await fetchWithRetry(
      fetchImpl,
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${encodeURIComponent(jobId)}?pageToken=${encodeURIComponent(nextPageToken)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "Billing export",
      { budget },
    );
    const pageBody = await readJson(pageResponse, budget, "Billing export");
    if (pageBody?.jobComplete !== true) throw new Error("Billing export query did not complete.");
    rows.push(...(pageBody.rows || []));
    nextPageToken = pageBody.pageToken;
  }
  return { ...first, rows, totalRows: rows.length };
}

const LIVE_CLIENTS = Object.freeze({
  gcp: fetchBigQueryTotal,
  cloudflare: fetchCloudflareHistory,
  aws: fetchCostExplorer,
  github: fetchGithubUsage,
});

async function collectPulls({ flags, env, clients, period }) {
  const results = [];
  for (const puller of PULLERS) {
    if (!flagOn(flags, puller.flag)) {
      results.push({ id: puller.id, status: "disabled", entries: [], lines: puller.lines });
      continue;
    }
    if (!credentialReady(puller.id, env)) {
      results.push({
        id: puller.id,
        status: "error",
        message: "Credential is not configured.",
        entries: [],
        lines: puller.lines,
      });
      continue;
    }
    try {
      const body = await clients[puller.id](period, env);
      results.push({
        id: puller.id,
        status: "fresh",
        entries: PARSERS[puller.id](body, period),
        lines: puller.lines,
      });
    } catch {
      results.push({
        id: puller.id,
        status: "error",
        message: "Pull failed.",
        entries: [],
        lines: puller.lines,
      });
    }
  }
  return results;
}

module.exports = {
  LIVE_CLIENTS,
  PULLERS,
  addCents,
  anyFlagOn,
  billingTableName,
  collectPulls,
  costExplorerBody,
  credentialReady,
  fetchBigQueryTotal,
  fetchCloudflareHistory,
  fetchCostExplorer,
  fetchGithubUsage,
  fetchWithRetry,
  flagOn,
  githubUsageUrl,
  numberToCents,
  signAwsRequest,
  parseBigQueryTotal,
  parseCloudflareHistory,
  parseCostExplorer,
  parseGithubUsage,
};
