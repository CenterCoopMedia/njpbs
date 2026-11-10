import { uploadedImages } from "./shadow-posts/fixtures";

export const LEAD_LAYOUTS = ["standard", "special-report", "multimedia", "interactive"] as const;
export const LEAD_KINDS = ["image", "library-video", "linked-video", "embed"] as const;
export const leadFixturePoster = "https://media.njpbs.org/cms-media/news/uploaded-image/hash.webp";
export const leadFixtureVideo = `https://media.njpbs.org/cms-media/video/fixture-video/${"a".repeat(64)}.mp4`;
export const leadFixturePublic = { url: leadFixtureVideo,
  posterUrl: `https://media.njpbs.org/cms-media/video/fixture-video/${"b".repeat(64)}.jpg`,
  width: 1280, height: 720, mimeType: "video/mp4" };

/** Stable publication fixtures, shared by actual renderer and browser proofs. */
export function postLeadFixture(layout: typeof LEAD_LAYOUTS[number], kind: typeof LEAD_KINDS[number] | "invalid" | "legacy") {
  const read = structuredClone(uploadedImages.find(read => read.document.published.metadata.slug === `uploaded-${layout}-current`)!);
  const metadata = read.document.published.metadata as Record<string, unknown>;
  metadata.slug = `lead-${layout}-${kind}`;
  metadata.title = "Coastal voices: a New Jersey story";
  metadata.summary = "Community members share the places and people shaping their towns.";
  delete metadata.social; // Prove derived lead media drives the default share image.
  const data = { title: "Coastal voices", caption: "Produced by NJ PBS" };
  if (kind === "image") metadata.leadMedia = { kind, data: { assetId: "upload", alt: "Residents on the platform", caption: "Frozen lead caption" } };
  if (kind === "library-video") metadata.leadMedia = { kind, data: { ...data, sourceId: "video-library", assetId: "fixture-video", public: leadFixturePublic } };
  if (kind === "linked-video") metadata.leadMedia = { kind, data: { ...data, url: "https://watch.njpbs.org/video/coastal-voices/" }, posterAssetId: "upload" };
  if (kind === "embed") metadata.leadMedia = { kind, data: { ...data, url: "https://youtu.be/dQw4w9WgXcQ" }, posterAssetId: "upload" };
  if (kind === "invalid") metadata.leadMedia = { kind: "future", data: { url: "javascript:alert(1)" } };
  return read;
}
