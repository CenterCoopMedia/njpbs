import { createHash } from "node:crypto";
import { createPublicArtifactInventoryReceipt } from "../../src/lib/public-artifact-inventory";
import type { PublicArtifactBundle } from "../../src/lib/public-artifact-bundle";
import { resolveCmsPreviewInput } from "../../src/lib/cms-preview-input";

export const now = new Date("2026-09-11T16:00:00.000Z");
export const rendererSha = "a".repeat(40);
export const cutoffAt = { seconds: Math.floor(now.getTime() / 1000), nanoseconds: 0, toMillis: () => now.getTime() };
export const reservation = {
  schemaVersion: 1 as const, buildBatchId: "released-build", generation: 1,
  status: "reserved" as const, commitSha: "b".repeat(40),
  reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null,
  reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt,
};
export const context: PublicArtifactBundle = {
  schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
  receipt: createPublicArtifactInventoryReceipt({
    reservation, pages: [], posts: [], programs: [], authors: [], settings: [],
  }),
};
export const blocks = [{
  id: "body", type: "prose", visible: true, order: 0,
  data: { content: { type: "doc", content: [{
    type: "paragraph", content: [{ type: "text", text: "Only this draft" }],
  }] } },
}];

export function input(kind: "cmsPages" | "cmsPosts" = "cmsPages", title = "Exact draft", queueId = "Q".repeat(20)) {
  const id = kind === "cmsPages" ? "contact" : "post-one";
  const snapshot = kind === "cmsPages"
    ? { id, version: 7, template: "genericPage", title, blocks }
    : { id, version: 7, blocks, published: {
      sourceVersion: 7, publishedAt: now.toISOString(), blocks,
      metadata: {
        type: "post", title, slug: "exact-story", previousSlugs: [],
        locale: "en", categories: ["News"], tags: [], summary: "Draft summary",
        editorialDateSource: "editorial", date: "2026-09-11",
      },
    } };
  return {
    schemaVersion: 2, queueId, pageId: id, sourceVersion: 7, rendererSha,
    ...(kind === "cmsPosts" ? { collection: kind } : {}),
    snapshot, assets: [], publicContext: structuredClone(context),
    expiresAtMs: now.getTime() + 60_000,
  };
}

export function fixture(value = input()) {
  const bytes = Buffer.from(JSON.stringify(value));
  const request = resolveCmsPreviewInput({
    CMS_CONTENT_MODE: "draft", CMS_PREVIEW_PAGE_ID: value.pageId,
    CMS_PREVIEW_QUEUE_ID: value.queueId, CMS_PREVIEW_RENDERER_SHA: rendererSha,
    CMS_PREVIEW_INPUT_PATH: "/private/input.json",
    CMS_PREVIEW_INPUT_SHA256: createHash("sha256").update(bytes).digest("hex"),
    ...(value.collection ? { CMS_PREVIEW_COLLECTION: value.collection } : {}),
  })!;
  return { value, bytes, request };
}
