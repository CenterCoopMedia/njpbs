import { describe, expect, it, vi } from "vitest";
import adapter from "../../functions/mailchimp-analytics.js";
const { fetchMailchimp } = adapter;
const now = Date.parse("2026-09-16T12:00:00Z");
const audienceId = "598fdbd3b7";
const config = { audienceId, apiKey: `${"a".repeat(32)}-us5` };
const campaignId = (index) => index.toString(16).padStart(10, "0");
function fixture({
  total = 1,
  wrongList = false,
  wrongReportList = false,
  failed = false,
} = {}) {
  const urls = [];
  const fetchFn = vi.fn(async (url, options) => {
    urls.push(new URL(url));
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(options.headers.Authorization.startsWith("Basic ")).toBe(true);
    const path = new URL(url).pathname;
    if (failed) return new Response("provider secret details", { status: 403 });
    let body;
    if (path.endsWith("growth-history"))
      body = {
        history: [
          {
            list_id: audienceId,
            month: "2026-09",
            subscribed: 105,
            unsubscribed: 2,
          },
          {
            list_id: audienceId,
            month: "2026-08",
            subscribed: 100,
            unsubscribed: 3,
          },
        ],
      };
    else if (path.endsWith("/campaigns"))
      body = {
        total_items: total,
        campaigns: Array.from({ length: Math.min(total, 20) }, (_, i) => ({
          id: campaignId(i),
          recipients: { list_id: wrongList ? "937a26ec30" : audienceId },
          send_time: "2026-09-12T12:00:00Z",
        })),
      };
    else if (path.includes("/reports/"))
      body = {
        id: path.split("/").at(-1),
        list_id: wrongReportList ? "937a26ec30" : audienceId,
        campaign_title: "NJPBS news",
        send_time: "2026-09-12T12:00:00Z",
        emails_sent: 100,
        bounces: { hard_bounces: 2, soft_bounces: 3 },
        clicks: { unique_subscriber_clicks: 10 },
        opens: { unique_opens: 25 },
        unsubscribed: 1,
        share_report: { share_password: "must-not-return" },
      };
    else
      body = {
        id: audienceId,
        name: "NJPBS",
        stats: { member_count: 100, unsubscribe_count: 12, cleaned_count: 4 },
        contact: { email: "private@example.test" },
      };
    return new Response(JSON.stringify(body));
  });
  return { fetchFn, urls };
}
describe("Mailchimp analytics", () => {
  it("reads only aggregate data for the fixed audience and derives weighted delivery rates", async () => {
    const { fetchFn, urls } = fixture();
    const result = await fetchMailchimp(7, now, config, fetchFn);
    expect(result.audience).toEqual({
      subscribed: 100,
      unsubscribed: 12,
      cleaned: 4,
    });
    expect(result.totals).toEqual({
      sent: 100,
      delivered: 95,
      uniqueClicks: 10,
      clickRate: 10 / 95,
      uniqueOpens: 25,
      openRate: 25 / 95,
      unsubscribes: 1,
      bounces: 5,
    });
    expect(result.period).toEqual({
      start: "2026-09-09",
      end: "2026-09-15",
      timezone: "UTC",
    });
    expect(result.growth).toEqual([
      { month: "2026-08", subscribed: 100, unsubscribed: 3 },
    ]);
    expect(result.growthPeriod).toEqual({
      startMonth: "2026-08",
      endMonth: "2026-08",
    });
    expect(result.truncated).toBe(false);
    const listQuery = urls.find((url) => url.pathname.endsWith("/campaigns"));
    expect(listQuery.searchParams.get("list_id")).toBe(audienceId);
    expect(listQuery.searchParams.get("status")).toBe("sent");
    expect(
      urls.every((url) => url.origin === "https://us5.api.mailchimp.com"),
    ).toBe(true);
    expect(urls.every((url) => !url.pathname.includes("members"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private@example");
    expect(JSON.stringify(result)).not.toContain("must-not-return");
    expect(
      urls.every(
        (url) => !url.searchParams.get("fields").includes("share_report"),
      ),
    ).toBe(true);
  });
  it("discloses bounded top-20 campaign totals instead of claiming all campaigns", async () => {
    const { fetchFn, urls } = fixture({ total: 31 });
    const result = await fetchMailchimp(90, now, config, fetchFn);
    expect(result.campaigns).toHaveLength(20);
    expect(result.totalCampaigns).toBe(31);
    expect(result.truncated).toBe(true);
    expect(result.totals.sent).toBe(2000);
    expect(
      urls.filter((url) => url.pathname.includes("/reports/")),
    ).toHaveLength(20);
    expect(result.notes.join(" ")).toContain("displayed campaigns only");
  });
  it.each([{ wrongList: true }, { wrongReportList: true }])(
    "rejects another audience even when upstream filters fail %j",
    async (options) => {
      await expect(
        fetchMailchimp(7, now, config, fixture(options).fetchFn),
      ).rejects.toThrow("scope mismatch");
    },
  );
  it("rejects unsafe data-center and audience configuration without requests", async () => {
    const fetchFn = vi.fn();
    await expect(
      fetchMailchimp(
        7,
        now,
        { ...config, apiKey: "key-evil.example" },
        fetchFn,
      ),
    ).rejects.toThrow("configuration");
    await expect(
      fetchMailchimp(7, now, { ...config, audienceId: "../members" }, fetchFn),
    ).rejects.toThrow("configuration");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("returns zero campaigns only after a successful empty provider listing", async () => {
    const result = await fetchMailchimp(
      7,
      now,
      config,
      fixture({ total: 0 }).fetchFn,
    );
    expect(result.campaigns).toEqual([]);
    expect(result.totals.sent).toBe(0);
    await expect(
      fetchMailchimp(7, now, config, fixture({ failed: true }).fetchFn),
    ).rejects.toThrow("provider request failed");
  });
});
