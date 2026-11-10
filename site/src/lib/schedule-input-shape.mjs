const TVSS_TIME_ZONE = "America/New_York";
function isScheduleFixture(value) { return typeof value === "object" && value !== null && "fixture" in value; }
function isBroadcastDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Validate real provider input without a loader, credential or runtime SDK. */
export function assertScheduleInputShape(value) {
  const data = value;
  if (!data || isScheduleFixture(data) ||
      !["pbs-tvss", "pbs-tvss-with-njpbs-corrections"].includes(data.source) ||
      typeof data.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt)) || data.timeZone !== TVSS_TIME_ZONE ||
      data.request?.station !== "WNJT" || !Array.isArray(data.request.dates) ||
      !data.request.dates.length || data.request.dates.length > 62 ||
      !data.request.dates.every(isBroadcastDate) || new Set(data.request.dates).size !== data.request.dates.length) {
    throw new Error("Generated PBS schedule data is invalid");
  }
  for (const kind of ["broadcast", "kids"]) {
    const days = data.days?.[kind];
    if (!Array.isArray(days) || !days.length || days.length > 62 || new Set(days.map(day => day?.date)).size !== days.length) {
      throw new Error("Generated PBS schedule data is invalid");
    }
    for (const day of days) {
      if (!day || !data.request.dates.includes(day.date) || day.kind !== kind || day.timeZone !== TVSS_TIME_ZONE ||
          !Array.isArray(day.entries) || !day.entries.length || day.entries.length > 200 ||
          day.entries.some(entry => !entry || typeof entry.title !== "string" || !entry.title.trim() || entry.title.length > 512 ||
            typeof entry.startsAt !== "string" || typeof entry.endsAt !== "string" ||
            !Number.isFinite(Date.parse(entry.startsAt)) || !Number.isFinite(Date.parse(entry.endsAt)) ||
            Date.parse(entry.endsAt) <= Date.parse(entry.startsAt))) {
        throw new Error("Generated PBS schedule data is invalid");
      }
    }
  }
}

