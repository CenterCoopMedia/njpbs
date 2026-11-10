import { scheduleDateKey } from "./schedule-view";
import { isBroadcastDate } from "./broadcast-date";
import type { BakedScheduleData, ScheduleFeedDay } from "./schedule-feed";
import { TVSS_TIME_ZONE } from "./schedule-feed";

export const SCHEDULE_STALE_AFTER_MS = 20 * 60 * 60 * 1_000;
const EXPORT_TIME_KEY = "__njpbsScheduleExportTime";

/** One timestamp shared by every schedule page and PDF route in this build. */
export function scheduleExportTime(): Date {
  const clock = globalThis as typeof globalThis & { [EXPORT_TIME_KEY]?: number };
  clock[EXPORT_TIME_KEY] ??= Date.now();
  return new Date(clock[EXPORT_TIME_KEY]);
}

export type ScheduleSourceStatus = "fresh" | "corrected" | "stale" | "unknown" | "invalid";

export interface ScheduleExport {
  readonly startDate: string;
  readonly endDate: string;
  readonly dates: readonly string[];
  readonly rangeLabel: string;
  readonly shortRangeLabel: string;
  readonly title: string;
  readonly dayCount: number;
  readonly listingCount: number;
  readonly days: readonly ScheduleFeedDay[];
  readonly missingDates: readonly string[];
  readonly coverageNotice: string;
  readonly filename: string;
  readonly href: string;
  readonly sourceLabel: string;
  readonly generatedAt: string;
  readonly exportedAt: string;
  readonly timeZone: typeof TVSS_TIME_ZONE;
  readonly sourceRevisionDates: readonly string[];
  readonly correctedDayCount: number;
  readonly pbsCheckedDayCount: number;
  readonly unknownDayCount: number;
  readonly sourceCheckedAt: string | null;
  readonly sourceCheckText: string;
  readonly sourceStatus: ScheduleSourceStatus;
  readonly notice: string;
}

export function formatScheduleExportInstant(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric",
    minute: "2-digit", timeZone: TVSS_TIME_ZONE, timeZoneName: "short",
  }).format(new Date(value));
}

export function formatScheduleExportDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

function sourceState(days: readonly ScheduleFeedDay[], exportedAt: Date) {
  const correctedDays = days.filter((day) => day.sourceRevision);
  const pbsDays = days.filter((day) => !day.sourceRevision);
  const revisionDates = [...new Set(correctedDays.map((day) => day.sourceRevision!))].sort();
  const sourceRevisionDates = revisionDates.filter(isBroadcastDate);
  const checkedTimes = pbsDays.flatMap((day) =>
    day.sourceCheckedAt ? [Date.parse(day.sourceCheckedAt)] : [],
  );
  const correctedDayCount = correctedDays.length;
  const pbsCheckedDayCount = checkedTimes.length;
  const unknownDayCount = pbsDays.length - pbsCheckedDayCount;
  const correctionText = sourceRevisionDates.map((revision) => {
    const count = correctedDays.filter((day) => day.sourceRevision === revision).length;
    return `${count} corrected listing ${count === 1 ? "date comes" : "dates come"} from the NJ PBS replacement lineup dated ${formatScheduleExportDate(revision)}.`;
  }).join(" ");
  let sourceCheckedAt: string | null = null;
  let sourceStatus: ScheduleSourceStatus;
  let freshnessText: string;
  if (revisionDates.some((date) => !isBroadcastDate(date)) ||
    checkedTimes.some((time) => !Number.isFinite(time) || time > exportedAt.getTime())) {
    sourceStatus = "invalid";
    freshnessText = "Source evidence is invalid or later than the export. Source freshness is unknown; listings may have changed.";
  } else {
    if (checkedTimes.length) sourceCheckedAt = new Date(Math.min(...checkedTimes)).toISOString();
    if (!days.length || unknownDayCount > 0) {
      sourceStatus = "unknown";
      freshnessText = days.length
        ? `Source freshness is unknown for ${unknownDayCount} listing ${unknownDayCount === 1 ? "date" : "dates"} with neither a PBS check nor a correction revision. Listings may have changed.`
        : "No listing dates were supplied. Source freshness is unknown.";
    } else if (!pbsCheckedDayCount) {
      sourceStatus = "corrected";
      freshnessText = "PBS retrieval checks do not apply to these corrected dates. Listings may change.";
    } else if (exportedAt.getTime() - Math.min(...checkedTimes) > SCHEDULE_STALE_AFTER_MS) {
      sourceStatus = "stale";
      freshnessText = "At least one PBS date was last retrieved more than 20 hours before export. Listings may have changed.";
    } else {
      sourceStatus = "fresh";
      freshnessText = "Every supplied PBS date was retrieved within 20 hours of export. Listings may still change.";
    }
  }
  const sourceCheckText = sourceCheckedAt
    ? `Last checked with PBS: ${formatScheduleExportInstant(sourceCheckedAt)} (oldest recorded check across ${pbsCheckedDayCount} PBS listing ${pbsCheckedDayCount === 1 ? "date" : "dates"}).`
    : correctedDayCount && !pbsDays.length
      ? `Last checked with PBS: Not applicable to the ${correctedDayCount} corrected listing ${correctedDayCount === 1 ? "date" : "dates"}.`
      : "Last checked with PBS: No valid check recorded.";
  const unknownText = unknownDayCount
    ? ` No check recorded for ${unknownDayCount} listing ${unknownDayCount === 1 ? "date" : "dates"} with no correction revision.`
    : "";
  return {
    sourceRevisionDates, correctedDayCount, pbsCheckedDayCount, unknownDayCount,
    sourceCheckedAt, sourceCheckText: sourceCheckText + unknownText, sourceStatus,
    notice: [correctionText, freshnessText].filter(Boolean).join(" "),
  };
}

