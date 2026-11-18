import { readFile } from "node:fs/promises";
import { DEFAULT_SCHEDULE_DATA_PATH, type BakedScheduleData } from "./schedule-feed";
import { applyScheduleCorrections } from "./schedule-corrections";
import { assertScheduleInput } from "./schedule-input";
import { unavailableScheduleData } from "./schedule-view";

export async function loadScheduleData(
  env: Record<string, string | undefined> = process.env,
): Promise<BakedScheduleData> {
  const inputPath = env.SCHEDULE_DATA_PATH?.trim();
  const bytes = await readFile(inputPath || DEFAULT_SCHEDULE_DATA_PATH, "utf8").catch(error => {
    if (!inputPath && error.code === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return unavailableScheduleData();

  const generated: unknown = JSON.parse(bytes);
  assertScheduleInput(generated);
  return generated.source === "pbs-tvss" ? applyScheduleCorrections(generated) : generated;
}
