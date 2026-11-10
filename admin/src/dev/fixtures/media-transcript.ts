import type { TranscriptResponse, TranscriptSegment } from "../../lib/video-production";

// Synthetic 90-minute oral history. 115 of 180 passages are initially loaded.
// The first rows deliberately mix fragments, turns, identities and timing flags.
const opening = [
  "We started recording at the old ferry terminal, before the morning boats arrived.",
  "if",
  "need be, we can return after the tide changes.",
  "That building has served several different neighborhoods. The people who worked there remember a waiting room, a ticket counter and a small café. Each person tells the story a little differently, and the archive needs room for all of those accounts.",
  "I remember the café.",
  "Was it open in the winter?",
  "Sometimes. [Another voice overlaps.] We took turns opening it when the weather was rough.",
  "The photograph does not tell us who is standing at the window.",
  "Neither does this voice identify the person who spoke just before me.",
  "We should check the name against the recording and keep the uncertainty visible until then.",
  "There is a longer account in the volunteer notebook. It describes repairs to the roof, fundraising suppers, meetings with the ferry company and a winter when the walkway flooded. The volunteers disagreed about the dates. We kept both versions rather than treating the most confident voice as the only reliable witness.",
  "That is why the original timing and speaker assignments matter.",
];
export const mediaTranscriptSegments: TranscriptSegment[] = Array.from({ length: 180 }, (_, index) => ({
  index,
  startSeconds: index === 1 ? 8.12 : index === 2 ? 8.3 : index < 12 ? index === 0 ? 0 : index * 12 : index * 30,
  endSeconds: index === 1 ? 8.3 : index === 2 ? 11.94 : index < 12 ? index === 0 ? 7.8 : index * 12 + 10 : index * 30 + (index === 179 ? 30 : 24),
  speaker: ["spk_0", "spk_0", "spk_0", "spk_1", "spk_1", "spk_2", "spk_1", "unknown", "unknown", "spk_2", "spk_3", "spk_0"][index % 12],
  text: opening[index] ?? (index % 7 === 0
    ? `Archive turn ${index + 1}. ${"The volunteers describe the waterfront, the people who used it and the records that remain. A long answer needs to wrap naturally without hiding any words or changing its timing. ".repeat(9)}`
    : index % 3 === 0 ? `Yes. Archive fragment ${index + 1}.` : `Archive passage ${index + 1}: We compared the oral history with the photographs and kept each account attached to its source.`),
  ...(index === 6 ? { overlappingSpeech: true } : {}),
  ...(index === 9 || index === 37 ? { speakerUncertain: true } : {}),
}));

export function mediaTranscriptFixture(loaded = 115): TranscriptResponse {
  return {
    success: true, cached: true,
    nextCursor: loaded < 180 ? "synthetic-server-cursor-page-3" : null,
    transcript: {
      id: "synthetic-boardwalk-oral-history", state: "ready", editRevision: 7,
      totalSegments: 180, speakerIds: ["spk_0", "spk_1", "spk_2", "spk_3", "unknown"],
      speakerNames: { spk_0: "Alex Rivera", spk_1: "Jordan Chen", spk_2: "Dr. Samira Elizabeth Montgomery-Washington", spk_3: "Casey Morgan" },
      speakerRoles: { spk_0: "Oral history interviewer", spk_2: "Senior archivist, Waterfront Neighborhood Historical Association" },
    },
    segments: mediaTranscriptSegments.slice(0, loaded),
  };
}
