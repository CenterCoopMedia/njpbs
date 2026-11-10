import { describe, expect, it, vi } from "vitest";
import { GUIDE_VIDEOS } from "../src/lib/guide-video-assets";
import { onRequest } from "../functions/guide-content/[[path]]";

const GUIDE_RELEASE = "0123456789abcdef";

function videoBucket(objects: Record<string, string>) {
  const byName = new Map(Object.entries(objects).map(([key, body]) => [key.split("/").pop() ?? key, body]));
  const head = vi.fn(async (key: string) => {
    if (key === "videos/current") return { size: GUIDE_RELEASE.length, httpEtag: '"current"' };
    const body = byName.get(key.split("/").pop() ?? key);
    if (body === undefined) return null;
    return { size: body.length, httpEtag: '"video-etag"' };
  });
  const get = vi.fn(async (
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } },
  ) => {
    if (key === "videos/current") {
      return { size: GUIDE_RELEASE.length, httpEtag: '"current"', body: GUIDE_RELEASE };
    }
    const body = byName.get(key.split("/").pop() ?? key);
    if (body === undefined) return null;
    const size = body.length;
    const range = options?.range;
    if (!range) return { size, httpEtag: '"video-etag"', body };
    const offset = range.suffix !== undefined && range.offset === undefined
      ? size - Math.min(range.suffix, size)
      : range.offset ?? 0;
    if (offset < 0 || offset >= size) return null;
    const available = size - offset;
    const length = range.suffix !== undefined && range.offset === undefined
      ? Math.min(range.suffix, size)
      : Math.min(range.length ?? available, available);
    if (length <= 0) return null;
    return {
      size,
      httpEtag: '"video-etag"',
      range: { offset, length },
      body: body.slice(offset, offset + length),
    };
  });
  return { head, get };
}

function context({
  host = "admin.njpbs.org",
  path = "/guide-content/manifest.json",
  method = "GET",
  token = "staff.token",
  access = 204,
  range,
  ifRange,
  videos,
  asset = new Response("guide", {
    status: 200,
    headers: { "content-type": "text/plain", "set-cookie": "unsafe=1" },
  }),
}: {
  host?: string;
  path?: string;
  method?: string;
  token?: string | null;
  access?: number | Error;
  range?: string;
  ifRange?: string;
  videos?: ReturnType<typeof videoBucket>;
  asset?: Response;
} = {}) {
  const validateAccess = vi.fn(async (_token: string, _ipAddress: string) => {
    if (access instanceof Error) throw access;
    return access;
  });
  const fetchAsset = vi.fn(async (_request: Request) => asset);
  const headers = new Headers({
    cookie: "private=1",
    "cf-connecting-ip": "203.0.113.7",
  });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (range) headers.set("range", range);
  if (ifRange) headers.set("if-range", ifRange);
  return {
    value: {
      request: new Request(`https://${host}${path}`, { method, headers }),
      env: {
        STAFF_ACCESS: { validateAccess },
        ASSETS: { fetch: fetchAsset },
        GUIDE_VIDEOS: videos,
      },
    },
    validateAccess,
    fetchAsset,
  };
}

