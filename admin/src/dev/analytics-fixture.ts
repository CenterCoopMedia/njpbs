import type { AnalyticsReport } from "../../../packages/content-core/src/analytics";

// Synthetic editorial examples for the local gallery. Never imported by production code.
export const analyticsFixture: AnalyticsReport = {
  days: 30,
  generatedAt: "2026-09-16T15:00:00Z",
  expiresAt: "2026-09-16T15:15:00Z",
  hosts: ["njpbs.org", "www.njpbs.org"],
  ga4: {
    status: "ready",
    message: "",
    data: {
      period: {
        start: "2026-08-17",
        end: "2026-09-15",
        timezone: "America/New_York",
      },
      previousPeriod: {
        start: "2026-07-18",
        end: "2026-08-16",
        timezone: "America/New_York",
      },
      totals: {
        activeUsers: 12450,
        newUsers: 8500,
        sessions: 17600,
        views: 28900,
        engagedSessions: 11320,
        engagementRate: 0.643,
        averageSessionDuration: 98,
      },
      previousTotals: {
        activeUsers: 11200,
        newUsers: 8100,
        sessions: 16400,
        views: 25300,
        engagedSessions: 9870,
        engagementRate: 0.601,
        averageSessionDuration: 91,
      },
      hasPreviousBaseline: true,
      daily: Array.from({ length: 30 }, (_, index) => ({
        date: new Date(Date.UTC(2026, 7, 17 + index))
          .toISOString()
          .slice(0, 10),
        activeUsers: 280 + ((index * 79) % 460),
        sessions: 410 + ((index * 93) % 510),
        views: 610 + ((index * 81) % 710),
      })),
      pages: [
        {
          name: "/posts/new-jersey-water-quality/",
          views: 4500,
          activeUsers: 3200,
          engagementSeconds: 216000,
        },
        {
          name: "/posts/how-the-school-funding-plan-affects-your-district/",
          views: 3300,
          activeUsers: 2600,
          engagementSeconds: 234000,
        },
        {
          name: "/live/",
          views: 2100,
          activeUsers: 1700,
          engagementSeconds: 99000,
        },
      ],
      channels: [
        {
          name: "Organic Search",
          sessions: 8400,
          engagedSessions: 6100,
          engagementRate: 0.726,
        },
        {
          name: "Email",
          sessions: 4100,
          engagedSessions: 3350,
          engagementRate: 0.817,
        },
      ],
      sources: [
        { name: "google / organic", sessions: 7900, engagedSessions: 5800 },
        {
          name: "daily-newsletter / email",
          sessions: 4100,
          engagedSessions: 3350,
        },
      ],
      landingPages: [
        {
          name: "/posts/new-jersey-water-quality/",
          sessions: 3200,
          engagedSessions: 2450,
        },
      ],
      regions: [
        { name: "New Jersey", activeUsers: 7100 },
        { name: "New York", activeUsers: 2900 },
        { name: "Pennsylvania", activeUsers: 1200 },
      ],
      countries: [{ name: "United States", activeUsers: 11800 }],
      devices: [
        { name: "mobile", activeUsers: 8400 },
        { name: "desktop", activeUsers: 3600 },
      ],
      events: [
        { name: "page_view", count: 28900 },
        { name: "scroll", count: 9600 },
      ],
      notes: ["Synthetic data for layout review; not a live report."],
    },
  },
  mailchimp: {
    status: "ready",
    message: "",
    data: {
      audienceName: "NJ PBS example audience",
      period: { start: "2026-08-17", end: "2026-09-15", timezone: "UTC" },
      audience: { subscribed: 34373, unsubscribed: 1420, cleaned: 315 },
      campaigns: [
        {
          id: "fixture-1",
          title: "This week: New Jersey water quality",
          sentAt: "2026-09-14T15:00:00Z",
          sent: 34000,
          delivered: 33500,
          uniqueClicks: 1675,
          clickRate: 0.05,
          uniqueOpens: 16080,
          openRate: 0.48,
          unsubscribes: 24,
          bounces: 500,
        },
        {
          id: "fixture-2",
          title: "School funding: What changes in your district",
          sentAt: "2026-09-07T15:00:00Z",
          sent: 33400,
          delivered: 33000,
          uniqueClicks: 1320,
          clickRate: 0.04,
          uniqueOpens: 14850,
          openRate: 0.45,
          unsubscribes: 18,
          bounces: 400,
        },
      ],
      totalCampaigns: 2,
      truncated: false,
      totals: {
        sent: 67400,
        delivered: 66500,
        uniqueClicks: 2995,
        clickRate: 2995 / 66500,
        uniqueOpens: 30930,
        openRate: 30930 / 66500,
        unsubscribes: 42,
        bounces: 900,
      },
      growth: [
        { month: "2026-06", subscribed: 32100, unsubscribed: 56 },
        { month: "2026-07", subscribed: 33400, unsubscribed: 71 },
        { month: "2026-08", subscribed: 34200, unsubscribed: 65 },
      ],
      growthPeriod: { startMonth: "2026-06", endMonth: "2026-08" },
      notes: [
        "Synthetic data. Opens can be inflated by privacy features; clicks can include automated activity.",
      ],
    },
  },
  cloudflare: {
    status: "ready",
    message: "",
    data: {
      period: { start: "2026-08-17", end: "2026-09-15", timezone: "UTC" },
      requestedDays: 30,
      complete: true,
      totals: {
        requests: 2100450,
        bytes: 18200000000,
        cachedRequests: 1500000,
        cacheHitRate: 0.714,
        errors: 120,
      },
      daily: Array.from({ length: 30 }, (_, index) => ({
        date: new Date(Date.UTC(2026, 7, 17 + index))
          .toISOString()
          .slice(0, 10),
        requests: 40000 + ((index * 13797) % 60000),
        bytes: 510000000,
      })),
      statuses: [
        { name: "200", requests: 1850000 },
        { name: "404", requests: 12000 },
        { name: "500", requests: 120 },
      ],
      cache: [
        { name: "hit", requests: 1500000 },
        { name: "miss", requests: 600450 },
      ],
      notes: ["Cloudflare adaptive analytics may use sampling."],
    },
  },
};
