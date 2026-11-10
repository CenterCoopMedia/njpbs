import { previewObjectRequest } from "./preview-artifact-request";
import { SHARE_UPLOAD_ORIGIN } from "../../packages/content-core/src/share-upload-origin";

const PREVIEW_SCHEMA = "njpbs-preview-v1";
export const PREVIEW_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export const PREVIEW_SECURITY_HEADERS = Object.freeze({
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy-report-only":
    `default-src 'self'; script-src 'self' https://jaws-prod.cdn.pbs.org https://public.flourish.studio https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://public.flourish.studio https://image.pbs.org https://media.njpbs.org https://njpbs.org; media-src 'self' https://media.njpbs.org; font-src 'self' https://media.njpbs.org; frame-src https://flo.uri.sh https://interactives.apelections.org https://player.pbs.org https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.instagram.com https://www.facebook.com https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com https://report.njpbs.org https://intake.njpbs.org ${SHARE_UPLOAD_ORIGIN}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
});

export type PreviewArtifactMetadata = Pick<
  R2Object,
  "httpEtag" | "customMetadata" | "uploaded"
>;

export type PreviewArtifactBody = PreviewArtifactMetadata &
  Pick<R2ObjectBody, "body">;

export interface PreviewBucketReader {
  get(key: string): Promise<PreviewArtifactBody | null>;
  head(key: string): Promise<PreviewArtifactMetadata | null>;
}

interface PreviewWorkerDependencies {
  bucket: PreviewBucketReader;
  now(): number;
}

function privateHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(PREVIEW_SECURITY_HEADERS);
  const additions = new Headers(extra);
  additions.forEach((value, name) => headers.set(name, value));
  return headers;
}

function privateText(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: privateHeaders({ "content-type": "text/plain; charset=utf-8" }),
  });
}

function withoutBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function validExpiry(value: string | undefined): number | null {
  if (!value || !/^\d{13}$/.test(value)) return null;
  const millis = Number(value);
  return Number.isSafeInteger(millis) ? millis : null;
}

function artifactState(
  object: PreviewArtifactMetadata,
  queueId: string,
  now: number,
): "active" | "expired" | "invalid" {
  const metadata = object.customMetadata;
  if (
    metadata?.schema !== PREVIEW_SCHEMA ||
    metadata.queueid !== queueId
  ) {
    return "invalid";
  }
  const expiresAt = validExpiry(metadata.expiresatms);
  if (expiresAt === null) return "invalid";
  const uploadedAt = object.uploaded?.getTime();
  if (!Number.isSafeInteger(uploadedAt) || uploadedAt > now) return "invalid";
  return Math.min(expiresAt, uploadedAt + PREVIEW_ARTIFACT_TTL_MS) <= now ? "expired" : "active";
}

function artifactResponse(
  object: PreviewArtifactMetadata,
  contentType: string,
  body: ReadableStream | null,
): Response {
  const headers = privateHeaders({
    "content-type": contentType,
    etag: object.httpEtag,
  });
  return new Response(body, { status: 200, headers });
}

function rejectedArtifactResponse(
  object: PreviewArtifactMetadata,
  queueId: string,
  now: number,
): Response | null {
  const state = artifactState(object, queueId, now);
  if (state === "invalid") return privateText("Preview not found", 404);
  return state === "expired" ? privateText("Preview expired", 410) : null;
}

export async function servePreviewRequest(
  request: Request,
  dependencies: PreviewWorkerDependencies,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: privateHeaders({ allow: "GET, HEAD" }),
    });
  }

  const target = previewObjectRequest(new URL(request.url).pathname);
  if (!target) return privateText("Preview not found", 404);

  if (request.method === "HEAD") {
    const object = await dependencies.bucket.head(target.key);
    if (!object) return withoutBody(privateText("Preview not found", 404));
    const rejection = rejectedArtifactResponse(
      object,
      target.queueId,
      dependencies.now(),
    );
    return rejection
      ? withoutBody(rejection)
      : artifactResponse(object, target.contentType, null);
  }

  const object = await dependencies.bucket.get(target.key);
  if (!object) return privateText("Preview not found", 404);
  const rejection = rejectedArtifactResponse(
    object,
    target.queueId,
    dependencies.now(),
  );
  if (rejection) {
    await object.body.cancel();
    return rejection;
  }
  return artifactResponse(object, target.contentType, object.body);
}

export async function servePreviewWorkerRequest(
  request: Request,
  dependencies: PreviewWorkerDependencies,
  logError: (message: string) => void = console.error,
): Promise<Response> {
  try {
    return await servePreviewRequest(request, dependencies);
  } catch (error) {
    logError(JSON.stringify({
      message: "CMS preview object lookup failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    return privateText("Preview unavailable", 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return servePreviewWorkerRequest(request, {
      bucket: env.PREVIEWS,
      now: Date.now,
    });
  },
} satisfies ExportedHandler<Env>;
