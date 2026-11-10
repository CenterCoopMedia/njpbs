import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import mediaDownload from "../../functions/media-download.js";
import r2Media from "../../functions/lib/r2-media.js";
import auth from "../../functions/lib/auth.js";

const {
  FORBIDDEN_MESSAGE,
  UNAVAILABLE_MESSAGE,
  attachmentDisposition,
  createCmsCreateMediaDownloadHandler,
  createDefaultSigner,
  downloadFileName,
} = mediaDownload;

const HASH = "a".repeat(64);
const MASTER_HASH = "b".repeat(64);
const master = (overrides = {}) => ({
  retained: true, key: `masters/bb/${MASTER_HASH}.jpg`, contentHash: MASTER_HASH,
  mimeType: "image/jpeg", sizeBytes: 8_000_000, width: 6000, height: 4000, ...overrides,
});

function stored(overrides = {}) {
  return {
    name: "Ocean Grove boardwalk",
    originalName: "Ocean Grove boardwalk.jpg",
    category: "news",
    categories: ["news"],
    tags: [],
    mimeType: "image/jpeg",
    kind: "image",
    sizeBytes: 2048,
    width: 1600,
    height: 900,
    url: `https://media.njpbs.org/cms-media/news/asset-1/${HASH}.jpg`,
    storageKey: `cms-media/news/asset-1/${HASH}.jpg`,
    lifecycle: "active",
    source: "upload",
    version: 1,
    ...overrides,
  };
}

function firestoreWith(data) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({ exists: name === "media_assets" && data !== null, id, data: () => data }),
      }),
    }),
  };
}

