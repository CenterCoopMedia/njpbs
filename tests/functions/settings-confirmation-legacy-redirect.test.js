import { describe, expect, it } from "vitest";
import confirmation from "../../functions/lib/no-build-page-settings-confirmation.js";

// The public Worker answers /public-meetings/ from its legacy table before the
// CMS Page path. Production, October 14, 2026: 301, location
// https://njpbs.org/meeting-notices/, no x-njpbs-* headers (#3450).
const target = { origin: "https://njpbs.org" };
const receipt = { rendererSha: "f".repeat(40), contextRevision: 128, contextDigest: "a".repeat(64),
  codeGeneration: 298, path: "/public-meetings/" };
const decision = { kind: "redirect", path: "/public-meetings/", location: "/meeting-notices/", receipt };
const answer = (status, headers) => async () => new Response(null, { status, headers });
const read = fetchPublic => confirmation.readContextReceipt({ path: "/public-meetings/", decision, target, headers: {}, fetchPublic });

describe("settings confirmation of a route the legacy table owns", () => {
  it("accepts the legacy 301 to the Page's own destination", async () => {
    await expect(read(answer(301, { location: "https://njpbs.org/meeting-notices/" }))).resolves.toEqual({
      path: "/public-meetings/", identity: receipt, bodyDigest: null, legacyRedirect: true });
  });

  it("refuses a 301 to any other destination", async () => {
    for (const location of ["https://njpbs.org/contact/", "https://example.org/meeting-notices/", "/meeting-notices", "meeting-notices/"]) {
      await expect(read(answer(301, { location }))).rejects.toThrow("Page context receipt is unavailable.");
    }
  });

  it("keeps the full receipt check for a CMS answer", async () => {
    await expect(read(answer(301, { location: "/meeting-notices/", "x-njpbs-content-source": "cms-page-context" })))
      .rejects.toThrow("Page context receipt is unavailable.");
    await expect(read(answer(308, { location: "/meeting-notices/" })))
      .rejects.toThrow("Page context receipt is unavailable.");
  });
});
