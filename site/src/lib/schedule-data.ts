import { readFile } from "node:fs/promises";
import type { BakedScheduleData } from "./schedule-feed";
import { applyScheduleCorrections } from "./schedule-corrections";
import { assertScheduleInput } from "./schedule-input";

export async function loadScheduleData(
  committed: BakedScheduleData,
  env: Record<string, string | undefined> = process.env,
): Promise<BakedScheduleData> {
  const inputPath = env.SCHEDULE_DATA_PATH?.trim();
  if (!inputPath) return applyScheduleCorrections(committed);

  const generated: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  assertScheduleInput(generated);
  return applyScheduleCorrections(generated);
}
