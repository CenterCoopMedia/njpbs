import { describe, expect, it } from "vitest";
import guards from "../../functions/lib/frozen-library-publication.js";
import runtime from "../../functions/lib/cms-publication-runtime-control.js";

const release = "a".repeat(40);
const stopped = runtime.parseCmsPublicationRuntimeControl({ schemaVersion: 1, phase: "paused",
  commitSha: release, serializerId: "node-compute-publisher", cloud: {
    phase: "ready", commitSha: release, serializerId: "cloudflare-publisher",
  } });
const paired = { ...stopped, phase: "ready" };

describe("library publication after the node-compute stop", () => {
  // Refusals name the kind, the retired build and what stays live (Jules, October 13, 2026).
  it.each([
    ["program", "Program records cannot publish or unpublish since the full-site build was retired on October 13, 2026. Live program pages stay as they are. Ask an administrator."],
    ["event", "Event records cannot publish or unpublish since the full-site build was retired on October 13, 2026. Live event pages stay as they are. Ask an administrator."],
    ["sponsor", "Use Approve to publish this Sponsor card. It has no detail page and cannot be scheduled."],
    ["newsletter", "Use Approve to publish this Newsletter card. It has no detail page and cannot be scheduled."],
  ])("refuses new %s publication with a message that names the cause", (type, message) => {
    expect(guards.frozenLibraryPublicationMessage("cmsPosts", { type }, stopped)).toBe(message);
  });
  it.each(["cloudflare-publisher", "cloudflare-dev-publisher"])("preserves the freeze with primary %s ownership", serializerId => {
    expect(guards.frozenLibraryPublicationMessage("cmsPosts", { type: "program" }, {
      schemaVersion: 1, phase: "ready", commitSha: release, serializerId,
    })).toContain("Program records cannot publish or unpublish since the full-site build was retired");
  });
  it("permits Posts, Pages, Home, settings and media regardless of the stopped primary pin", () => {
    for (const [collection, type] of [["cmsPosts", "post"], ["cmsPages", "page"], ["cmsPages", "home"],
      ["cmsSettings", "public-site-chrome"], ["media_assets", "image"]]) {
      expect(guards.frozenLibraryPublicationMessage(collection, { type }, stopped)).toBeNull();
    }
  });
  it("retains the existing paired publisher behavior before the handoff", () => {
    expect(guards.frozenLibraryPublicationMessage("cmsPosts", { type: "program" }, paired)).toBeNull();
    expect(guards.frozenLibraryPublicationMessage("cmsPosts", { type: "sponsor" }, null)).toBeNull();
  });
});
