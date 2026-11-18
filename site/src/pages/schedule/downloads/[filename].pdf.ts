import type { APIRoute, GetStaticPaths } from "astro";
import { publicRootRoutesEnabled } from "../../../lib/build-target";
import { loadScheduleData } from "../../../lib/build/schedule-data";
import { buildScheduleExport, scheduleExportTime, type ScheduleExport } from "../../../lib/schedule-export";
import { renderSchedulePdf } from "../../../lib/schedule-pdf";

interface SchedulePdfProps {
  schedule: ScheduleExport;
}

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  if (!publicRootRoutesEnabled(process.env)) return [];
  const bakedSchedule = await loadScheduleData();
  const schedule = buildScheduleExport(bakedSchedule, scheduleExportTime());
  return [{ params: { filename: "nj-pbs-schedule" }, props: { schedule } }];
};

export const GET: APIRoute<SchedulePdfProps> = async ({ props }) => {
  const pdf = await renderSchedulePdf(props.schedule);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
    },
  });
};
