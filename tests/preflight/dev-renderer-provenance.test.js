import { describe, expect, it } from "vitest";
import { devRendererProvenance } from "../../site/scripts/cms-dev-publication.mjs";

// The dev site upload runs before the dev CMS deploy can write a unified
// renderer receipt (the CMS deploy's compatibility floor needs the dev site at
// its commit first). The upload records the renderer provenance it can prove.
const services = [{ binding: "PREVIEW_RENDERER", service: "template-dev-cms-preview-renderer" }];
const sha = "3".repeat(40);

describe("dev site upload renderer provenance", () => {
  it("records no unified receipt for a fresh dev project", () => {
    expect(devRendererProvenance(null, services)).toEqual({ renderer: "no unified receipt" });
  });

  it("records no unified receipt for a receipt from the retired dev renderer workflow without reading its fields", () => {
    const legacy = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", state: "complete",
      sourceSha: sha, releaseStartedAt: "2026-11-20T00:00:00.000Z", provider: {}, verifiedAt: "2026-11-20T00:00:00.000Z" };
    expect(devRendererProvenance(legacy, services)).toEqual({ renderer: "no unified receipt" });
  });

  it("refuses a unified receipt that is still in progress", () => {
    const receipt = { schemaVersion: 1, component: "renderer", state: "in_progress",
      mutation: { sourceSha: sha }, lastComplete: null };
    expect(devRendererProvenance(receipt, services)).toBeNull();
  });

  it("refuses a complete unified receipt without a full source SHA", () => {
    expect(devRendererProvenance({ state: "complete", mutation: { sourceSha: "3".repeat(39) } }, services)).toBeNull();
  });

  it("records the source SHA of a complete unified receipt", () => {
    const receipt = { schemaVersion: 1, component: "renderer", state: "complete", mutation: { sourceSha: sha } };
    expect(devRendererProvenance(receipt, services)).toEqual({ rendererSourceSha: sha });
  });

  it("keeps the unbound-renderer case", () => {
    expect(devRendererProvenance(null, undefined)).toEqual({ renderer: "not deployed" });
  });
});