function response() {
  const res = { statusCode: null, body: null, headersSent: false, headers: new Map() };
  res.set = (name, value) => { res.headers.set(name.toLowerCase(), value); return res; };
  res.status = (statusCode) => { res.statusCode = statusCode; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  return res;
}

function request(body) {
  return {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

const editor = { uid: "editor-1", principal: { id: "editor-1", grants: [{ role: "editor" }] } };
const sportsOnly = {
  uid: "editor-2",
  principal: { id: "editor-2", grants: [{ role: "editor", sections: ["sports"], registeredMediaSections: ["sports"] }] },
};
const noMedia = { uid: "viewer-1", principal: { id: "viewer-1", grants: [{ role: "unknown" }] } };

async function run({ data = stored(), actor = editor, body = { assetId: "asset-1" } } = {}) {
  const signFn = vi.fn(async ({ key, disposition }) =>
    `https://r2.example.test/${key}?response-content-disposition=${encodeURIComponent(disposition)}`);
  const handler = createCmsCreateMediaDownloadHandler({
    firestore: firestoreWith(data),
    requirePrincipalFn: vi.fn(async () => actor),
    signFn,
    nowFn: () => Date.parse("2026-10-06T12:00:00.000Z"),
    log: { error: vi.fn() },
  });
  const res = response();
  await handler(request(body), res);
  return { res, signFn };
}

describe("media download file name", () => {
  it("keeps spaces and non-ASCII characters in filename* and gives an ASCII fallback", () => {
    expect(attachmentDisposition("Café niño 東京.jpg")).toBe(
      "attachment; filename=\"Caf_ ni_o __.jpg\"; " +
        "filename*=UTF-8''Caf%C3%A9%20ni%C3%B1o%20%E6%9D%B1%E4%BA%AC.jpg",
    );
  });

  it("escapes characters that would break the header or the RFC 5987 value", () => {
    expect(attachmentDisposition("a \"quote\" 100% (draft)'s*.png")).toBe(
      "attachment; filename=\"a _quote_ 100_ (draft)'s*.png\"; " +
        "filename*=UTF-8''a%20%22quote%22%20100%25%20%28draft%29%27s%2A.png",
    );
  });

  it("uses the stored type's extension when an optimized upload became WebP", () => {
    expect(downloadFileName("Board walk.jpg", "image/webp")).toBe("Board walk.webp");
    expect(downloadFileName("Board walk.JPEG", "image/jpeg")).toBe("Board walk.JPEG");
    expect(downloadFileName("notes", "application/pdf")).toBe("notes.pdf");
    expect(downloadFileName("a/b\\c\u0007.png", "image/png")).toBe("a_b_c_.png");
  });
});

describe("cmsCreateMediaDownload", () => {
  it("signs an attachment read of the stored object for a permitted editor", async () => {
    const { res, signFn } = await run({ data: stored({ originalName: "Café boardwalk.jpg" }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(signFn).toHaveBeenCalledWith({
      key: `cms-media/news/asset-1/${HASH}.jpg`,
      disposition: "attachment; filename=\"Caf_ boardwalk.jpg\"; filename*=UTF-8''Caf%C3%A9%20boardwalk.jpg",
    });
    expect(res.body).toEqual({
      success: true,
      url: expect.stringContaining("https://r2.example.test/"),
      fileName: "Café boardwalk.jpg",
      expiresAt: "2026-10-06T12:05:00.000Z",
    });
  });

  it("refuses a caller without media access before reading the asset", async () => {
    const { res, signFn } = await run({ actor: noMedia });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: FORBIDDEN_MESSAGE });
    expect(signFn).not.toHaveBeenCalled();
  });

  it.each([
    ["a binned asset in another category", { actor: sportsOnly, data: stored({ lifecycle: "binned" }) }],
    ["a missing asset", { data: null }],
    ["a binned asset", { data: stored({ lifecycle: "binned" }) }],
    ["a private voiceover", { data: stored({ source: "voiceover", kind: "audio", mimeType: "audio/wav" }) }],
    ["a key outside the asset", { data: stored({ storageKey: `cms-media/news/other/${HASH}.jpg` }) }],
  ])("answers unavailable for %s without signing", async (_label, options) => {
    const { res, signFn } = await run(options);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: UNAVAILABLE_MESSAGE });
    expect(signFn).not.toHaveBeenCalled();
  });

  it("signs a download across filing categories for an area-scoped Editor", async () => {
    const { res, signFn } = await run({ actor: sportsOnly });
    expect(res.statusCode).toBe(200);
    expect(res.body.fileName).toBe("Ocean Grove boardwalk.jpg");
    expect(signFn).toHaveBeenCalledOnce();
  });

  it("keeps the 401 status of an expired or revoked token", async () => {
    const authError = new auth.AuthError("Invalid or expired token");
    const signFn = vi.fn();
    const log = { error: vi.fn() };
    const handler = createCmsCreateMediaDownloadHandler({
      firestore: firestoreWith(stored()),
      requirePrincipalFn: vi.fn(async () => { throw authError; }),
      signFn,
      log,
    });
    const res = response();
    await handler(request({ assetId: "asset-1" }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Invalid or expired token" });
    expect(signFn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("answers unavailable for a built-in site image with no stored object", async () => {
    const { res, signFn } = await run({
      data: stored({ source: "site_seed", storageKey: null, url: "https://njpbs.org/images/one.jpg" }),
    });
    expect(res.statusCode).toBe(404);
    expect(signFn).not.toHaveBeenCalled();
  });

  it("rejects malformed requests", async () => {
    for (const body of [{}, { assetId: "../x" }, { assetId: "asset-1", extra: true }]) {
      const { res, signFn } = await run({ body });
      expect(res.statusCode).toBe(400);
      expect(signFn).not.toHaveBeenCalled();
    }
  });
});

describe("R2 signed read", () => {
  it("carries the disposition as a signed response-content-disposition parameter", async () => {
    const client = new S3Client(r2Media.r2ClientConfig({
      endpoint: "https://account.r2.cloudflarestorage.com",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    }));
    const disposition = attachmentDisposition("Café niño.jpg");
    const url = new URL(await getSignedUrl(client, new GetObjectCommand({
      Bucket: "media",
      Key: `cms-media/news/asset-1/${HASH}.jpg`,
      ResponseContentDisposition: disposition,
    }), { expiresIn: 300 }));
    expect(url.searchParams.get("response-content-disposition")).toBe(disposition);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
  });
});

// Exercise the actual signer/presigner; fake only R2's HTTP boundary with S3 responses.
describe("original and web download API contract", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function api({ variant, data = stored({ mimeType: "image/webp",
    storageKey: `cms-media/news/asset-1/${HASH}.webp`, master: master() }), actor = editor,
    headStatus = 200, authError, extraBody = {}, masterBucket = "private-originals", readError } = {}) {
    vi.stubEnv("CMS_MEDIA_R2_ENDPOINT", "https://account.r2.cloudflarestorage.com");
    vi.stubEnv("CMS_MEDIA_R2_BUCKET", "public-media");
    vi.stubEnv("CMS_MEDIA_MASTER_R2_BUCKET", masterBucket);
    vi.stubEnv("CMS_MEDIA_R2_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("CMS_MEDIA_R2_SECRET_ACCESS_KEY", "test-secret-key");
    const requests = [];
    const reads = [];
    const logs = [];
    const client = new S3Client({
      ...r2Media.r2ClientConfig({ endpoint: "https://account.r2.cloudflarestorage.com",
        accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" }),
      maxAttempts: 1,
      requestHandler: { handle: async (req, options) => {
        requests.push({ method: req.method, path: req.path, signal: options.abortSignal });
        return { response: { statusCode: headStatus, headers: {}, body: Buffer.alloc(0) } };
      } },
    });
    const backing = firestoreWith(data);
    const firestore = { collection: name => ({ doc: id => ({ get: async () => {
      reads.push(id);
      if (readError) throw readError;
      return backing.collection(name).doc(id).get();
    } }) }) };
    const handler = createCmsCreateMediaDownloadHandler({ firestore,
      requirePrincipalFn: async () => { if (authError) throw authError; return actor; },
      signFn: createDefaultSigner({ client }),
      nowFn: () => Date.parse("2026-10-06T12:00:00.000Z"), log: {
        error: (message, details) => logs.push({ level: "error", message, details }),
        warn: (message, details) => logs.push({ level: "warn", message, details }),
      },
    });
    const res = response();
    await handler(request({ assetId: "asset-1", ...(variant === undefined ? {} : { variant }), ...extraBody }), res);
    client.destroy();
    return { res, requests, reads, logs };
  }

  it.each([undefined, "web"])("preserves the web download for variant %s without a storage probe", async variant => {
    const { res, requests } = await api({ variant });
    expect(res.statusCode).toBe(200);
    expect(res.body.fileName).toBe("Ocean Grove boardwalk.webp");
    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/public-media/cms-media/news/asset-1/${HASH}.webp`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(requests).toEqual([]);
  });

  it.each([
    ["image/jpeg", "jpg"], ["image/png", "png"],
  ])("downloads the retained %s from the private bucket with its real extension", async (mimeType, ext) => {
    const { res, requests } = await api({ variant: "original", data: stored({
      mimeType: "image/webp", storageKey: `cms-media/news/asset-1/${HASH}.webp`,
      originalName: "Café boardwalk.webp", master: master({ mimeType, key: `masters/bb/${MASTER_HASH}.${ext}` }),
    }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body.fileName).toBe(`Café boardwalk.${ext}`);
    expect(res.body.expiresAt).toBe("2026-10-06T12:05:00.000Z");
    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/private-originals/masters/bb/${MASTER_HASH}.${ext}`);
    expect(url.searchParams.get("response-content-type")).toBe(mimeType);
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="Caf_ boardwalk.${ext}"; filename*=UTF-8''Caf%C3%A9%20boardwalk.${ext}`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "HEAD", path: `/private-originals/masters/bb/${MASTER_HASH}.${ext}` });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["original", "web"])("refuses unauthenticated and unauthorized %s before any asset read or R2 request", async variant => {
    for (const options of [
      { actor: noMedia, status: 403 },
      { authError: new auth.AuthError("Invalid or expired token"), status: 401 },
    ]) {
      const { res, reads, requests } = await api({ variant, ...options });
      expect(res.statusCode).toBe(options.status);
      expect(reads).toEqual([]);
      expect(requests).toEqual([]);
      expect(res.body).not.toHaveProperty("url");
    }
  });

  it.each(["original", "web"])("preserves audio-only admission and active-asset refusals for %s", async variant => {
    const audioOnly = { emailVerified: true, approvedActive: true,
      principal: { id: "audio-reader", grants: [{ role: "staff" }] } };
    for (const options of [{ actor: audioOnly }, { data: null }, { data: stored({ lifecycle: "binned" }) },
      { data: stored({ storageKey: `cms-media/news/other/${HASH}.jpg` }) },
      { data: stored({ source: "site_seed", storageKey: null }) },
      { data: stored({ source: "voiceover", kind: "audio", mimeType: "audio/wav" }) }]) {
      const { res, requests } = await api({ variant, ...options });
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: UNAVAILABLE_MESSAGE });
      expect(requests).toEqual([]);
    }
  });

  it.each([undefined, null, master({ retained: false }), master({ key: `masters/bb/${MASTER_HASH}.png` }),
    master({ contentHash: "invalid" }), master({ mimeType: "image/webp" }), master({ sizeBytes: 0 }),
  ])("refuses absent or invalid master receipts with no fallback", async receipt => {
    const { res, requests } = await api({ variant: "original", data: stored({ master: receipt, originalAvailable: true }) });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: UNAVAILABLE_MESSAGE });
    expect(requests).toEqual([]);
  });

  it("checks older retained receipts and refuses a missing object without signing a substitute", async () => {
    const { res, requests, logs } = await api({ variant: "original", headStatus: 404 });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: UNAVAILABLE_MESSAGE });
    expect(requests).toHaveLength(1);
    expect(logs).toEqual([{ level: "warn", message: "cmsCreateMediaDownload original unavailable", details: {
      status: 404, errorName: "NotFound", providerStatus: 404,
      message: UNAVAILABLE_MESSAGE, operation: "original HEAD",
    } }]);
  });

  it("sanitizes a storage refusal and keeps it recoverable", async () => {
    const { res, requests, logs } = await api({ variant: "original", headStatus: 403 });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "The original could not be checked. Try again." });
    expect(requests).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "error", details: {
      status: 503, providerStatus: 403, operation: "original HEAD",
    } });
  });

  it.each(["original", "web"])("logs safe cause diagnostics for %s without serializing arbitrary messages or values", async variant => {
    const error = Object.assign(new Error("private-provider-message"), {
      name: "private-provider-name", code: 14, credentials: "private-provider-credentials", stack: "private-provider-stack",
    });
    const { res, logs } = await api({ variant, readError: error });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to prepare the download" });
    expect(logs).toEqual([{ level: "error", message: "cmsCreateMediaDownload failed", details: {
      status: 500, errorName: "UnexpectedError", message: "Unexpected download failure", operation: "prepare download", code: 14,
    } }]);
    expect(JSON.stringify(logs)).not.toContain("private-provider");
  });

  it.each(["", "public-media"])("refuses unavailable or nonprivate master configuration %s without storage work", async masterBucket => {
    const { res, requests } = await api({ variant: "original", masterBucket });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "The media store is not configured" });
    expect(requests).toEqual([]);
  });

  it.each(["original", "web"])("keeps license and filing notes informational for %s", async variant => {
    const { res } = await api({ variant, actor: sportsOnly, data: stored({
      category: "development", categories: ["development"], license: "Rights need checking", credit: null,
      mimeType: "image/webp", storageKey: `cms-media/development/asset-1/${HASH}.webp`,
      master: master(), duplicateNotes: "Similar photo exists",
    }) });
    expect(res.statusCode).toBe(200);
  });

  it.each([null, "master", "", 1, {}, ["original"]])("rejects invalid variant %s before storage", async variant => {
    const { res, requests, reads } = await api({ variant });
    expect(res.statusCode).toBe(400);
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });
});
