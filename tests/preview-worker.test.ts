import { describe, expect, it, vi } from "vitest";
import { env, SELF } from "cloudflare:test";

import {
  PREVIEW_SECURITY_HEADERS,
  servePreviewRequest,
  servePreviewWorkerRequest,
  type PreviewArtifactBody,
  type PreviewArtifactMetadata,
  type PreviewBucketReader,
} from "../workers/src/preview-worker";

const QUEUE_ID = "AbCdEfGhIjKlMnOpQrSt";
const NOW = Date.parse("2026-08-28T16:00:00.000Z");
const EXPIRES_AT = String(NOW + 15 * 60 * 1000);

function metadata(
  overrides: Partial<PreviewArtifactMetadata> = {},
): PreviewArtifactMetadata {
  return {
    httpEtag: '"preview-etag"',
    uploaded: new Date(NOW),
    customMetadata: {
      schema: "njpbs-preview-v1",
      queueid: QUEUE_ID,
      expiresatms: EXPIRES_AT,
    },
    ...overrides,
  };
}

function body(
  value = "<!doctype html><title>Draft preview</title>",
  overrides: Partial<PreviewArtifactBody> = {},
): PreviewArtifactBody {
  return {
    ...metadata(),
    body: new Response(value).body!,
    ...overrides,
  };
}

function bucket({
  get = vi.fn(async () => body()),
  head = vi.fn(async () => metadata()),
}: {
  get?: PreviewBucketReader["get"];
  head?: PreviewBucketReader["head"];
} = {}): PreviewBucketReader {
  return { get, head };
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://preview.njpbs.org${path}`, { method });
}

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(PREVIEW_SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
  expect(response.headers.get("content-security-policy")).toBeNull();
}

