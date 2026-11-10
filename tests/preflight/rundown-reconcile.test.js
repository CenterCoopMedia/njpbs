import { describe, it, expect } from "vitest";
import reconcile from "../../functions/lib/rundown-reconcile.js";
import parser from "../../functions/lib/rundown-marker-parser.js";
import structure from "../../functions/lib/rundown-document-structure.js";
import { rundownDocument, sourceConfig } from "../fixtures/rundown.js";

const changes = (...args) => reconcile.reconcileCandidates(...args).changes;
const text = headline => ({ templateId: "headline", headline });
function parsed(headline = "BANNER: SYNTHETIC CITY HEARING") {
  return parser.extractMarkedBanners({ ...structure.structureDocument(rundownDocument(headline), sourceConfig), generation: 1 });
}
function banner(candidate, id = "first") {
  return { order: candidate.order, source: "rundown", archived: false,
    record: { id, draft: { version: 1, text: candidate.text } }, rundown: {
      contextKey: candidate.contextKey, contentKey: reconcile.contentKey(candidate), rawLines: candidate.rawLines,
      sourceFingerprint: candidate.fingerprint, acceptedText: candidate.text, acceptedOrder: candidate.order, removedFingerprint: null,
    } };
}
describe("conservative rundown identity reconciliation", () => {
  it("distinguishes new, changed, removed and reordered items without merging duplicate words", () => {
    const before = parsed(), existing = banner(before.proposals[0]);
    expect(changes(before, [])[0].status).toBe("NEW");
    expect(changes(before, [existing])).toHaveLength(1); // Only the second new proposal.
    expect(changes(parsed("BANNER: CHANGED SOURCE"), [existing])[0]).toMatchObject({ status: "CHANGED", target: { bannerId: "first" } });
    const removed = { ...before, sourceHash: "changed", proposals: [] };
    expect(changes(removed, [existing])[0].status).toBe("REMOVED");
    const movedCandidate = { ...before.proposals[0], order: 5, fingerprint: "reordered" };
    expect(changes({ ...before, proposals: [movedCandidate] }, [existing])[0].status).toBe("MOVED");
    const duplicates = [{ ...existing }, { ...existing, record: { ...existing.record, id: "second" } }];
    const ambiguous = changes({ ...before, proposals: [before.proposals[0]] }, duplicates)[0];
    expect(ambiguous).toMatchObject({ status: "AMBIGUOUS", target: null });
    expect(ambiguous.possibleTargets.map(target => target.bannerId)).toEqual(["first", "second"]);
  });
  it("requires a human identity choice for an exact passage moved between tabs or segments", () => {
    const before = parsed(), existing = banner(before.proposals[0]);
    const moved = { ...before.proposals[0], contextKey: "different-context", tabId: "other", fingerprint: "moved" };
    const result = changes({ ...before, proposals: [moved] }, [existing]);
    expect(result[0]).toMatchObject({ status: "AMBIGUOUS", target: null });
    expect(result[0].possibleTargets[0].bannerId).toBe("first");
    expect(result[1].status).toBe("REMOVED");
  });
  it("protects edited fields and order, including protection retained across another accepted revision", () => {
    const existing = banner(parsed().proposals[0]);
    existing.record.draft = { version: 2, text: text("MANUAL PRODUCER EDIT") };
    existing.order = 9;
    expect(reconcile.protectedFields(existing)).toEqual(["headline", "order"]);
    expect(reconcile.acceptedText(existing, text("NEW SOURCE"), [])).toEqual(text("MANUAL PRODUCER EDIT"));
    expect(reconcile.acceptedText(existing, text("NEW SOURCE"), ["headline"])).toEqual(text("NEW SOURCE"));
    existing.rundown.acceptedText = existing.record.draft.text;
    existing.rundown.protectedFields = ["headline", "order"];
    expect(reconcile.acceptedText(existing, text("LATER SOURCE"), [])).toEqual(text("MANUAL PRODUCER EDIT"));
    expect(() => reconcile.acceptedText(existing, { templateId: "name_title", name: "EXAMPLE", title: "REPORTER" }, [])).toThrow(/protected/);
  });
  it("drops protected fields that belong to a former template", () => {
    const existing = banner(parsed().proposals[1]);
    existing.rundown.protectedFields = ["title"];
    existing.record.draft.text = text("MANUALLY SWITCHED TEMPLATE");
    expect(reconcile.protectedFields(existing)).toEqual(["templateId", "headline"]);
    expect(reconcile.acceptedText(existing, text("SOURCE"), [])).toEqual(text("MANUALLY SWITCHED TEMPLATE"));
  });
  it("keeps a manual order while changing template text", () => {
    const existing = banner(parsed().proposals[0]); existing.order = 9;
    const proposed = { templateId: "name_title", name: "SYNTHETIC NAME", title: "REPORTER" };
    expect(reconcile.protectedFields(existing)).toEqual(["order"]);
    expect(reconcile.acceptedText(existing, proposed, [])).toEqual(proposed);
  });
});
