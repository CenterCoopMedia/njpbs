import { loadScheduleData as loadFrozenScheduleData } from "../schedule-data";
import { TVSS_TIME_ZONE, TVSS_WNJT_FEED_CID, type BakedScheduleData, type ScheduleFeedDay } from "../schedule-feed";
import { scheduleDateKey } from "../schedule-view";

export const DEFAULT_SCHEDULE_DATA_PATH = ".schedule-cache/schedule.json";

function unavailableScheduleData(): BakedScheduleData {
  const now = new Date();
  const date = scheduleDateKey(now);
  const day: Omit<ScheduleFeedDay, "kind"> = {
    date, callsign: "wnjt", timeZone: TVSS_TIME_ZONE, feedCid: TVSS_WNJT_FEED_CID, entries: [],
  };
  return {
    source: "pbs-tvss", generatedAt: now.toISOString(), timeZone: TVSS_TIME_ZONE,
    request: { station: "WNJT", dates: [date] },
    days: { broadcast: [{ ...day, kind: "broadcast" }], kids: [{ ...day, kind: "kids" }] },
  };
}

export async function loadScheduleData(env: Record<string, string | undefined> = process.env): Promise<BakedScheduleData> {
  const inputPath = env.SCHEDULE_DATA_PATH?.trim();
  const unavailable = unavailableScheduleData();
  try {
    return await loadFrozenScheduleData(unavailable, { SCHEDULE_DATA_PATH: inputPath || DEFAULT_SCHEDULE_DATA_PATH });
  } catch (error) {
    if (!inputPath && error instanceof Error && "code" in error && error.code === "ENOENT") return unavailable;
    throw error;
  }
}
