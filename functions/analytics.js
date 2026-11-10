"use strict";

const { fetchAnalyticsJson } = require("./lib/analytics-http");
const { fetchMailchimp } = require("./mailchimp-analytics");
const { GoogleAuth } = require("google-auth-library");
const { defineSecret, defineString } = require("firebase-functions/params");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");

const { can } = require("./lib/rbac");

const MAILCHIMP_KEY = defineSecret("CMS_ANALYTICS_MAILCHIMP_KEY");
const MAILCHIMP_AUDIENCE = defineString("CMS_ANALYTICS_MAILCHIMP_AUDIENCE_ID", {
  default: "598fdbd3b7",
});
const CF_TOKEN = defineSecret("CMS_ANALYTICS_CF_TOKEN");
const GA4_PROPERTY = defineString("CMS_ANALYTICS_GA4_PROPERTY_ID", {
  default: "",
});
const CF_ZONE = defineString("CMS_ANALYTICS_CF_ZONE_ID", {
  default: "",
});
const HOSTS = ["njpbs.org", "www.njpbs.org"];
const CACHE_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
const METRICS = [
  "activeUsers",
  "newUsers",
  "sessions",
  "screenPageViews",
  "engagedSessions",
  "engagementRate",
  "averageSessionDuration",
];
const TOTAL_KEYS = [
  "activeUsers",
  "newUsers",
  "sessions",
  "views",
  "engagedSessions",
  "engagementRate",
  "averageSessionDuration",
];

function requestJson(url, body, token, fetchFn = fetch) {
  return fetchAnalyticsJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    fetchFn,
  );
}

async function googleToken() {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
    clientOptions: { transporterOptions: { timeout: 12000, retry: false } },
  });
  const client = await auth.getClient();
  const result = await client.getAccessToken();
  if (!result.token) throw new Error("Analytics token missing");
  return result.token;
}

function number(value) {
  const parsed = Number(value);
  if (
    value === undefined ||
    value === null ||
    !Number.isFinite(parsed) ||
    parsed < 0
  )
    throw new Error("Invalid analytics metric");
  return parsed;
}
function dateString(value) {
  return new Date(value).toISOString().slice(0, 10);
}
function periods(days, now) {
  const midnight = Date.parse(`${dateString(now)}T00:00:00Z`);
  return {
    start: dateString(midnight - days * DAY_MS),
    end: dateString(midnight - DAY_MS),
    previousStart: dateString(midnight - days * 2 * DAY_MS),
    previousEnd: dateString(midnight - (days + 1) * DAY_MS),
  };
}
function gaRows(report, keys, hasDimension = true) {
  const metricNames = {
    views: "screenPageViews",
    engagementSeconds: "userEngagementDuration",
    count: "eventCount",
  };
  if (
    !report ||
    !Array.isArray(report.metricHeaders) ||
    report.metricHeaders.length !== keys.length ||
    keys.some(
      (key, index) =>
        report.metricHeaders[index]?.name !== (metricNames[key] || key),
    ) ||
    (report.rows !== undefined && !Array.isArray(report.rows))
  )
    throw new Error("Invalid analytics report");
  return (report.rows || []).map((row) => ({
    ...(hasDimension
      ? {
          name: String(row.dimensionValues?.[0]?.value ?? "(not set)").slice(
            0,
            512,
          ),
        }
      : {}),
    ...Object.fromEntries(
      keys.map((key, index) => [key, number(row.metricValues?.[index]?.value)]),
    ),
  }));
}
function emptyTotals() {
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]));
}
function totals(report) {
  return (
    gaRows(report, TOTAL_KEYS, false)[0] || emptyTotals()
  );
}
function previousTotalsFrom(report) {
  if (!report || (report.rows !== undefined && !Array.isArray(report.rows))) {
    throw new Error("Invalid analytics report");
  }
  const headers = report.metricHeaders;
  const rows = report.rows || [];
  if (!Array.isArray(headers) || headers.length === 0) {
    if (rows.length) throw new Error("Invalid analytics report");
    return { totals: emptyTotals(), available: false };
  }
  return {
    totals: gaRows(report, TOTAL_KEYS, false)[0] || emptyTotals(),
    available: true,
  };
}

function fillDaily(rows, start, end, keys) {
  const values = new Map();
  for (const row of rows) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      row.date < start ||
      row.date > end ||
      values.has(row.date)
    ) {
      throw new Error("Invalid daily analytics date");
    }
    values.set(row.date, row);
  }
  const daily = [];
  for (
    let day = Date.parse(`${start}T00:00:00Z`);
    day <= Date.parse(`${end}T00:00:00Z`);
    day += DAY_MS
  ) {
    const date = dateString(day);
    daily.push(
      values.get(date) || {
        date,
        ...Object.fromEntries(keys.map((key) => [key, 0])),
      },
    );
  }
  return daily;
}

