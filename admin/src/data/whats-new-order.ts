export interface WhatsNewNote {
  date: string;
  kind: "new" | "improved" | "fixed";
  title: string;
  body: string;
  prs: readonly number[];
  order?: number;
  requires?: "video-replacement";
}

export function sortWhatsNewNotes(fragments: Record<string, WhatsNewNote>, videoReplacementEnabled = false): WhatsNewNote[] {
  return Object.entries(fragments)
    .filter(([, note]) => note.requires !== "video-replacement" || videoReplacementEnabled)
    .sort(([leftFile, left], [rightFile, right]) =>
      right.date.localeCompare(left.date)
      || (right.order ?? 0) - (left.order ?? 0)
      || leftFile.localeCompare(rightFile, "en"))
    .map(([, note]) => note);
}
