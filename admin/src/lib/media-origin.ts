import type { MediaAssetSummary } from "./functions";

/** Staff wording for the existing source value; it is separate from Category. */
export function mediaOriginLabel(source: MediaAssetSummary["source"]): string {
  if (source === "site_seed") return "Site build";
  if (source === "upload") return "Uploaded";
  if (source === "voiceover") return "Voiceover";
  return "Not recorded";
}
