import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../functions/_middleware";

function context(path: string, token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const next = vi.fn(async () => new Response("public asset"));
  const fetchAsset = vi.fn(async () => new Response("guide asset"));
  const validateAccess = vi.fn(async () => 204);
  return {
    value: {
      request: new Request(`https://admin.njpbs.org${path}`, { headers }),
      env: {
        ASSETS: { fetch: fetchAsset },
        STAFF_ACCESS: { validateAccess },
      },
      next,
    },
    next,
    fetchAsset,
    validateAccess,
  };
}

describe("Admin guide routing", () => {
  it.each([
    "/guide-content/manifest.json",
    "/guide-content/resources/nj-politics.json",
    "/guide-content/resources/public-bios.json",
    "/guide-content/resources%2fpublic-bios.json",
    "/%67uide-content/resources/public-bios.json",
    "/guide-content//resources/nj-politics.json",
    "/guide-content/resources%2fnj-politics.json",
    "/%67uide-content/resources/nj-politics.json",
    "/guide-content/videos/shared-video-library.mp4",
    "/guide-content//manifest.json",
    "/guide-content/%6danifest.json",
    "/guide-content/pages%2foverview.md",
    "/guide-content%2fimages%2fhome.webp",
    "/%67uide-content/manifest.json",
    "/%67uide-content/%zzmanifest.json",
  ])("sends %s through staff admission", async (path) => {
    const fixture = context(path);
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(401);
    expect(fixture.next).not.toHaveBeenCalled();
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("serves a canonical guide file only after staff admission", async () => {
    const fixture = context("/guide-content/manifest.json", "staff.token");
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("guide asset");
    expect(fixture.validateAccess).toHaveBeenCalledOnce();
    expect(fixture.next).not.toHaveBeenCalled();
  });

  it("serves the resource through the same staff admission boundary", async () => {
    const fixture = context("/guide-content/resources/nj-politics.json", "staff.token");
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(fixture.validateAccess).toHaveBeenCalledOnce();
    expect(fixture.fetchAsset).toHaveBeenCalledOnce();
    expect(fixture.next).not.toHaveBeenCalled();
  });

  it("rejects an aliased path even for admitted staff", async () => {
    const fixture = context("/guide-content//manifest.json", "staff.token");
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(404);
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("keeps ordinary Admin assets on the existing path", async () => {
    const fixture = context("/assets/main.js");
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(fixture.next).toHaveBeenCalledOnce();
    expect(fixture.validateAccess).not.toHaveBeenCalled();
  });
});

describe("Admin frame protection", () => {
  function expectProtected(response: Response) {
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  }

  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])(
    "protects documents, redirects, errors and immutable assets on %s", async host => {
      for (const method of ["GET", "HEAD"]) {
        for (const status of [200, 206, 302, 304, 401, 403, 404, 500, 503]) {
          const fixture = context("/dashboard");
          fixture.value.request = new Request(`https://${host}/dashboard`, { method });
          fixture.next.mockResolvedValue(new Response(
            method === "HEAD" || status === 304 ? null : "content", {
              status,
              headers: { "cache-control": "private, no-store", etag: '"document"' },
            },
          ));
          const response = await onRequest(fixture.value);
          expectProtected(response);
          expect(response.status).toBe(status);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(response.headers.get("etag")).toBe('"document"');
        }
      }
      const fixture = context("/assets/main-Abcd1234.js");
      fixture.value.request = new Request(`https://${host}/assets/main-Abcd1234.js`);
      fixture.next.mockResolvedValue(new Response("script", {
        headers: { "cache-control": "public, max-age=31536000, immutable" },
      }));
      const response = await onRequest(fixture.value);
      expectProtected(response);
      expect(response.headers.get("cache-control")).toContain("immutable");
    },
  );

  it.each([undefined, "staff.token"])("protects guide admission responses with token %s", async token => {
    const fixture = context("/guide-content/manifest.json", token);
    const response = await onRequest(fixture.value);
    expectProtected(response);
    expect(response.status).toBe(token ? 200 : 401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("preserves existing CSP policies while adding an independent frame restriction", async () => {
    const fixture = context("/dashboard");
    fixture.next.mockResolvedValue(new Response("page", { headers: {
      "content-security-policy": "default-src 'self'; FRAME-ANCESTORS https://example.com; script-src 'self'",
      "content-security-policy-report-only": "default-src 'none'",
      "x-frame-options": "SAMEORIGIN",
    } }));
    const response = await onRequest(fixture.value);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; FRAME-ANCESTORS https://example.com; script-src 'self', frame-ancestors 'none'",
    );
    expect(response.headers.get("content-security-policy-report-only")).toBe("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toBe("page");
  });
});

describe("Admin asset cache boundary", () => {
  const immutable = "public, max-age=31536000, immutable";

  it.each(["GET", "HEAD"])("keeps missing assets out of caches for %s", async method => {
    const fixture = context("/assets/missing-Abcd1234.js");
    fixture.value.request = new Request(fixture.value.request, { method });
    fixture.next.mockResolvedValue(new Response(method === "HEAD" ? null : "Page not found", {
      status: 404,
      headers: { "cache-control": immutable, "content-type": "text/html" },
    }));
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Page not found");
  });

  it.each([200, 302, 500])("does not cache an HTML fallback or error with status %i", async status => {
    const fixture = context("/assets/missing-Abcd1234.js");
    fixture.next.mockResolvedValue(new Response("fallback", {
      status, headers: { "cache-control": immutable, "content-type": "text/html; charset=utf-8" },
    }));
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([302, 404, 500])("does not cache a non-HTML failure with status %i", async status => {
    const fixture = context("/assets/main-Abcd1234.js");
    fixture.next.mockResolvedValue(new Response("failed", {
      status, headers: { "cache-control": immutable, "content-type": "text/plain" },
    }));
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["Text/HTML; charset=utf-8", "application/xhtml+xml"])("does not cache %s", async contentType => {
    const fixture = context("/assets/main-Abcd1234.js");
    fixture.next.mockResolvedValue(new Response("page", {
      headers: { "cache-control": immutable, "content-type": contentType },
    }));
    expect((await onRequest(fixture.value)).headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([200, 206, 304])("preserves real asset caching and response data with status %i", async status => {
    const fixture = context("/assets/main-Abcd1234.js");
    const asset = new Response(status === 304 ? null : "script", {
      status,
      headers: { "cache-control": immutable, "content-type": "text/javascript", etag: '"asset"' },
    });
    fixture.next.mockResolvedValue(asset);
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(asset.status);
    expect(await response.text()).toBe(status === 304 ? "" : "script");
    expect(response.headers.get("cache-control")).toBe(immutable);
    expect(response.headers.get("etag")).toBe('"asset"');
  });
});

