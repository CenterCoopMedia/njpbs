import type {
  AnalyticsDays,
  AnalyticsReport,
} from "../../../packages/content-core/src/analytics";
import { postFunction } from "./functions";
export { encodeCsv as analyticsCsv } from "../components/analytics/analytics-model";

export function getAnalytics(
  token: string,
  days: AnalyticsDays,
  signal?: AbortSignal,
) {
  return postFunction<AnalyticsReport>(
    "cmsGetAnalytics",
    token,
    { days },
    {},
    {
      appCheck: true,
      signal,
      operation: "report-read",
    },
  );
}

export function changeLabel(value: number, previous: number): string {
  if (previous === 0) return value === 0 ? "No change" : "No prior baseline";
  const change = ((value - previous) / previous) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs previous period`;
}

