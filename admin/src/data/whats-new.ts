// Staff-facing Boardwalk notes. Add one JSON note file for each change.
import { sortWhatsNewNotes, type WhatsNewNote } from "./whats-new-order";
export type { WhatsNewNote } from "./whats-new-order";

// Eager imports join the existing lazy notes chunk, with no per-note requests.
const fragments = import.meta.glob<WhatsNewNote>("./whats-new/*.json", {
  eager: true,
  import: "default",
});

export const WHATS_NEW_NOTES: readonly WhatsNewNote[] = sortWhatsNewNotes(fragments, import.meta.env.VITE_VIDEO_REPLACEMENT_ENABLED === "true");