async function fetchGa4(days, now, config, fetchFn = fetch) {
  if (!/^\d+$/.test(config.propertyId))
    throw new Error("Invalid analytics property");
  const token = await (config.getAccessToken || googleToken)();
  const filter = {
    filter: {
      fieldName: "hostName",
      inListFilter: { values: HOSTS, caseSensitive: false },
    },
  };
  const report = (metrics, dimension, previous = false, limit = 20) => ({
    dateRanges: [
      {
        startDate: `${previous ? days * 2 : days}daysAgo`,
        endDate: previous ? `${days + 1}daysAgo` : "yesterday",
      },
    ],
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: filter,
    ...(dimension
      ? {
          dimensions: [{ name: dimension }],
          orderBys:
            dimension === "date"
              ? [{ dimension: { dimensionName: "date" } }]
              : [{ metric: { metricName: metrics[0] }, desc: true }],
        }
      : {}),
    limit,
  });
  const requests = [
    report(METRICS),
    report(METRICS, null, true),
    report(["activeUsers", "sessions", "screenPageViews"], "date", false, 90),
    report(
      ["screenPageViews", "activeUsers", "userEngagementDuration"],
      "pagePath",
    ),
    report(
      ["sessions", "engagedSessions", "engagementRate"],
      "sessionDefaultChannelGroup",
    ),
    report(["activeUsers"], "country"),
    report(["activeUsers"], "deviceCategory"),
    report(["eventCount"], "eventName"),
    report(["sessions", "engagedSessions"], "sessionSourceMedium"),
    report(["sessions", "engagedSessions"], "landingPage"),
  ];
  const regionReport = report(["activeUsers"], "region");
  regionReport.dimensionFilter = {
    andGroup: {
      expressions: [
        filter,
        {
          filter: {
            fieldName: "country",
            stringFilter: {
              matchType: "EXACT",
              value: "United States",
              caseSensitive: false,
            },
          },
        },
      ],
    },
  };
  requests.push(regionReport);
  // The batch API admits at most five reports per request.
  const requestBatches = [];
  for (let offset = 0; offset < requests.length; offset += 5)
    requestBatches.push(requests.slice(offset, offset + 5));
  const batches = await Promise.all(
    requestBatches.map((batch) =>
      requestJson(
        `https://analyticsdata.googleapis.com/v1beta/properties/${config.propertyId}:batchRunReports`,
        { requests: batch },
        token,
        fetchFn,
      ),
    ),
  );
  const reports = batches.flatMap((batch) => batch.reports || []);
  if (reports.length !== requests.length)
    throw new Error("Incomplete analytics response");
  const timezone = reports[0].metadata?.timeZone;
  if (typeof timezone !== "string")
    throw new Error("Analytics timezone missing");
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const dates = periods(days, Date.parse(`${localDate}T00:00:00Z`));
  const notes = [
    "Tagged browser traffic for njpbs.org and www.njpbs.org. Consent choices and blockers can reduce counts. Recent data can change.",
    "Dates follow the GA4 property timezone. Realtime is omitted because it cannot filter these hostnames.",
  ];
  if (reports.some((entry) => entry.metadata?.subjectToThresholding))
    notes.push("Google applied privacy thresholds; some rows may be withheld.");
  if (reports.some((entry) => entry.metadata?.dataLossFromOtherRow))
    notes.push("Google grouped some dimension values into an other row.");
  if (reports.some((entry) => entry.metadata?.samplingMetadatas?.length))
    notes.push("Google used sampled data in this report.");
  const audienceTotals = totals(reports[0]);
  const previous = previousTotalsFrom(reports[1]);
  const daily = fillDaily(
    gaRows(reports[2], ["activeUsers", "sessions", "views"]).map(
      ({ name, ...values }) => ({
        date: `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}`,
        ...values,
      }),
    ),
    dates.start,
    dates.end,
    ["activeUsers", "sessions", "views"],
  );
  if (!previous.available)
    notes.push(
      "The comparison period reported no traffic, so change rates have no prior baseline.",
    );
  const firstActive = daily.find(
    (row) => row.activeUsers > 0 || row.sessions > 0 || row.views > 0,
  );
  if (firstActive && firstActive.date > dates.start)
    notes.push(
      `No traffic was reported before ${firstActive.date} in this range; those days are shown as zero.`,
    );
  return {
    period: { start: dates.start, end: dates.end, timezone },
    previousPeriod: {
      start: dates.previousStart,
      end: dates.previousEnd,
      timezone,
    },
    totals: audienceTotals,
    previousTotals: previous.totals,
    hasPreviousBaseline: previous.available,
    daily,
    pages: gaRows(reports[3], ["views", "activeUsers", "engagementSeconds"]),
    channels: gaRows(reports[4], [
      "sessions",
      "engagedSessions",
      "engagementRate",
    ]),
    countries: gaRows(reports[5], ["activeUsers"]),
    devices: gaRows(reports[6], ["activeUsers"]),
    events: gaRows(reports[7], ["count"]),
    sources: gaRows(reports[8], ["sessions", "engagedSessions"]),
    landingPages: gaRows(reports[9], ["sessions", "engagedSessions"]),
    regions: gaRows(reports[10], ["activeUsers"]),
    notes,
  };
}

