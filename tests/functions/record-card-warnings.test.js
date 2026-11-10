import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { recordCardSaveWarnings } = require("../../functions/lib/record-card-warnings.js");
const card = (id, kind, recordId) => ({ id, type: "record_card", data: { recordKind: kind, recordId } });
function database(records, history = []) {
  const doc = vi.fn(id => ({ get: async () => ({ exists: id in records, data: () => records[id] }) }));
  const query = (filters = []) => ({ where: (field, _op, value) => query([...filters, [field, value]]),
    get: async () => ({ docs: history.filter(row => filters.every(([field, value]) => row[field] === value))
      .map(row => ({ data: () => row })) }) });
  return { doc, collection: name => name === "cmsPosts" ? { doc } : query() };
}
const approval = (id, kind, version = 3) => ({ collection: "cmsPosts", documentId: id, action: "approve",
  after: { type: kind, status: "approved", version } });

describe("record card save warnings", () => {
  it("warns for missing, archived and mismatched records without rejecting a save", async () => {
    const firestore = database({ live: { type: "program", status: "published" },
      archived: { type: "sponsor", status: "archived" }, wrong: { type: "post", status: "published" } });
    const warnings = await recordCardSaveWarnings(firestore, { blocks: [card("one", "program", "live"),
      card("two", "event", "missing"), card("three", "sponsor", "archived"), card("four", "newsletter", "wrong")] });
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).toContain("will be hidden on the public site");
  });

  it.each(["sponsor", "newsletter"])("uses retained approval for %s warning eligibility", async kind => {
    const live = { type: kind, status: "draft", publiclyVisible: false, version: 8 };
    const records = { live, missingApproval: { ...live, status: "approved" }, wrongKind: live,
      invalidVersion: live, withdrawn: live };
    const history = [approval("live", kind), approval("wrongKind", "post"), approval("invalidVersion", kind, 0),
      approval("withdrawn", kind), { collection: "cmsPosts", documentId: "withdrawn", action: "unpublish", after: { version: 4 } }];
    const warnings = await recordCardSaveWarnings(database(records, history), {
      blocks: Object.keys(records).map(id => card(id, kind, id)),
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.every(warning => warning.includes("no approved version") && warning.includes("will be hidden on the public site"))).toBe(true);
    expect(warnings.some(warning => warning.startsWith("Record card live:"))).toBe(false);
  });

  it("warns for unapproved signup and sponsor-strip targets and reads each target once", async () => {
    const firestore = database({ newsletter: { type: "newsletter", status: "draft", version: 1 },
      sponsor: { type: "sponsor", status: "approved", version: 3 } });
    const warnings = await recordCardSaveWarnings(firestore, { blocks: [
      { id: "signup", type: "newsletter_signup", data: { newsletterIds: ["newsletter", "missing"] } },
      { id: "strip", type: "sponsor_strip", data: { sponsorIds: ["sponsor"] } }, card("card", "newsletter", "newsletter"),
    ] });
    expect(firestore.doc).toHaveBeenCalledTimes(3);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain("Newsletter signup signup:");
    expect(warnings[1]).toContain("missing or archived");
    expect(warnings[2]).toContain("Sponsor strip strip:");
    expect(warnings[3]).toContain("Record card card:");
  });
  it("caps advisory target reads on pages with many strips", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `sponsor-${index}`);
    const firestore = database(Object.fromEntries(ids.map(id => [id, { type: "sponsor", status: "draft", version: 1 }])));
    const warnings = await recordCardSaveWarnings(firestore, { blocks: ids.map(id => ({
      id, type: "sponsor_strip", data: { sponsorIds: [id] },
    })) });
    expect(firestore.doc).toHaveBeenCalledTimes(24);
    expect(warnings.at(-1)).toContain("Some record card references could not be checked");
    expect(warnings.some(warning => warning.startsWith("Sponsor strip sponsor-24:"))).toBe(false);
  });

  it("returns advisory guidance at the deadline even when Firestore does not respond", async () => {
    vi.useFakeTimers();
    try {
      const firestore = { collection: () => ({ doc: () => ({ get: () => new Promise(() => {}) }) }) };
      const pending = recordCardSaveWarnings(firestore, { blocks: [card("slow", "sponsor", "slow")] });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual(["Some record card references could not be checked. Reopen this content to verify them."]);
    } finally {
      vi.useRealTimers();
    }
  });

});