/**
 * The normal sync requests today plus thirteen Eastern calendar dates using its
 * bake clock. Anchor to that same clock, so a later build cannot advance retained
 * data or expand the PDF to the full month supplied by dated corrections.
 * Call only with the corrected object from loadScheduleData, as the page does.
 */
export function buildScheduleExport(data: BakedScheduleData, exportedAt: Date): ScheduleExport {
  const startDate = scheduleDateKey(new Date(data.generatedAt));
  const start = new Date(`${startDate}T12:00:00Z`);
  const dates = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
  const endDate = dates[13];
  const rangeLabel = `${formatScheduleExportDate(startDate)} – ${formatScheduleExportDate(endDate)}`;
  const shortRangeLabel = new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
    year: startDate.slice(0, 4) === endDate.slice(0, 4) ? undefined : "numeric",
  }).formatRange(start, new Date(`${endDate}T12:00:00Z`)).replace(/\s*–\s*/, " - ");
  const byDate = new Map(data.days.broadcast.map((day) => [day.date, day]));
  const days = dates.flatMap((date) => {
    const day = byDate.get(date);
    return day ? [day] : [];
  });
  const missingDates = dates.filter((date) => !byDate.get(date)?.entries.length);
  return {
    startDate, endDate, dates,
    rangeLabel, shortRangeLabel, title: "NJ PBS schedule",
    days, dayCount: days.filter((day) => day.entries.length > 0).length,
    listingCount: days.reduce((total, day) => total + day.entries.length, 0),
    missingDates,
    coverageNotice: missingDates.length
      ? `Missing listings for: ${missingDates.map(formatScheduleExportDate).join("; ")}.`
      : "Listings are available for all 14 dates.",
    filename: `nj-pbs-schedule-${startDate}-to-${endDate}.pdf`,
    href: "/schedule/downloads/nj-pbs-schedule.pdf",
    sourceLabel: days.some((day) => day.sourceRevision)
      ? days.every((day) => day.sourceRevision) ? "NJ PBS replacement lineup" : "PBS TVSS and NJ PBS replacement lineup"
      : data.source === "pbs-tvss-with-njpbs-corrections" ? "PBS TVSS and NJ PBS episode details" : "PBS TVSS",
    generatedAt: data.generatedAt, exportedAt: exportedAt.toISOString(), timeZone: TVSS_TIME_ZONE,
    ...sourceState(days, exportedAt),
  };
}
