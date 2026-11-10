import { parsePublishInstant } from "../../../packages/content-core/src/publish-instant";
import { PUBLICATION_TIME_ZONE, publicationScheduleError } from "../../../packages/content-core/src/publication-schedule";
import { stationLocalToInstant, zonedLocalInstants } from "../../../packages/content-core/src/station-time";

export function formatPublicationTime(instant: string): string | null {
  const parsed = parsePublishInstant(instant);
  if (parsed === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PUBLICATION_TIME_ZONE,
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(parsed);
}

export function publicationTimeOptions(local: string): Array<{ instant: string; label: string }> {
  if (stationLocalToInstant(local) === null) return [];
  const [date, time] = local.split("T");
  return zonedLocalInstants(date, time.replace(":", ""), PUBLICATION_TIME_ZONE)
    .map(value => {
      const instant = new Date(value).toISOString();
      return { instant, label: formatPublicationTime(instant)! };
    });
}

export function resolvePublicationSchedule(local: string, occurrence: string, now: number) {
  const options = publicationTimeOptions(local);
  const instant = options.length === 1 ? options[0].instant
    : options.find(option => option.instant === occurrence)?.instant ?? null;
  let error: string | null;
  if (stationLocalToInstant(local) === null) error = "Choose a valid publication date and time.";
  else if (options.length === 0) error = "This time does not exist in New York because the clocks move forward. Choose another time.";
  else if (!instant) error = "This time occurs twice in New York. Choose EDT or EST.";
  else error = publicationScheduleError(Date.parse(instant), now);
  return { options, instant: error ? null : instant, error };
}