describe("Admin guide content function", () => {
  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])("protects the selectable bio catalog on %s", async (host) => {
    for (const method of ["GET", "HEAD"]) {
      for (const access of [401, 403, 429, 503]) {
        const fixture = context({ host, method, access, path: "/guide-content/resources/public-bios.json" });
        const response = await onRequest(fixture.value);
        expect(response.status).toBe(access);
        expect(fixture.fetchAsset).not.toHaveBeenCalled();
      }
      const absent = context({ host, method, token: null, path: "/guide-content/resources/public-bios.json" });
      expect((await onRequest(absent.value)).status).toBe(401);
      expect(absent.fetchAsset).not.toHaveBeenCalled();
    }
    const allowed = context({ host, path: "/guide-content/resources/public-bios.json" });
    const response = await onRequest(allowed.value);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(allowed.validateAccess).toHaveBeenCalledOnce();
  });


  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])(
    "protects the politics research data on %s for GET and HEAD",
    async (host) => {
      for (const method of ["GET", "HEAD"]) {
        for (const access of [401, 403, 429, 503]) {
          const fixture = context({ host, method, access, path: "/guide-content/resources/nj-politics.json" });
          const response = await onRequest(fixture.value);
          expect(response.status).toBe(access);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(fixture.fetchAsset).not.toHaveBeenCalled();
        }
        const signedOut = context({ host, method, token: null, path: "/guide-content/resources/nj-politics.json" });
        expect((await onRequest(signedOut.value)).status).toBe(401);
        expect(signedOut.fetchAsset).not.toHaveBeenCalled();
      }
    },
  );

  it("serves the exact politics data file only after current staff admission", async () => {
    const fixture = context({
      path: "/guide-content/resources/nj-politics.json",
      asset: new Response('{"people":[]}', { headers: { "content-type": "application/json" } }),
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ people: [] });
    expect(fixture.validateAccess).toHaveBeenCalledExactlyOnceWith("staff.token", "203.0.113.7");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])(
    "protects the election directory data on %s for GET and HEAD",
    async (host) => {
      for (const method of ["GET", "HEAD"]) {
        for (const access of [401, 403, 429, 503]) {
          const fixture = context({ host, method, access, path: "/guide-content/resources/nj-election-2026.json" });
          const response = await onRequest(fixture.value);
          expect(response.status).toBe(access);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(fixture.fetchAsset).not.toHaveBeenCalled();
        }
        const signedOut = context({ host, method, token: null, path: "/guide-content/resources/nj-election-2026.json" });
        expect((await onRequest(signedOut.value)).status).toBe(401);
        expect(signedOut.fetchAsset).not.toHaveBeenCalled();
      }
    },
  );

  it("serves the exact election data file only after current staff admission", async () => {
    const fixture = context({
      path: "/guide-content/resources/nj-election-2026.json",
      asset: new Response('{"people":[]}', { headers: { "content-type": "application/json" } }),
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ people: [] });
    expect(fixture.validateAccess).toHaveBeenCalledExactlyOnceWith("staff.token", "203.0.113.7");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([
    "/guide-content/resources/unknown.json",
    "/guide-content/resources/public-bios.json/",
    "/guide-content/resources%2fpublic-bios.json",
    "/guide-content/resources/nj-election-2026.json/",
    "/guide-content/resources%2fnj-election-2026.json",
    "/guide-content/resources/nj-election-2026.xlsx",
    "/guide-content/resources/nj-politics.json/",
    "/guide-content/resources%2fnj-politics.json",
    "/guide-content/resources/nj-politics.xlsx",
  ])("refuses an unlisted research asset %s", async (path) => {
    const fixture = context({ path });
    expect((await onRequest(fixture.value)).status).toBe(404);
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it.each(["admin.njpbs.org", "njpbs-admin.pages.dev"])("denies every tutorial asset and transcript on %s before storage", async (host) => {
    for (const video of GUIDE_VIDEOS) {
      for (const path of [
        ...["mp4", "jpg", "vtt", "txt"].map((extension) => `/guide-content/videos/${video.id}.${extension}`),
        `/guide-content/pages/${video.page}.md`,
        "/guide-content/pages/video-tutorials.md",
        "/guide-content/search.json",
      ]) {
        for (const method of ["GET", "HEAD"]) {
          const videos = videoBucket({});
          const fixture = context({ host, path, method, token: null, videos });
          const response = await onRequest(fixture.value);
          expect(response.status, `${method} ${host}${path}`).toBe(401);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(videos.get).not.toHaveBeenCalled();
          expect(videos.head).not.toHaveBeenCalled();
          expect(fixture.fetchAsset).not.toHaveBeenCalled();
        }
      }
    }
  });

  it.each(['"video-etag"', 'W/"video-etag"', "Wed, 21 Oct 2015 07:28:00 GMT"])("uses only a matching strong If-Range validator: %s", async (ifRange) => {
    const videos = videoBucket({ "videos/analytics.mp4": "abcdef" });
    const response = await onRequest(context({ path: "/guide-content/videos/analytics.mp4", range: "bytes=1-2", ifRange, videos }).value);
    const matches = ifRange === '"video-etag"';
    expect(response.status).toBe(matches ? 206 : 200);
    expect(await response.text()).toBe(matches ? "bc" : "abcdef");
  });

  it("serves a private plain-text transcript only after staff admission", async () => {
    const videos = videoBucket({ "videos/analytics.txt": "Descriptive transcript" });
    const fixture = context({ path: "/guide-content/videos/analytics.txt", videos });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("Descriptive transcript");
    expect(fixture.validateAccess).toHaveBeenCalledOnce();
  });

  it("refuses a request with no well-formed bearer token", async () => {
    for (const token of [null, "contains space"]) {
      const fixture = context({ token });
      const response = await onRequest(fixture.value);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(fixture.validateAccess).not.toHaveBeenCalled();
      expect(fixture.fetchAsset).not.toHaveBeenCalled();
    }
  });

  it("revalidates staff access and passes no credential to the asset binding", async () => {
    const fixture = context({ asset: new Response("guide", { headers: {
      "set-cookie": "unsafe=1",
      "referrer-policy": "unsafe-url",
      "x-content-type-options": "unsafe",
      "cdn-cache-control": "public, max-age=86400",
      "cloudflare-cdn-cache-control": "public, max-age=86400",
    } }) });
    const response = await onRequest(fixture.value);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("guide");
    expect(fixture.validateAccess).toHaveBeenCalledWith("staff.token", "203.0.113.7");
    const served = fixture.fetchAsset.mock.calls[0]?.[0] as Request;
    expect(served.headers.get("authorization")).toBeNull();
    expect(served.headers.get("cookie")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([401, 403, 429])("preserves a staff gateway refusal with status %s", async (access) => {
    const fixture = context({ access });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(access);
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("fails closed when the staff gateway is unavailable", async () => {
    const fixture = context({ access: new Error("binding unavailable") });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Guide access unavailable");
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it.each([
    "/guide-content/pages/../../secret",
    "/guide-content/pages/unknown.txt",
    "/guide-content/images/file.png",
  ])("does not serve an unrecognized artifact path %s", async (path) => {
    const fixture = context({ path });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(404);
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("allows HEAD and returns no body", async () => {
    const fixture = context({ method: "HEAD" });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuses mutation methods before access validation", async () => {
    const fixture = context({ method: "POST" });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(fixture.validateAccess).not.toHaveBeenCalled();
  });

  it("denies a signed-out video request before opening storage", async () => {
    const videos = videoBucket({ "videos/shared-video-library.mp4": "abcdefghij" });
    const fixture = context({
      path: "/guide-content/videos/shared-video-library.mp4",
      token: null,
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(videos.head).not.toHaveBeenCalled();
    expect(videos.get).not.toHaveBeenCalled();
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("streams an admitted video range with a private media type", async () => {
    const videos = videoBucket({ "videos/shared-video-library.mp4": "abcdefghijklmnopqrstuvwxyz" });
    const fixture = context({
      path: "/guide-content/videos/shared-video-library.mp4",
      range: "bytes=0-3",
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("abcd");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/26");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBe('"video-etag"');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(videos.get).toHaveBeenCalledWith(
      "videos/r/0123456789abcdef/shared-video-library.mp4",
      { range: { offset: 0, length: 4 } },
    );
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });

  it("returns the tail of a video for a suffix range", async () => {
    const videos = videoBucket({ "videos/shared-video-library.mp4": "abcdefghijklmnopqrstuvwxyz" });
    const fixture = context({
      path: "/guide-content/videos/shared-video-library.mp4",
      range: "bytes=-4",
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("wxyz");
    expect(response.headers.get("content-range")).toBe("bytes 22-25/26");
  });

  it("ignores Range on HEAD and describes the whole object", async () => {
    const videos = videoBucket({ "videos/pause-resume-upload.jpg": "poster-bytes" });
    const fixture = context({
      path: "/guide-content/videos/pause-resume-upload.jpg",
      method: "HEAD",
      range: "bytes=0-3",
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("12");
    expect(videos.get).toHaveBeenCalledTimes(1);
    expect(videos.get).toHaveBeenCalledWith("videos/current");
    expect(videos.head).toHaveBeenCalledWith("videos/r/0123456789abcdef/pause-resume-upload.jpg");
  });

  it.each(["items=0-3", "unknown=40-50", "seconds=0-1"])("ignores an unsupported Range unit: %s", async (range) => {
    const videos = videoBucket({ "analytics.mp4": "abcdef" });
    const response = await onRequest(context({
      path: "/guide-content/videos/analytics.mp4", range, videos,
    }).value);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("6");
    expect(await response.text()).toBe("abcdef");
    expect(videos.get).toHaveBeenLastCalledWith(
      `videos/r/${GUIDE_RELEASE}/analytics.mp4`, undefined,
    );
  });

  it("refuses a video range outside the object", async () => {
    const videos = videoBucket({ "videos/analytics.vtt": "WEBVTT" });
    const fixture = context({
      path: "/guide-content/videos/analytics.vtt",
      range: "bytes=40-50",
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */6");
    expect(response.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(videos.get).toHaveBeenCalledTimes(2);
    expect(videos.head).toHaveBeenCalledOnce();
  });

  it("reports an R2 unsatisfiable range as 416", async () => {
    const videos = videoBucket({ "videos/analytics.vtt": "WEBVTT" });
    videos.get.mockImplementation(async (key: string, options?: { range?: unknown }) => {
      if (options?.range) throw new Error("get: The requested range is not satisfiable (10039)");
      if (key === "videos/current") {
        return { size: GUIDE_RELEASE.length, httpEtag: '"current"', body: GUIDE_RELEASE };
      }
      const name = key.split("/").pop() ?? key;
      const stored = key.endsWith(".vtt") ? "WEBVTT" : undefined;
      if (!stored && name !== "analytics.vtt") return null;
      return { size: "WEBVTT".length, httpEtag: '"video-etag"', body: "WEBVTT" };
    });
    const fixture = context({
      path: "/guide-content/videos/analytics.vtt",
      range: "bytes=40-50",
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */6");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("restarts on the replaced video when If-Range no longer matches", async () => {
    const head = vi.fn()
      .mockResolvedValueOnce({ size: 26, httpEtag: '"video-etag"' })
      .mockResolvedValueOnce({ size: 5, httpEtag: '"replaced"' });
    const get = vi.fn(async (key: string, options?: { range?: unknown }) => {
      if (key === "videos/current") {
        return { size: GUIDE_RELEASE.length, httpEtag: '"current"', body: GUIDE_RELEASE };
      }
      if (options?.range) throw new Error("get: The requested range is not satisfiable (10039)");
      return { size: 5, httpEtag: '"replaced"', body: "NEWER" };
    });
    const fixture = context({
      path: "/guide-content/videos/analytics.mp4",
      range: "bytes=20-30",
      ifRange: '"video-etag"',
      videos: { head, get },
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("NEWER");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("etag")).toBe('"replaced"');
  });

  it("returns the whole video when If-Range does not match an old range", async () => {
    const videos = videoBucket({ "videos/analytics.vtt": "WEBVTT" });
    const fixture = context({
      path: "/guide-content/videos/analytics.vtt",
      range: "bytes=40-50",
      ifRange: '"old-etag"',
      videos,
    });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("WEBVTT");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
  });

  it("does not serve a video outside the catalog", async () => {
    const videos = videoBucket({ "videos/not-a-lesson.mp4": "secret" });
    const fixture = context({ path: "/guide-content/videos/not-a-lesson.mp4", videos });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(404);
    expect(videos.head).not.toHaveBeenCalled();
    expect(videos.get).not.toHaveBeenCalled();
  });

  it("fails closed when guide video storage is not bound", async () => {
    const fixture = context({ path: "/guide-content/videos/analytics.mp4" });
    const response = await onRequest(fixture.value);
    expect(response.status).toBe(503);
    expect(fixture.fetchAsset).not.toHaveBeenCalled();
  });
});

