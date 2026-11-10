import { describe, expect, it } from "vitest";
import { serviceCompositionError, usesServiceComposition } from "../../packages/content-core/src/service-composition";
import { projectCmsPage } from "../src/lib/cms-loader";

const document = {
  id: "support", template: "programLanding", title: "Support NJ PBS", description: "Staff summary",
  publishAt: "2026-10-05T12:00:00.000Z", status: "published", publiclyVisible: true, version: 8,
  serviceCompositionVersion: 1,
  blocks: [],
  published: {
    metadata: { title: "Public support", serviceCompositionVersion: 1 },
    blocks: [], sourceVersion: 7, publishedAt: "2026-10-05T12:00:00.000Z", publishedBy: "editor",
  },
};

describe("service composition ownership", () => {
  it("keeps the template for unmarked pages, including an empty block list", () => {
    expect(usesServiceComposition({ family: "service", blocks: [] })).toBe(false);
    expect(serviceCompositionError("support", undefined)).toBeNull();
  });
  it("retains CMS ownership when staff removes every block", () => {
    expect(usesServiceComposition({ family: "service", serviceCompositionVersion: 1 })).toBe(true);
    expect(serviceCompositionError("support", 1)).toBeNull();
  });
  it.each(["support", "give", "passport", "about", "watch", "live", "kids"])("allows %s to opt in", id => {
    expect(serviceCompositionError(id, 1)).toBeNull();
  });
  it("rejects unknown versions and non-service pages", () => {
    expect(serviceCompositionError("support", 2)).toMatch(/version/);
    expect(serviceCompositionError("contact", 1)).toMatch(/service/);
  });
  it("serializes the immutable published mode independently of the draft", () => {
    const page = projectCmsPage({ ...document, serviceCompositionVersion: undefined }, { mode: "published", now: new Date("2026-10-06T12:00:00Z") });
    expect(page).toMatchObject({ title: "Public support", serviceCompositionVersion: 1, blocks: [] });
  });
  it("keeps the public template while the draft opts in", () => {
    const doc = { ...document, published: { ...document.published, metadata: { title: "Old public support" } } };
    expect(projectCmsPage(doc, { mode: "published", now: new Date("2026-10-06T12:00:00Z") })?.serviceCompositionVersion).toBeUndefined();
    expect(projectCmsPage(doc, { mode: "draft", pageId: "support", now: new Date("2026-10-06T12:00:00Z") })?.serviceCompositionVersion).toBe(1);
  });
  it("fails closed for a malformed published version", () => {
    expect(() => projectCmsPage({ ...document, published: { ...document.published,
      metadata: { title: "Support", serviceCompositionVersion: 2 },
    } }, { mode: "published", now: new Date("2026-10-06T12:00:00Z") })).toThrow(/version/);
  });
});
