import type { BakedScheduleData } from "./schedule-feed";
import { applyScheduleCorrections } from "./schedule-corrections";

/** Public page projection requires its qualified schedule context upstream. */
export async function loadScheduleData(committed: BakedScheduleData): Promise<BakedScheduleData> {
  return applyScheduleCorrections(committed);
}