async function cfQuery(query, variables, config, fetchFn) {
  const response = await requestJson(
    "https://api.cloudflare.com/client/v4/graphql",
    { query, variables },
    config.token,
    fetchFn,
  );
  if (response.errors?.length || response.data?.viewer?.zones?.length !== 1)
    throw new Error("Cloudflare analytics unavailable");
  return response.data.viewer.zones[0];
}

async function fetchCloudflare(days, now, config, fetchFn = fetch) {
  if (!/^[a-f0-9]{32}$/.test(config.zoneId))
    throw new Error("Invalid analytics zone");
  const settings = await cfQuery(
    "query($zone: string) { viewer { zones(filter: {zoneTag: $zone}) { settings { httpRequestsAdaptiveGroups { enabled notOlderThan maxDuration maxPageSize } } } } }",
    { zone: config.zoneId },
    config,
    fetchFn,
  );
  const limits = settings.settings?.httpRequestsAdaptiveGroups;
  if (
    !limits?.enabled ||
    !Number.isFinite(limits.notOlderThan) ||
    limits.notOlderThan <= 0 ||
    !Number.isFinite(limits.maxPageSize) ||
    limits.maxPageSize < 1000 ||
    !Number.isFinite(limits.maxDuration) ||
    limits.maxDuration < 86400
  )
    throw new Error("Cloudflare analytics dataset unavailable");
  const dates = periods(days, now);
  const endMs = Date.parse(`${dates.end}T00:00:00Z`) + DAY_MS;
  // Only complete UTC days inside provider retention are safe to label as covered.
  const earliest =
    Math.ceil((now - limits.notOlderThan * 1000) / DAY_MS) * DAY_MS;
  const startMs = Math.max(Date.parse(`${dates.start}T00:00:00Z`), earliest);
  if (startMs >= endMs)
    throw new Error("No complete Cloudflare days available");
  const deadline = Date.now() + 45000;
  const chunks = [];
  const maxDays = Math.floor(limits.maxDuration / 86400);
  for (let start = startMs; start < endMs; start += maxDays * DAY_MS)
    chunks.push({ start, end: Math.min(endMs, start + maxDays * DAY_MS) });
  if (chunks.length > 31)
    throw new Error("Cloudflare query window unsupported");
  const daily = [],
    statuses = new Map(),
    cache = new Map();
  let requests = 0,
    bytes = 0;
  for (const chunk of chunks) {
    if (Date.now() > deadline) throw new Error("Cloudflare analytics timeout");
    const filter = {
      datetime_geq: new Date(chunk.start).toISOString(),
      datetime_lt: new Date(chunk.end).toISOString(),
      clientRequestHTTPHost_in: HOSTS,
      requestSource: "eyeball",
    };
    const result = await cfQuery(
      "query($zone: string, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject) { viewer { zones(filter: {zoneTag: $zone}) { daily: httpRequestsAdaptiveGroups(limit: 1000, filter: $filter, orderBy: [date_ASC]) { count sum { edgeResponseBytes } dimensions { date } } statuses: httpRequestsAdaptiveGroups(limit: 1000, filter: $filter) { count dimensions { edgeResponseStatus } } cache: httpRequestsAdaptiveGroups(limit: 1000, filter: $filter) { count dimensions { cacheStatus } } } } }",
      { zone: config.zoneId, filter },
      config,
      fetchFn,
    );
    for (const name of ["daily", "statuses", "cache"])
      if (!Array.isArray(result[name]) || result[name].length >= 1000)
        throw new Error("Incomplete Cloudflare analytics");
    for (const row of result.daily) {
      const count = number(row.count),
        size = number(row.sum?.edgeResponseBytes);
      daily.push({ date: row.dimensions.date, requests: count, bytes: size });
      requests += count;
      bytes += size;
    }
    for (const row of result.statuses) {
      const name = String(row.dimensions.edgeResponseStatus);
      statuses.set(name, (statuses.get(name) || 0) + number(row.count));
    }
    for (const row of result.cache) {
      const name = String(row.dimensions.cacheStatus);
      cache.set(name, (cache.get(name) || 0) + number(row.count));
    }
  }
  const cachedRequests = [...cache]
    .filter(([name]) =>
      ["hit", "stale", "updating", "revalidated"].includes(name.toLowerCase()),
    )
    .reduce((sum, [, value]) => sum + value, 0);
  const errors = [...statuses]
    .filter(([name]) => Number(name) >= 500 && Number(name) < 600)
    .reduce((sum, [, value]) => sum + value, 0);
  const complete = startMs === Date.parse(`${dates.start}T00:00:00Z`);
  return {
    period: { start: dateString(startMs), end: dates.end, timezone: "UTC" },
    requestedDays: days,
    complete,
    totals: {
      requests,
      bytes,
      cachedRequests,
      cacheHitRate: requests ? cachedRequests / requests : 0,
      errors,
    },
    daily: fillDaily(daily, dateString(startMs), dates.end, [
      "requests",
      "bytes",
    ]),
    statuses: [...statuses]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([name, value]) => ({ name, requests: value })),
    cache: [...cache]
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, requests: value })),
    notes: [
      "Cloudflare edge requests include bots and assets, and are not people or GA4 page views. Internal Cloudflare subrequests are excluded.",
      "Adaptive analytics can use sampling. Separately estimated request groups and rates can differ. Cache hits include hit, stale, updating and revalidated responses.",
      ...(complete
        ? []
        : [
            "Cloudflare retention limits this report to the displayed dates; it does not cover the full selected period.",
          ]),
    ],
  };
}