describe("private CMS preview Worker", () => {
  it.each(["p", "s"])("expires %s output at 24 hours even with a current retained pointer", async kind => {
    const object = body("expired output", { uploaded: new Date(NOW - 24 * 60 * 60 * 1000),
      customMetadata: { schema: "njpbs-preview-v1", queueid: QUEUE_ID,
        expiresatms: String(NOW + 6 * 86400000), contentkey: "a".repeat(64) } });
    const current = metadata({ customMetadata: { schema: "njpbs-preview-current-v1", queueid: QUEUE_ID } });
    for (const method of ["GET", "HEAD"]) {
      const result = await servePreviewRequest(request(`/${kind}/${QUEUE_ID}/contact/`, method), {
        bucket: bucket({ get: async () => object, head: async key => key.startsWith("current/") ? current : object }),
        now: () => NOW,
      });
      expect(result.status).toBe(410);
      if (method === "HEAD") expect(result.body).toBeNull();
    }
  });
  it.each([undefined, new Date("invalid")])("refuses output without a valid upload timestamp: %s", async uploaded => {
    const result = await servePreviewRequest(request(`/p/${QUEUE_ID}/contact/`), {
      bucket: bucket({ get: async () => body("invalid", { uploaded }) }), now: () => NOW,
    });
    expect(result.status).toBe(404);
  });

  it("serves through the configured R2 binding in the Workers runtime", async () => {
    const key = `v1/${QUEUE_ID}/watch/index.html`;
    await env.PREVIEWS.put(key, "<!doctype html><title>Bound preview</title>", {
      customMetadata: {
        schema: "njpbs-preview-v1",
        queueid: QUEUE_ID,
        expiresatms: String(Date.now() + 60_000),
      },
    });

    const response = await SELF.fetch(
      `https://preview.njpbs.org/p/${QUEUE_ID}/watch/`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Bound preview");
    expectSecurityHeaders(response);
  });

  it("streams one valid HTML object from its immutable queue prefix", async () => {
    const get = vi.fn(async () => body());
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`),
      { bucket: bucket({ get }), now: () => NOW },
    );

    expect(get).toHaveBeenCalledWith(`v1/${QUEUE_ID}/watch/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Draft preview");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("etag")).toBe('"preview-etag"');
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expectSecurityHeaders(response);
  });

  it("serves HEAD without loading the object body", async () => {
    const get = vi.fn(async () => body());
    const head = vi.fn(async () => metadata());
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/_astro/page.abc123.css`, "HEAD"),
      { bucket: bucket({ get, head }), now: () => NOW },
    );

    expect(head).toHaveBeenCalledWith(`v1/${QUEUE_ID}/_astro/page.abc123.css`);
    expect(get).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expectSecurityHeaders(response);
  });

  it("returns 410 after the exact stored expiry", async () => {
    const get = vi.fn(async () =>
      body("expired", {
        customMetadata: {
          schema: "njpbs-preview-v1",
          queueid: QUEUE_ID,
          expiresatms: String(NOW),
        },
      }),
    );
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`),
      { bucket: bucket({ get }), now: () => NOW },
    );

    expect(response.status).toBe(410);
    expect(await response.text()).toBe("Preview expired");
    expectSecurityHeaders(response);
  });

  it("returns 410 for an expired HEAD without loading a body", async () => {
    const get = vi.fn(async () => body());
    const head = vi.fn(async () => metadata({
      customMetadata: {
        schema: "njpbs-preview-v1",
        queueid: QUEUE_ID,
        expiresatms: String(NOW),
      },
    }));
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`, "HEAD"),
      { bucket: bucket({ get, head }), now: () => NOW },
    );

    expect(response.status).toBe(410);
    expect(response.body).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it.each([
    {},
    { schema: "wrong", queueid: QUEUE_ID, expiresatms: EXPIRES_AT },
    { schema: "njpbs-preview-v1", queueid: "OtherQueueId12345678", expiresatms: EXPIRES_AT },
    { schema: "njpbs-preview-v1", queueid: QUEUE_ID, expiresatms: "tomorrow" },
  ])("fails closed for missing or invalid object metadata", async (customMetadata) => {
    const get = vi.fn(async () => body("private", { customMetadata }));
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`),
      { bucket: bucket({ get }), now: () => NOW },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Preview not found");
  });

  it.each([
    "/",
    "/_astro/page.abc123.css",
    "/brand/logo.svg",
    "/favicon.png",
    "/p/",
    "/p/short/watch/",
    `/p/${QUEUE_ID}`,
    `/p/${QUEUE_ID}/watch`,
    `/p/${QUEUE_ID}/../secret.html`,
    `/p/${QUEUE_ID}/watch/..%2fsecret.html`,
    `/p/${QUEUE_ID}/watch/file.exe`,
  ])("does not list or resolve an invalid preview path: %s", async (path) => {
    const get = vi.fn(async () => body());
    const response = await servePreviewRequest(request(path), {
      bucket: bucket({ get }),
      now: () => NOW,
    });

    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps URL-normalized dot paths inside the same queue prefix", async () => {
    const get = vi.fn(async () => body());
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/%2e%2e/secret.html`),
      { bucket: bucket({ get }), now: () => NOW },
    );

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(`v1/${QUEUE_ID}/secret.html`);
  });

  it("allows only GET and HEAD", async () => {
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`, "POST"),
      { bucket: bucket(), now: () => NOW },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expectSecurityHeaders(response);
  });

  it("returns the same private 404 for an absent object", async () => {
    const get = vi.fn(async () => null);
    const response = await servePreviewRequest(
      request(`/p/${QUEUE_ID}/watch/`),
      { bucket: bucket({ get }), now: () => NOW },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Preview not found");
    expectSecurityHeaders(response);
  });

  it("fails closed when R2 is unavailable", async () => {
    const logError = vi.fn();
    const get = vi.fn(async () => {
      throw new Error("R2 unavailable");
    });
    const response = await servePreviewWorkerRequest(
      request(`/p/${QUEUE_ID}/watch/`),
      { bucket: bucket({ get }), now: () => NOW },
      logError,
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Preview unavailable");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining(
      '"message":"CMS preview object lookup failed"',
    ));
    expectSecurityHeaders(response);
  });
});
