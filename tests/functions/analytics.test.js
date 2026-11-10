import { describe, expect, it, vi } from "vitest";
import analytics from "../../functions/analytics.js";
const { createCmsGetAnalyticsHandler, fetchCloudflare, fetchGa4, periods } =
  analytics;
const now = Date.parse("2026-09-16T03:00:00Z");
const config = {
  ga4: { propertyId: "123", getAccessToken: async () => "access" },
  cloudflare: { zoneId: "a".repeat(32), token: "secret" },
  mailchimp: { audienceId: "598fdbd3b7", apiKey: "secret" },
};
function response() {
  return {
    statusCode: 0,
    body: null,
    set: vi.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}
function setup(overrides = {}) {
  const deps = {
    requirePrincipalFn: vi.fn().mockResolvedValue({ principal: { grants: [{ role: "admin" }] } }),
    verifyAppCheckFn: vi.fn(),
    getConfig: () => config,
    now: () => now,
    fetchGa4Fn: vi.fn().mockResolvedValue({ audience: true }),
    fetchCloudflareFn: vi.fn().mockResolvedValue({ edge: true }),
    fetchMailchimpFn: vi.fn().mockResolvedValue({ email: true }),
    ...overrides,
  };
  return { deps, handler: createCmsGetAnalyticsHandler(deps) };
}
const req = (days = 7) => ({
  method: "POST",
  headers: { "x-firebase-appcheck": "app" },
  body: { days },
});
const json = (value) => new Response(JSON.stringify(value));
describe("analytics boundary", () => {
  it("requires App Check and current analytics authorization before provider or cache access", async () => {
    const { handler, deps } = setup();
    const first = response();
    await handler(req(), first);
    expect(first.statusCode).toBe(200);
    deps.requirePrincipalFn.mockRejectedValue({ status: 403 });
    const denied = response();
    await handler(req(), denied);
    expect(denied.statusCode).toBe(403);
    expect(deps.fetchGa4Fn).toHaveBeenCalledTimes(1);
    expect(deps.verifyAppCheckFn).toHaveBeenCalledWith("app");
  });
  it.each(["staff", "contributor", "editor"])("denies %s before provider or cache reads", async (role) => {
    const { handler, deps } = setup({
      requirePrincipalFn: async () => ({ principal: { grants: [{ role }] } }),
    });
    const res = response();
    await handler(req(), res);
    expect(res.statusCode).toBe(403);
    expect(deps.fetchGa4Fn).not.toHaveBeenCalled();
  });
  it("rejects invalid App Check without authorization or reads", async () => {
    const { handler, deps } = setup({
      verifyAppCheckFn: vi.fn().mockRejectedValue({ status: 401 }),
    });
    const res = response();
    await handler(req(), res);
    expect(res.statusCode).toBe(401);
    expect(deps.requirePrincipalFn).not.toHaveBeenCalled();
    expect(deps.fetchGa4Fn).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { days: "7" },
    { days: 8 },
    { days: 7, property: "other" },
    [],
    null,
  ])("rejects arbitrary query input %j", async (body) => {
    const { handler, deps } = setup();
    const res = response();
    await handler({ ...req(), body }, res);
    expect(res.statusCode).toBe(400);
    expect(deps.fetchGa4Fn).not.toHaveBeenCalled();
  });
  it("shares concurrent loads, expires cache and separates date windows", async () => {
    let time = now;
    const { handler, deps } = setup({ now: () => time });
    await Promise.all([handler(req(), response()), handler(req(), response())]);
    expect(deps.fetchGa4Fn).toHaveBeenCalledTimes(1);
    await handler(req(30), response());
    expect(deps.fetchGa4Fn).toHaveBeenCalledTimes(2);
    time += 600001;
    await handler(req(), response());
    expect(deps.fetchGa4Fn).toHaveBeenCalledTimes(3);
  });
  it("isolates provider failures and never exposes their raw error", async () => {
    const { handler } = setup({
      fetchGa4Fn: vi.fn().mockRejectedValue(new Error("secret provider body")),
    });
    const res = response();
    await handler(req(), res);
    expect(res.body.ga4).toMatchObject({ status: "unavailable", data: null });
    expect(res.body.cloudflare.status).toBe("ready");
    expect(res.body.mailchimp.status).toBe("ready");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });
  it("keeps site analytics available when Mailchimp fails", async () => {
    const { handler } = setup({
      fetchMailchimpFn: vi
        .fn()
        .mockRejectedValue(new Error("private Mailchimp response")),
    });
    const res = response();
    await handler(req(), res);
    expect(res.body.mailchimp).toMatchObject({
      status: "unavailable",
      data: null,
    });
    expect(res.body.ga4.status).toBe("ready");
    expect(res.body.cloudflare.status).toBe("ready");
    expect(JSON.stringify(res.body)).not.toContain(
      "private Mailchimp response",
    );
  });
  it("reports missing setup without fake data or provider requests", async () => {
    const { handler, deps } = setup({
      getConfig: () => ({ ga4: {}, cloudflare: {} }),
    });
    const res = response();
    await handler(req(), res);
    expect(res.body.ga4).toMatchObject({
      status: "not_configured",
      data: null,
    });
    expect(deps.fetchGa4Fn).not.toHaveBeenCalled();
  });
});
describe("provider reports", () => {
  it("builds complete previous periods across year boundaries", () => {
    expect(periods(7, Date.parse("2026-01-03T12:00:00Z"))).toEqual({
      start: "2025-12-27",
      end: "2026-01-02",
      previousStart: "2025-12-20",
      previousEnd: "2025-12-26",
    });
  });
  it("filters every GA4 report to the two public hosts and dates in the property timezone", async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, options) => {
      if (url.includes("oauth2")) return json({ access_token: "access" });
      const body = JSON.parse(options.body);
      calls.push(body);
      return json({
        reports: body.requests.map((request) => ({
          metricHeaders: request.metrics,
          metadata: { timeZone: "America/New_York" },
          rows: [],
        })),
      });
    });
    const report = await fetchGa4(7, now, config.ga4, fetchFn);
    expect(report.period).toEqual({
      start: "2026-09-08",
      end: "2026-09-14",
      timezone: "America/New_York",
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((batch) => batch.requests.length)).toEqual([5, 5, 1]);
    const regionFilter =
      calls[2].requests[0].dimensionFilter.andGroup.expressions;
    expect(regionFilter[1].filter).toEqual({
      fieldName: "country",
      stringFilter: {
        matchType: "EXACT",
        value: "United States",
        caseSensitive: false,
      },
    });
    for (const request of calls.flatMap((batch) => batch.requests)) {
      const hostFilter =
        request.dimensionFilter.filter ||
        request.dimensionFilter.andGroup.expressions[0].filter;
      expect(hostFilter.inListFilter.values).toEqual([
        "njpbs.org",
        "www.njpbs.org",
      ]);
      expect(request.limit).toBeLessThanOrEqual(90);
    }
    expect(report.totals.activeUsers).toBe(0);
    expect(report.daily).toHaveLength(7);
    expect(report.daily[0]).toEqual({
      date: "2026-09-08",
      activeUsers: 0,
      sessions: 0,
      views: 0,
    });
  });
  it("treats an empty GA4 comparison period as zero totals", async () => {
    const fetchFn = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      return json({
        reports: body.requests.map((request) => {
          const previousTotals =
            !request.dimensions &&
            request.dateRanges?.[0]?.endDate !== "yesterday";
          if (previousTotals) {
            return { metadata: { timeZone: "America/New_York" }, rows: [] };
          }
          return {
            metricHeaders: request.metrics,
            metadata: { timeZone: "America/New_York" },
            rows: [],
          };
        }),
      });
    });
    const report = await fetchGa4(30, now, config.ga4, fetchFn);
    expect(report.previousTotals).toEqual({
      activeUsers: 0,
      newUsers: 0,
      sessions: 0,
      views: 0,
      engagedSessions: 0,
      engagementRate: 0,
      averageSessionDuration: 0,
    });
    expect(report.totals.activeUsers).toBe(0);
    expect(report.hasPreviousBaseline).toBe(false);
    expect(report.daily).toHaveLength(30);
    expect(report.notes).toEqual(
      expect.arrayContaining([
        "The comparison period reported no traffic, so change rates have no prior baseline.",
      ]),
    );
  });
  it("keeps current-period totals strict when only the comparison report is empty", async () => {
    const fetchFn = async (_url, options) => {
      const body = JSON.parse(options.body);
      return json({
        reports: body.requests.map((request) => {
          const currentTotals =
            !request.dimensions &&
            request.dateRanges?.[0]?.endDate === "yesterday";
          if (currentTotals) {
            return { metadata: { timeZone: "America/New_York" }, rows: [] };
          }
          return {
            metricHeaders: request.metrics,
            metadata: { timeZone: "America/New_York" },
            rows: [],
          };
        }),
      });
    };
    await expect(fetchGa4(7, now, config.ga4, fetchFn)).rejects.toThrow(
      "Invalid analytics report",
    );
  });
  it("rejects malformed GA4 headers instead of returning zero metrics", async () => {
    const fetchFn = async (_url, options) => {
      const body = JSON.parse(options.body);
      return json({
        reports: body.requests.map(() => ({
          metricHeaders: [],
          metadata: { timeZone: "UTC" },
          rows: [],
        })),
      });
    };
    await expect(fetchGa4(7, now, config.ga4, fetchFn)).rejects.toThrow(
      "Invalid analytics report",
    );
  });
  it("clips Cloudflare retention and chunks provider query windows without claiming full coverage", async () => {
    const filters = [];
    const fetchFn = vi.fn(async (_url, options) => {
      const { query, variables } = JSON.parse(options.body);
      const zone = query.includes("settings")
        ? {
            settings: {
              httpRequestsAdaptiveGroups: {
                enabled: true,
                notOlderThan: 31 * 86400,
                maxDuration: 8 * 86400,
                maxPageSize: 10000,
              },
            },
          }
        : {
            daily: [
              {
                count: 10,
                sum: { edgeResponseBytes: 100 },
                dimensions: {
                  date: variables.filter.datetime_geq.slice(0, 10),
                },
              },
            ],
            statuses: [
              { count: 2, dimensions: { edgeResponseStatus: 503 } },
              { count: 5, dimensions: { edgeResponseStatus: 200 } },
              { count: 3, dimensions: { edgeResponseStatus: 404 } },
            ],
            cache: [{ count: 5, dimensions: { cacheStatus: "hit" } }],
          };
      if (variables.filter) filters.push(variables.filter);
      return json({ data: { viewer: { zones: [zone] } } });
    });
    const report = await fetchCloudflare(90, now, config.cloudflare, fetchFn);
    expect(report.complete).toBe(false);
    expect(report.period.start).toBe("2026-08-17");
    expect(filters).toHaveLength(4);
    expect(report.totals.requests).toBe(40);
    expect(report.totals.errors).toBe(8);
    expect(report.statuses.map((row) => row.name)).toEqual([
      "200",
      "404",
      "503",
    ]);
    expect(report.daily).toHaveLength(30);
    expect(report.daily[1].requests).toBe(0);
    for (const filter of filters) {
      expect(filter.clientRequestHTTPHost_in).toEqual([
        "njpbs.org",
        "www.njpbs.org",
      ]);
      expect(
        Date.parse(filter.datetime_lt) - Date.parse(filter.datetime_geq),
      ).toBeLessThanOrEqual(8 * 86400000);
    }
  });
  it("rejects partial GraphQL errors even with data", async () => {
    await expect(
      fetchCloudflare(7, now, config.cloudflare, async () =>
        json({
          errors: [{ message: "token details" }],
          data: { viewer: { zones: [{}] } },
        }),
      ),
    ).rejects.toThrow("unavailable");
  });
});
