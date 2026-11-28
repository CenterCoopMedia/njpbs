import { useEffect, useState } from "react";
import type { MediaAssetSummary } from "../lib/functions";
import { commentThreads, threadMatches, type CommentFilter } from "../lib/media-comment-threads";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import { GALLERY_MEDIA } from "./gallery-media-fixtures";

const GALLERY_MIXED_IMAGE: MediaAssetSummary = {
  ...GALLERY_MEDIA[0],
  id: "gallery-mixed-image",
  name: "Statehouse newsroom still",
  originalName: "statehouse-newsroom-still.svg",
  category: "news",
  categories: ["news"],
  tags: ["newsroom", "statehouse"],
  description: "A local image fixture in a mixed media set.",
  altText: "Blue circles arranged over a navy field",
  mimeType: "image/svg+xml",
  sizeBytes: 48_210,
  width: 960,
  height: 540,
  url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#123354"/><circle cx="360" cy="270" r="116" fill="#67b7df"/><circle cx="600" cy="270" r="116" fill="#ffffff" opacity=".88"/></svg>')}`,
};
const GALLERY_MIXED_DOCUMENT: MediaAssetSummary = {
  ...GALLERY_MEDIA.find(asset => asset.kind === "document")!,
  id: "gallery-mixed-document",
  name: "Field production guide",
  originalName: "field-production-guide.pdf",
  description: "A local PDF fixture in a mixed media set.",
  url: "#gallery-mixed-document",
};
const GALLERY_MIXED_VIDEO: SourceMediaAssetSummary = {
  id: "gallery-mixed-video",
  sourceId: "archive",
  name: "Archive interview excerpt",
  description: "A local private-video fixture in a mixed media set.",
  originalName: "archive-interview.mov",
  mimeType: "video/quicktime",
  kind: "video",
  sizeBytes: 18_432_000,
  preview: "download_only",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  tags: ["interview", "archive"],
  rightsStatus: "pending",
  version: 2,
  uploadedBy: { name: "Archive team" },
  createdAt: "2026-08-18T14:00:00.000Z",
  updatedAt: "2026-08-20T13:00:00.000Z",
};

export function galleryJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function galleryWavBytes(): Uint8Array {
  const sampleRate = 48_000;
  const channels = 1;
  const bytesPerSample = 2;
  const dataBytes = sampleRate * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  }
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

