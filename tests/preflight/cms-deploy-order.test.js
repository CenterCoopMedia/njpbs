import { describe, expect, it } from "vitest";
import { blockedBy } from "../../scripts/lib/cms-deploy-order.mjs";

describe("CMS deploy step order", () => {
  // Nov. 25, 2026, production run 1: the Functions deploy failed and the renderer still went live,
  // so the new renderer served old Functions and previews answered 503 until run 2.
  it("holds the renderer and Studio connector back on production when the Functions deploy failed", () => {
    expect(blockedBy("renderer", ["firebase"], false)).toEqual(["firebase"]);
    expect(blockedBy("studio", ["firebase"], false)).toEqual(["firebase"]);
  });
  it("runs every step on development so one run shows every fault", () => {
    for (const name of ["renderer", "studio", "cms-api", "admin-deploy"]) expect(blockedBy(name, ["firebase"], true)).toEqual([]);
  });
  it("always runs the smoke", () => {
    expect(blockedBy("smoke", ["firebase", "renderer"], false)).toEqual([]);
  });
});
