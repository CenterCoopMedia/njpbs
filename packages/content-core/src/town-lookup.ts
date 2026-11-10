/** Page-owned copy; election values and geography stay in the reviewed local release. */
export interface TownLookupData {
  heading: string;
  introduction: string;
  sourceLine: string;
}

export const TOWN_LOOKUP_DEFAULTS: TownLookupData = {
  heading: "How your town voted",
  introduction: "Find your municipality to compare past presidential, U.S. Senate and U.S. House results, plus 2024 voter turnout.",
  sourceLine: "Historical results compiled by NJ Spotlight News from election records.",
};

export function isTownLookupData(value: unknown, complete = true): value is TownLookupData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !["heading", "introduction", "sourceLine"].includes(key))) return false;
  return typeof data.heading === "string" && data.heading.length <= 200 && (!complete || !!data.heading.trim())
    && typeof data.introduction === "string" && data.introduction.length <= 4000
    && typeof data.sourceLine === "string" && data.sourceLine.length <= 500;
}
