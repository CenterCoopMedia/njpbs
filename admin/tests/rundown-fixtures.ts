import type { RundownClient, RundownReview, SourceView } from "../src/lib/rundown-intake";
export function sourceView(): SourceView {
  return { source: { configVersion: 1, generation: 1, config: { documentId: "synthetic_doc", tabIds: ["show"], enabled: true },
    status: "current", nextAttemptAtMs: 25000, checkedAtMs: 0 }, snapshot: { hash: "synthetic-hash", diagnostics: [], expiresAtMs: 86400000 }, serverNowMs: 0 };
}
export function reviewView(): RundownReview {
  return { version: 1, sourceGeneration: 1, sourceHash: "synthetic-hash", expiresAtMs: 86400000, changes: [
    { id: "headline-change", fingerprint: "changed-headline", status: "CHANGED", target: { bannerId: "headline-banner", baseVersion: 1,
      text: { templateId: "headline", headline: "SYNTHETIC PRIOR HEADLINE" }, order: 4, protectedFields: ["headline", "order"] }, possibleTargets: [],
      reasons: ["Producer-edited fields stay protected unless explicitly selected."], candidate: { id: "source-headline", text: { templateId: "headline", headline: "SYNTHETIC CITY HEARING" },
        rawLines: ["SYNTHETIC CITY HEARING"], tabTitle: "Selected show", segmentTitle: "City hearing", order: 0,
        passages: [{ sourceId: "show:body/1", location: "body/1", text: "BANNER: SYNTHETIC CITY HEARING" }] } },
    { id: "ambiguous-change", fingerprint: "ambiguous-lines", status: "AMBIGUOUS", target: null, possibleTargets: [], reasons: ["ambiguous_grouping"],
      candidate: { id: "source-name", text: null, rawLines: ["ALEX EXAMPLE", "SYNTHETIC REPORTER"], tabTitle: "Selected show", segmentTitle: "Interview", order: 1,
        passages: [{ sourceId: "show:body/3", location: "body/3", text: "ALEX EXAMPLE\nSYNTHETIC REPORTER" }] } },
  ] };
}
export function fakeRundownClient(): RundownClient {
  let view = sourceView(), review = reviewView();
  return {
    source: async () => structuredClone(view), refresh: async () => structuredClone(view),
    configure: async (_sessionId, base, config) => { view = { ...view, source: { ...view.source, configVersion: base + 1, config } }; return structuredClone(view); },
    extract: async () => {}, reconcile: async () => structuredClone(review),
    decide: async body => {
      review = { ...review, version: review.version + 1, changes: review.changes.filter(change => change.id !== body.suggestionId) };
      return { decision: body.action === "ignore" ? "ignored" : "accepted", bannerId: body.action === "ignore" ? null : "headline-banner", draftVersion: body.action === "ignore" ? null : 2 };
    },
  };
}
