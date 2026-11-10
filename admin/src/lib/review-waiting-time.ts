const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export function formatReviewWaitingTime(
  requestedAt: string | null,
  measuredAt: Date = new Date(),
): string {
  if (!requestedAt) return "Waiting time unavailable";

  const requestedTime = Date.parse(requestedAt);
  const elapsed = measuredAt.getTime() - requestedTime;
  if (
    !Number.isFinite(requestedTime) ||
    !Number.isFinite(elapsed) ||
    elapsed < 0
  ) {
    return "Waiting time unavailable";
  }

  const hours = Math.floor(elapsed / HOUR_MS);
  if (hours < 1) return "Under 1 hour";
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.floor(elapsed / DAY_MS);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }

  return "1 month or more";
}