export function useGalleryMediaTransport(): () => Promise<string> {
  const [transport] = useState(() => {
    const originalFetch = window.fetch;
    let installed = false;
    const privateWav = galleryWavBytes();
    let voiceoverReview = {
      favorite: true,
      moreLikeThis: false,
      notes: "Use this warm station identification.",
      version: 1,
      updatedAt: "2026-09-12T12:00:00.000Z",
    };
    const mediaReviews = new Map<string, { moreLikeThis: boolean; notes: string; version: number; updatedAt: string | null }>();
    const commentsByRef = new Map<string, Array<{
      id: string; authorUid: string; authorName: string; text: string; version: number;
      createdAt: string; updatedAt: string; canEdit: boolean;
    }>>();
    const commentIdsByRequest = new Map<string, string>();
    let createdCommentCount = 0;
    const feedbackKey = (ref: unknown) => JSON.stringify(ref);
    const commentsFor = (ref: unknown) => {
      const key = feedbackKey(ref);
      const existing = commentsByRef.get(key);
      if (existing) return existing;
      const seeded = [
        { id: "a".repeat(64), authorUid: "gallery-audio", authorName: "Alex Rivera",
          text: "The clean opening works well for promos.", version: 1,
          createdAt: "2026-10-04T14:30:00.000Z", updatedAt: "2026-10-04T14:30:00.000Z", canEdit: true },
        { id: "b".repeat(64), authorUid: "producer", authorName: "Riley Chen",
          text: "Keep the room tone at the end for a smoother edit.", version: 1,
          createdAt: "2026-10-04T15:05:00.000Z", updatedAt: "2026-10-04T15:05:00.000Z", canEdit: false },
      ];
      commentsByRef.set(key, seeded);
      return seeded;
    };
    const audioRecords: MediaAssetSummary[] = [{ ...GALLERY_MIXED_DOCUMENT,
      id: "station-interview", name: "Station interview", originalName: "station-interview.wav",
      category: "news", categories: ["news"], tags: ["interview"], altText: null,
      mimeType: "audio/wav", kind: "audio", source: "upload", license: null, credit: null,
      url: "https://media.example.test/station-interview.wav", sizeBytes: 96_044,
      etag: '"media.station-interview.1"', description: "A station interview uploaded by staff." },
    { ...GALLERY_MIXED_DOCUMENT,
      id: "voiceover-soft-spoken-station-id-01", name: "Station identification",
      originalName: "soft-spoken-station-id-01.wav", category: "news", categories: ["news"],
      tags: ["voiceover", "soft-spoken"], description: "You're watching NJ PBS.", altText: null,
      mimeType: "audio/wav", kind: "audio", source: "voiceover", license: null,
      credit: "Jordan Avery", sizeBytes: privateWav.byteLength,
      url: "https://admin.njpbs.org/media/voiceovers?asset=voiceover-soft-spoken-station-id-01",
      etag: '"media.voiceover-soft-spoken-station-id-01.1"',
      voiceoverTakeId: "soft-spoken-station-id-01",
      voiceover: { manifestVersion: 1, id: "soft-spoken-station-id-01",
        family_id: "station-id", family: "Station identification", take: 1,
        style: "soft-spoken", performer_id: "jordan-avery", performer_name: "Jordan Avery",
        text: "You're watching NJ PBS.", display_text: "You're watching NJ PBS.",
        complete: true, flags: [], duration_seconds: 1 } }];
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const url = new URL(rawUrl, window.location.href);
      const endpoint = url.pathname.split("/").pop();
      let request: Record<string, unknown> = {};
      if (typeof init?.body === "string") {
        try {
          request = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          return galleryJsonResponse({ error: "Invalid gallery fixture request." }, 400);
        }
      }
      if (endpoint === "cmsSourceMediaOriginal") return galleryJsonResponse({ success: true,
        original: { state: "available", archiveTier: null, checkedAt: "2026-08-20T19:00:00.000Z" }, notices: [] });
      if (endpoint === "cmsListMedia") {
        const availableRecords = [GALLERY_MIXED_IMAGE, GALLERY_MIXED_DOCUMENT, ...audioRecords];
        const requestedIds = Array.isArray(request.assetIds)
          ? new Set(request.assetIds.filter((id): id is string => typeof id === "string"))
          : null;
        const requestedKinds = Array.isArray(request.kinds)
          ? new Set(request.kinds.filter((kind): kind is MediaAssetSummary["kind"] =>
            kind === "image" || kind === "audio" || kind === "document"))
          : null;
        const records = requestedIds
          ? availableRecords.filter((asset) => requestedIds.has(asset.id))
          : requestedKinds
            ? availableRecords.filter((asset) => requestedKinds.has(asset.kind))
            : availableRecords;
        return galleryJsonResponse({
          success: true, records, paging: "cursor", nextCursor: null, total: records.length,
          allCount: records.length, categoryCounts: null, kindCounts: null, page: 1,
          pageCount: null,
          ...(request.counts === true ? { counts: {
            images: 1, audio: audioRecords.length, sources: {},
          } } : {}),
        });
      }
      if (endpoint === "cmsListSourceMedia") return galleryJsonResponse({
        success: true, records: [{ ...GALLERY_MIXED_VIDEO, sourceId: request.sourceId ?? "video-library" }],
        nextCursor: null, hasMore: false, total: 1,
      });
      if (endpoint === "cmsUploadMedia" && init?.body instanceof FormData) {
        const file = init.body.get("file") as File;
        const uploaded: MediaAssetSummary = { ...audioRecords[0], id: `uploaded-${audioRecords.length}`,
          name: String(init.body.get("name") ?? file.name), originalName: file.name, sizeBytes: file.size,
          category: String(init.body.get("category")), license: null,
          etag: `"media.uploaded-${audioRecords.length}.1"`,
          url: "https://media.example.test/uploaded.wav" };
        audioRecords.push(uploaded);
        return galleryJsonResponse({ success: true, asset: uploaded }, 201);
      }
      if (endpoint === "cmsGetMediaReview") {
        const key = feedbackKey(request.ref);
        const current = mediaReviews.get(key) ?? {
          moreLikeThis: false,
          notes: "Use this warm station identification.",
          version: 1,
          updatedAt: "2026-09-12T12:00:00.000Z",
        };
        mediaReviews.set(key, current);
        return galleryJsonResponse({ success: true, review: current });
      }
      if (endpoint === "cmsSaveMediaReview") {
        const key = feedbackKey(request.ref);
        const prior = mediaReviews.get(key);
        const current = {
          moreLikeThis: request.moreLikeThis === true,
          notes: String(request.notes ?? ""),
          version: (prior?.version ?? 0) + 1,
          updatedAt: "2026-10-05T14:00:00.000Z",
        };
        mediaReviews.set(key, current);
        return galleryJsonResponse({ success: true, review: current });
      }
      if (endpoint === "cmsListMediaComments") {
        if (typeof request.export === "string") {
          const comments = commentThreads(commentsFor(request.ref))
            .filter(thread => threadMatches(thread, request.export as CommentFilter))
            .flatMap(thread => [thread.comment, ...thread.replies]);
          return galleryJsonResponse({ success: true, exported: true, comments });
        }
        return galleryJsonResponse({ success: true, comments: commentsFor(request.ref), nextCursor: null });
      }
      if (endpoint === "cmsMutateMediaComment") {
        const comments = commentsFor(request.ref);
        if (request.action === "create") {
          const requestKey = `${feedbackKey(request.ref)}:${String(request.requestId)}`;
          const priorId = commentIdsByRequest.get(requestKey);
          if (priorId) {
            return galleryJsonResponse({
              success: true,
              comment: comments.find(comment => comment.id === priorId) ?? null,
            });
          }
          createdCommentCount += 1;
          const id = createdCommentCount.toString(16).padStart(64, "0");
          commentIdsByRequest.set(requestKey, id);
          const comment = { id, authorUid: "gallery-audio", authorName: "Alex Rivera",
            text: String(request.text ?? ""), version: 1, createdAt: "2026-10-05T14:15:00.000Z",
            updatedAt: "2026-10-05T14:15:00.000Z", canEdit: true };
          comments.push(comment);
          return galleryJsonResponse({ success: true, comment });
        }
        const index = comments.findIndex(comment => comment.id === request.commentId);
        if (request.action === "edit" && index >= 0) {
          const comment = { ...comments[index], text: String(request.text ?? ""),
            version: comments[index].version + 1, updatedAt: "2026-10-05T14:20:00.000Z" };
          comments[index] = comment;
          return galleryJsonResponse({ success: true, comment });
        }
        if (request.action === "delete" && index >= 0) comments.splice(index, 1);
        return galleryJsonResponse({ success: true, comment: null });
      }
      if (endpoint === "cmsVoiceoverReview" && request.action === "get-media") {
        return galleryJsonResponse({ success: true, review: voiceoverReview });
      }
      if (endpoint === "cmsVoiceoverReview" && request.action === "save-media") {
        voiceoverReview = { ...voiceoverReview,
          moreLikeThis: request.moreLikeThis === true, notes: String(request.notes ?? ""),
          version: voiceoverReview.version + 1, updatedAt: "2026-10-04T16:00:00.000Z" };
        return galleryJsonResponse({ success: true, review: voiceoverReview });
      }
      if (endpoint === "cmsGetVoiceoverAudio") {
        return new Response(new Uint8Array(privateWav).buffer, { status: 200, headers: {
          "Content-Type": "audio/wav", "Content-Length": String(privateWav.byteLength),
        } });
      }
      if (endpoint === "cmsListMediaSources") return galleryJsonResponse({
        success: true,
        sources: [{ id: "archive", label: "Archive", description: "Local gallery fixture", mediaKind: "video",
          canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false, canDelete: false }],
      });
      if (url.hostname === "127.0.0.1" && url.port === "5001") {
        return galleryJsonResponse({ error: `No gallery fixture for ${endpoint ?? "this request"}.` }, 501);
      }
      return originalFetch(input, init);
    };
    return {
      getIdToken: async () => {
        if (!installed) {
          window.fetch = fixtureFetch;
          installed = true;
        }
        return "local-gallery-fixture";
      },
      restore: () => {
        if (window.fetch === fixtureFetch) window.fetch = originalFetch;
        installed = false;
      },
    };
  });
  useEffect(() => transport.restore, [transport]);
  return transport.getIdToken;
}
