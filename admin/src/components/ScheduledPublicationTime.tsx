import { formatPublicationTime } from "../lib/publication-schedule";

export function ScheduledPublicationTime({ status, publishAt, className = "editor-field-help" }: {
  status?: string;
  publishAt?: string;
  className?: string;
}) {
  const formatted = status === "scheduled" && publishAt ? formatPublicationTime(publishAt) : null;
  return formatted ? <time className={className} dateTime={publishAt}>Scheduled: {formatted}</time> : null;
}
