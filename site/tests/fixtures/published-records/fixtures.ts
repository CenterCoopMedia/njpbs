import { createHash } from "node:crypto";
import { projectCmsProgram } from "../../../src/lib/cms-programs-projection";
import { projectCmsEvent } from "../../../src/lib/cms-events-projection";
import { chromeSettings } from "../shadow-posts/chrome";
export const now = new Date("2026-10-12T12:00:00.000Z");
export type RecordScenario = "mixed" | "empty" | "withdrawn";
export const rendererSha = "a".repeat(40);
export const asset = { id: "record-art", url: "https://media.njpbs.org/cms-media/record-art/fixture.gif", mimeType: "image/gif", width: 960, height: 540 };
export type RecordArtFormat = "gif" | "jpeg" | "png" | "webp";
export function recordAsset(format: RecordArtFormat = "gif") {
  return { ...asset, url: asset.url.replace(".gif", `.${format}`), mimeType: `image/${format}` };
}
const richText = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "An immutable public description." }] }] };
export function recordDocument(kind: "program" | "event", id = `${kind}-one`) {
  return { id, version: 9, type: kind, status: "draft", publiclyVisible: true, deleted: false,
    title: "PRIVATE working title", published: { sourceVersion: 7, publishedAt: "2026-10-10T12:00:00.000Z",
      metadata: { type: kind, title: `Published ${kind}`, slug: `current-${id}`, previousSlugs: [`earlier-${id}`],
        locale: "en", description: structuredClone(richText), ...(kind === "program" ? {
          genre: "Documentary", memberOnly: true, keyArtAssetId: asset.id, keyArtAlt: "Public program art",
          watchUrl: "https://watch.njpbs.org/show/public-program/",
        } : { startsAt: "2026-10-20T23:00:00.000Z", endsAt: "2026-10-21T01:00:00.000Z",
          imageAssetId: asset.id, imageAlt: "Public event art", location: "Montclair", venueAddress: "1 Normal Ave",
          registrationUrl: "https://example.org/register", registrationLabel: "Reserve a seat", isFree: true }),
      } } };
}
export function recordRead(family: "programs" | "events", sha = rendererSha, scenario: RecordScenario = "mixed", format: RecordArtFormat = "gif") {
  const documents = [recordDocument(family === "programs" ? "program" : "event")];
  if (family === "events") {
    // Deliberately out of date order: the unchanged index owns sorting and
    // groups an event by its end, so an event already underway stays upcoming.
    for (const [id, startsAt, endsAt] of [
      ["past-older", "2026-09-01T23:00:00.000Z", "2026-09-02T01:00:00.000Z"],
      ["upcoming-earlier", "2026-10-13T23:00:00.000Z", "2026-10-14T01:00:00.000Z"],
      ["past-recent", "2026-10-10T23:00:00.000Z", "2026-10-11T01:00:00.000Z"],
      ["ongoing", "2026-10-12T11:00:00.000Z", "2026-10-12T13:00:00.000Z"],
    ]) {
      const document = recordDocument("event", id);
      Object.assign(document.published.metadata, { title: `Published ${id}`, startsAt, endsAt });
      documents.push(document);
    }
  }
  if (scenario === "withdrawn") for (const document of documents) document.publiclyVisible = false;
  return { kind: "published-record-family", family, complete: true,
    documents: scenario === "empty" ? [] : documents, assets: [recordAsset(format)],
    settings: chromeSettings("Exact record newsletter"), navigationPages: [],
    sourceSeal: { rendererSha: sha, contextRevision: 4,
      contextDigest: createHash("sha256").update("njpbs-public-context-v1:4").digest("hex") } };
}
export function staticRecordContent(scenario: RecordScenario = "mixed", format: RecordArtFormat = "gif") {
  const assets = new Map([[asset.id, recordAsset(format)]]);
  return {
    programs: recordRead("programs", rendererSha, scenario).documents.flatMap(document => {
      const record = projectCmsProgram(document, { now, assets });
      return record ? [record] : [];
    }),
    events: recordRead("events", rendererSha, scenario).documents.flatMap(document => {
      const record = projectCmsEvent(document, { now, assets });
      return record ? [record] : [];
    }),
  };
}
