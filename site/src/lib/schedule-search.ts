export interface ScheduleSearchCandidate {
  readonly title: string;
  readonly episodeTitle?: string;
}

export function normalizeScheduleSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function matchesScheduleSearch(
  candidate: ScheduleSearchCandidate,
  query: string,
): boolean {
  const normalizedQuery = normalizeScheduleSearchText(query);
  if (!normalizedQuery) return false;

  return [candidate.title, candidate.episodeTitle]
    .filter((value): value is string => Boolean(value))
    .some((value) => normalizeScheduleSearchText(value).includes(normalizedQuery));
}
