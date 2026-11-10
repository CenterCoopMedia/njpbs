// @vitest-environment node
import { describe, expect, it } from "vitest";
import publicCopy from "./fixtures/home-sources/donor-public-copy.json";
import { adaptHomeDonorAction } from "../../packages/content-core/src/home-donor-source";

describe("Home donor-advised fund source", () => {
  it("preserves editable source copy and the fixed existing Support destination", () => {
    const result = adaptHomeDonorAction({ ...publicCopy, actionLabel: "See how to give" });
    expect(result).toEqual({ source: "donor_advised_fund", actionHref: "/support/", content: {
      heading: "Give to NJ PBS through your donor advised fund",
      summary: "Already have a donor advised fund? It's one of the easiest ways to support NJ PBS.", actionLabel: "See how to give",
    }, emptyReason: null });
    expect(adaptHomeDonorAction(null)).toMatchObject({ source: "donor_advised_fund", content: null, emptyReason: "missing" });
  });

  it("rejects every other destination and unsupported saved field", () => {
    for (const href of ["https://njpbs.org/support/", "/support", "/give/", "https://example.test/daf", "javascript:alert(1)"]) {
      expect(() => adaptHomeDonorAction({ ...publicCopy, actionLabel: "Give", href })).toThrow();
    }
    expect(() => adaptHomeDonorAction({ ...publicCopy, actionLabel: "Give", style: "custom" })).toThrow();
    expect(() => adaptHomeDonorAction({ ...publicCopy, actionLabel: " " })).toThrow();
  });
});
