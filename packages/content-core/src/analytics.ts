/** Server-owned analytics report. Dates are inclusive calendar dates. */
export type AnalyticsDays = 7 | 30 | 90;
export interface AnalyticsPeriod {
  start: string;
  end: string;
  timezone: string;
}
export interface AnalyticsSource<T> {
  status: "ready" | "not_configured" | "unavailable";
  message: string;
  data: T | null;
}
export interface AnalyticsAudienceTotals {
  activeUsers: number;
  newUsers: number;
  sessions: number;
  views: number;
  engagedSessions: number;
  engagementRate: number;
  averageSessionDuration: number;
}
export interface AnalyticsAudience {
  period: AnalyticsPeriod;
  previousPeriod: AnalyticsPeriod;
  totals: AnalyticsAudienceTotals;
  previousTotals: AnalyticsAudienceTotals;
  hasPreviousBaseline: boolean;
  daily: Array<{
    date: string;
    activeUsers: number;
    sessions: number;
    views: number;
  }>;
  pages: Array<{
    name: string;
    views: number;
    activeUsers: number;
    engagementSeconds: number;
  }>;
  channels: Array<{
    name: string;
    sessions: number;
    engagedSessions: number;
    engagementRate: number;
  }>;
  sources: Array<{ name: string; sessions: number; engagedSessions: number }>;
  landingPages: Array<{
    name: string;
    sessions: number;
    engagedSessions: number;
  }>;
  regions: Array<{ name: string; activeUsers: number }>;
  countries: Array<{ name: string; activeUsers: number }>;
  devices: Array<{ name: string; activeUsers: number }>;
  events: Array<{ name: string; count: number }>;
  notes: string[];
}
export interface AnalyticsEdge {
  period: AnalyticsPeriod;
  requestedDays: AnalyticsDays;
  complete: boolean;
  totals: {
    requests: number;
    bytes: number;
    cachedRequests: number;
    cacheHitRate: number;
    errors: number;
  };
  daily: Array<{ date: string; requests: number; bytes: number }>;
  statuses: Array<{ name: string; requests: number }>;
  cache: Array<{ name: string; requests: number }>;
  notes: string[];
}
export interface AnalyticsEmailCampaign {
  id: string;
  title: string;
  sentAt: string;
  sent: number;
  delivered: number;
  uniqueClicks: number;
  clickRate: number;
  uniqueOpens: number;
  openRate: number;
  unsubscribes: number;
  bounces: number;
}
export interface AnalyticsEmail {
  audienceName: string;
  period: AnalyticsPeriod;
  audience: { subscribed: number; unsubscribed: number; cleaned: number };
  campaigns: AnalyticsEmailCampaign[];
  totalCampaigns: number;
  truncated: boolean;
  totals: {
    sent: number;
    delivered: number;
    uniqueClicks: number;
    clickRate: number;
    uniqueOpens: number;
    openRate: number;
    unsubscribes: number;
    bounces: number;
  };
  growth: Array<{ month: string; subscribed: number; unsubscribed: number }>;
  growthPeriod: { startMonth: string | null; endMonth: string | null };
  notes: string[];
}
export interface AnalyticsReport {
  days: AnalyticsDays;
  generatedAt: string;
  expiresAt: string;
  hosts: string[];
  ga4: AnalyticsSource<AnalyticsAudience>;
  cloudflare: AnalyticsSource<AnalyticsEdge>;
  mailchimp: AnalyticsSource<AnalyticsEmail>;
}