async function source(configured, read, label) {
  if (!configured)
    return {
      status: "not_configured",
      message: `${label} connection is not configured.`,
      data: null,
    };
  try {
    return {
      status: "ready",
      message: `${label} data loaded.`,
      data: await read(),
    };
  } catch {
    return {
      status: "unavailable",
      message: `${label} data is unavailable. Check provider access and try again after the cache expires.`,
      data: null,
    };
  }
}
function runtimeConfig() {
  return {
    mailchimp: {
      audienceId: MAILCHIMP_AUDIENCE.value(),
      apiKey: MAILCHIMP_KEY.value(),
    },
    ga4: { propertyId: GA4_PROPERTY.value() },
    cloudflare: { zoneId: CF_ZONE.value(), token: CF_TOKEN.value() },
  };
}
function createCmsGetAnalyticsHandler(deps = {}) {
  const authorize = deps.requirePrincipalFn || requirePrincipal;
  const appCheck = deps.verifyAppCheckFn || verifyAppCheckToken;
  const getConfig = deps.getConfig || runtimeConfig;
  const clock = deps.now || Date.now;
  const cache = new Map();
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    try {
      await appCheck(req.headers?.["x-firebase-appcheck"]);
      const actor = await authorize(req);
      if (!can(actor?.principal, "analytics.view")) {
        return res.status(403).json({ error: "Analytics access is required." });
      }
      const body = req.body;
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== "object" ||
        Object.keys(body).some((key) => key !== "days") ||
        ![7, 30, 90].includes(body.days)
      )
        return res.status(400).json({ error: "Choose 7, 30 or 90 days." });
      const now = clock();
      let entry = cache.get(body.days);
      if (!entry || entry.expires <= now) {
        const config = getConfig();
        const promise = Promise.all([
          source(
            config.ga4.propertyId,
            () => (deps.fetchGa4Fn || fetchGa4)(body.days, now, config.ga4),
            "Google Analytics",
          ),
          source(
            config.cloudflare.zoneId && config.cloudflare.token,
            () =>
              (deps.fetchCloudflareFn || fetchCloudflare)(
                body.days,
                now,
                config.cloudflare,
              ),
            "Cloudflare",
          ),
          source(
            config.mailchimp?.audienceId && config.mailchimp?.apiKey,
            () =>
              (deps.fetchMailchimpFn || fetchMailchimp)(
                body.days,
                now,
                config.mailchimp,
              ),
            "Mailchimp",
          ),
        ]).then(([ga4, cloudflare, mailchimp]) => ({
          days: body.days,
          hosts: HOSTS,
          generatedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + CACHE_MS).toISOString(),
          ga4,
          cloudflare,
          mailchimp,
        }));
        entry = { expires: now + CACHE_MS, promise };
        cache.set(body.days, entry);
      }
      return res.status(200).json(await entry.promise);
    } catch (error) {
      const status = [401, 403].includes(error?.status) ? error.status : 500;
      return res.status(status).json({
        error:
          status === 500
            ? "Analytics could not be loaded."
            : "Analytics access and a valid session are required.",
      });
    }
  };
}
const cmsGetAnalytics = cmsOnRequest(
  {
    cors: true,
    timeoutSeconds: 120,
    serviceAccount: "cms-analytics@njpbs-site.iam.gserviceaccount.com",
    secrets: [CF_TOKEN, MAILCHIMP_KEY],
  },
  createCmsGetAnalyticsHandler(),
);
module.exports = {
  cmsGetAnalytics,
  createCmsGetAnalyticsHandler,
  fetchGa4,
  fetchCloudflare,
  periods,
  requestJson,
};
