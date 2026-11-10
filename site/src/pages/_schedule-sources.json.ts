import type { APIRoute } from "astro";
import { getEntry } from "astro:content";
import scheduleData from "../data/schedule.json";
import type { BakedScheduleData } from "../lib/schedule-feed";
import { createScheduleSourceSnapshot } from "../lib/schedule-source-snapshot";
import { loadScheduleData } from "../lib/schedule-data";

export const prerender = true;

export const GET: APIRoute = async () => {
  // The Home loader already reads and validates this build's reserved bundle.
  // Reuse its public receipt; do not fetch another Firestore snapshot here.
  const context = await getEntry("publicHomeSources", "home");
  if (!context) throw new Error("The public source context is missing");
  const bakedSchedule = await loadScheduleData(scheduleData as BakedScheduleData);
  const snapshot = createScheduleSourceSnapshot(bakedSchedule, context.data.publication);
  return new Response(`${JSON.stringify(snapshot)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
