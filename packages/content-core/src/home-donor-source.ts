import { homeSourceObject, homeSourceText } from "./home-source-curation.ts";

export interface HomeDonorSource {
  source: "donor_advised_fund";
  actionHref: "/support/";
  content: { heading: string; summary?: string; actionLabel: string } | null;
  emptyReason: "missing" | null;
}

/** Reviewed editable copy with a fixed Support destination; never a free-link action. */
export function adaptHomeDonorAction(value: unknown): HomeDonorSource {
  if (value === null || value === undefined) return {
    source: "donor_advised_fund", actionHref: "/support/", content: null, emptyReason: "missing",
  };
  if (!homeSourceObject(value) || Object.keys(value).some(key => !["heading", "summary", "actionLabel", "href"].includes(key)) ||
    value.href !== "/support/" || !homeSourceText(value.heading, 120) || !homeSourceText(value.actionLabel, 120) ||
    value.summary !== undefined && !homeSourceText(value.summary, 2000)) throw new Error("Home donor action requires reviewed copy and /support/.");
  return { source: "donor_advised_fund", actionHref: "/support/",
    content: { heading: value.heading, actionLabel: value.actionLabel,
      ...(value.summary === undefined ? {} : { summary: value.summary as string }) }, emptyReason: null };
}
