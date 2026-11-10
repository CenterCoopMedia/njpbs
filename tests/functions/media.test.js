import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pcmWave } from "../helpers/wave-audio.js";
import { createHash } from "node:crypto";
import { createServer, connect } from "node:http2";
import { once } from "node:events";
import sharp from "sharp";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import adminPkg from "../helpers/firebase-admin.js";
import media from "../../functions/media.js";
import replacement from "../../functions/replace-media.js";
import mediaLibrary from "../../functions/lib/media-library.js";
import mediaListing from "../../functions/list-media.js";
import mediaContract from "../../functions/lib/media-contract.js";
import authorContract from "../../functions/lib/author-profile-contract.js";
import r2Media from "../../functions/lib/r2-media.js";
import imageCredits from "../../functions/lib/image-credits.js";
import r2MediaMasters from "../../functions/lib/r2-media-masters.js";

// The SDK exposes its backoff clock only in its internal CommonJS module.
// Keep the override at the clock boundary; Firestore transactions stay real.
const adminRequire = createRequire(
  createRequire(import.meta.url).resolve("firebase-admin/firestore"),
);
const firestoreBackoff = adminRequire(
  join(dirname(adminRequire.resolve("@google-cloud/firestore")), "backoff.js"),
);

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNg+M/wHwAEAQH/U7xMcQAAAABJRU5ErkJggg==",
  "base64",
);

/** The tag numbers in an EXIF block's first image directory. */
function ifd0Tags(exif) {
  if (!Buffer.isBuffer(exif)) return [];
  const tiff = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? exif.subarray(6) : exif;
  const little = tiff.subarray(0, 2).toString("latin1") === "II";
  const u16 = (offset) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
  const u32 = (offset) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
  const ifd = u32(4);
  return Array.from({ length: u16(ifd) }, (_, index) => u16(ifd + 2 + index * 12));
}

function minimalPdf() {
  const header = "%PDF-1.4\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>\nendobj\n",
  ];
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  const xref = [
    "xref",
    "0 4",
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    "<< /Size 4 /Root 1 0 R >>",
    "startxref",
    String(xrefOffset),
    "%%EOF",
    "",
  ].join("\n");
  return Buffer.from(body + xref);
}

const {
  commitUpload,
  createCmsUploadMediaHandler,
  cmsUploadMedia,
  discardCapacityRejectedUpload,
  assertProfilePhotoUpload,
  inspectUpload,
  parseMultipartUpload,
  processUploadImage,
  validateUploadRequest,
  webCopyDimensions,
} = media;
const { readImageCredits } = imageCredits;
const { masterObjectKey } = r2MediaMasters;
const { DEFAULT_MAX_UPLOAD_BYTES, normalizeUploadMetadata } = mediaContract;
const { AUTHOR_PHOTO_MAX_BYTES } = authorContract;
const { R2MediaStorage, r2ClientConfig } = r2Media;

let db;

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false, headers: {} };
  res.set = (name, value) => {
    res.headers[name.toLocaleLowerCase("en-US")] = value;
    return res;
  };
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.headersSent = true;
    return res;
  };
  return res;
}

function actor(grants = [{ role: "editor" }]) {
  return {
    uid: "editor-1",
    email: "editor@example.org",
    principal: { id: "editor-1", grants },
  };
}

function ids(...values) {
  return () => {
    const next = values.shift();
    if (!next) throw new Error("The test id minter ran out of values");
    return next;
  };
}

function validUpload(overrides = {}) {
  return {
    originalName: "studio.png",
    mimeType: "image/png",
    buffer: PNG,
    fields: {
      name: "Studio control room",
      category: "news",
      categories: ["news"],
      description: "The NJ PBS studio control room.",
      altText: "Monitors in the NJ PBS control room",
      license: "NJ PBS owned",
      credit: "NJ PBS",
      tags: "studio, newsroom, Studio",
    },
    ...overrides,
  };
}

function memoryStorage({
  failDeleteFinal = false,
  failDeleteStaging = false,
  failFinal = false,
} = {}) {
  const objects = new Map();
  let shouldFailFinal = failFinal;
  let shouldFailDeleteStaging = failDeleteStaging;
  return {
    objects,
    setFailFinal(value) {
      shouldFailFinal = value;
    },
    setFailDeleteStaging(value) {
      shouldFailDeleteStaging = value;
    },
    async putStaging({ key, body, mimeType, metadata }) {
      objects.set(key, { body, mimeType, metadata });
    },
    async putFinal({ key, body, mimeType, metadata }) {
      if (shouldFailFinal) throw new Error("R2 connection failed");
      if (objects.has(key)) return { created: false };
      objects.set(key, { body, mimeType, metadata });
      return { created: true };
    },
    async head(key) {
      const object = objects.get(key);
      if (!object) throw new Error("Not found");
      return {
        contentLength: object.body.length,
        contentType: object.mimeType,
        metadata: object.metadata,
      };
    },
    async deleteStaging(key) {
      if (shouldFailDeleteStaging) throw new Error("R2 delete failed");
      objects.delete(key);
    },
    async deleteFinal(key) {
      if (failDeleteFinal) throw new Error("R2 delete failed");
      objects.delete(key);
    },
  };
}

function handler({
  upload = validUpload(),
  principal = actor(),
  storage = memoryStorage(),
  mintId = ids("asset-one", "attempt-one"),
  now = () => new Date("2026-08-13T12:00:00.000Z"),
  commitUploadFn,
  processUploadImageFn,
  masterStorageFactory = () => null,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
  log = { error: vi.fn(), warn: vi.fn() },
} = {}) {
  return {
    storage,
    log,
    run: createCmsUploadMediaHandler({
      firestore: db,
      requirePrincipalFn: async () => principal,
      parseUploadFn: async () => upload,
      storageFactory: () => storage,
      masterStorageFactory,
      mintId,
      now,
      maxUploadBytes,
      publicOrigin: "https://media.njpbs.org",
      ...(commitUploadFn ? { commitUploadFn } : {}),
      ...(processUploadImageFn ? { processUploadImageFn } : {}),
      log,
    }),
  };
}

async function invoke(run) {
  const res = makeRes();
  await run(
    {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "x-forwarded-for": "203.0.113.7",
      },
      ip: "127.0.0.1",
      rawBody: PNG,
    },
    res,
  );
  return res;
}

async function documents(collection) {
  const snapshot = await db.collection(collection).get();
  return snapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
  }));
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("media.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
  await Promise.all(
    ["general", "news", "arts", "staff-profile"].map((category, order) =>
      db.collection("mediaCategories").doc(category).set({
        id: category,
        label: category === "staff-profile" ? "Staff profiles" : category,
        description: "Test category",
        order,
        active: true,
        version: 1,
      }),
    ),
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("media upload validation", () => {
  it("binds the R2 credentials and the CMS edge secret", () => {
    expect(cmsUploadMedia.__endpoint.secretEnvironmentVariables).toEqual([
      { key: "CMS_MEDIA_R2_ACCESS_KEY_ID" },
      { key: "CMS_MEDIA_R2_SECRET_ACCESS_KEY" },
      { key: "CMS_EDGE_ORIGIN_SECRET" },
    ]);
    expect(cmsUploadMedia.__endpoint).toMatchObject({
      availableMemoryMb: 1024,
      concurrency: 1,
      maxInstances: 5,
      timeoutSeconds: 120,
    });
  });

  it("normalizes searchable metadata and removes duplicate tags", () => {
    expect(
      normalizeUploadMetadata(validUpload().fields, "fallback.png"),
    ).toEqual({
      name: "Studio control room",
      category: "news",
      categories: ["news"],
      description: "The NJ PBS studio control room.",
      altText: "Monitors in the NJ PBS control room",
      license: "NJ PBS owned",
      credit: "NJ PBS",
      tags: ["studio", "newsroom"],
    });
  });

  it("keeps the license optional and requires path-safe categories", () => {
    expect(() =>
      normalizeUploadMetadata({ category: "News/Local" }, "photo.png"),
    ).toThrow(
      "Category must use lowercase letters, numbers, and single hyphens",
    );
    expect(
      normalizeUploadMetadata({ category: "news" }, "photo.png"),
    ).toHaveProperty("license", null);
  });

  it("reads image dimensions from the bytes rather than trusting the browser", async () => {
    await expect(inspectUpload(PNG, "image/png")).resolves.toEqual({
      width: 1,
      height: 1,
      animated: false,
    });
    await expect(inspectUpload(PNG, "image/jpeg")).rejects.toMatchObject({
      status: 415,
    });
  });

  it("records animation only when a WebP has more than one frame", async () => {
    const frame = (background) => sharp({
      create: { width: 2, height: 2, channels: 3, background },
    }).raw().toBuffer();
    const animated = await sharp(Buffer.concat([
      await frame({ r: 200, g: 0, b: 0 }),
      await frame({ r: 0, g: 0, b: 200 }),
    ]), {
      raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
      animated: true,
      pages: 2,
    }).webp().toBuffer();
    const still = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).webp().toBuffer();

    await expect(inspectUpload(animated, "image/webp")).resolves.toMatchObject({
      width: 2,
      height: 2,
      animated: true,
    });
    await expect(inspectUpload(still, "image/webp")).resolves.toEqual({
      width: 2,
      height: 2,
      animated: false,
    });
    expect(() => assertProfilePhotoUpload({
      mimeType: "image/webp",
      sizeBytes: 120_000,
      dimensions: { width: 400, height: 400 },
      animated: true,
    })).toThrow(/still image/);
  });

  it("converts a requested PNG to verified WebP bytes", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).png().toBuffer();
    const dimensions = { width: 2, height: 3 };
    const processed = await processUploadImage(
      png,
      "image/png",
      "webp",
      dimensions,
    );

    expect(processed.mimeType).toBe("image/webp");
    expect(processed.buffer).not.toEqual(png);
    await expect(inspectUpload(processed.buffer, processed.mimeType)).resolves
      .toEqual({ width: 2, height: 3, animated: false });
    await expect(
      processUploadImage(
        minimalPdf(),
        "application/pdf",
        "webp",
        { width: null, height: null },
      ),
    ).rejects.toMatchObject({ status: 415 });
    const webp = await sharp(png).webp().toBuffer();
    await expect(
      processUploadImage(webp, "image/webp", "webp", dimensions),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      processUploadImage(png, "image/png", "lossless", dimensions),
    ).rejects.toThrow("Image processing must be webp");
  });

  it("sizes the web copy within both the long-side and pixel limits", () => {
    expect(webCopyDimensions({ width: 4_000, height: 3_000 })).toEqual({
      width: 4_000,
      height: 3_000,
    });
    // 6000 x 6000 fits the long side but is 36 megapixels.
    expect(webCopyDimensions({ width: 6_000, height: 6_000 })).toEqual({
      width: 5_000,
      height: 5_000,
    });
    for (const size of [
      { width: 10_000, height: 8_000 },
      { width: 8_000, height: 10_000 },
      { width: 12_000, height: 2_000 },
      { width: 6_001, height: 4_167 },
    ]) {
      const target = webCopyDimensions(size);
      expect(Math.max(target.width, target.height)).toBeLessThanOrEqual(6_000);
      expect(target.width * target.height).toBeLessThanOrEqual(25_000_000);
      expect(target.width / target.height).toBeCloseTo(size.width / size.height, 2);
    }
  });

  it("scales an oversize photo into a web copy instead of refusing it", async () => {
    const jpeg = await sharp({
      create: { width: 7_000, height: 1_000, channels: 3, background: "#336699" },
    }).jpeg().toBuffer();
    const processed = await processUploadImage(jpeg, "image/jpeg", "webp", {
      width: 7_000,
      height: 1_000,
    });

    expect(processed.mimeType).toBe("image/webp");
    await expect(inspectUpload(processed.buffer, "image/webp")).resolves.toEqual({
      width: 6_000,
      height: 857,
      animated: false,
    });
  });

  it("keeps credit, caption and copyright and drops the GPS position", async () => {
    const jpeg = await sharp({
      create: { width: 64, height: 32, channels: 3, background: "#224466" },
    })
      .withExif({
        IFD0: {
          Artist: "Jane Doe/NJ PBS",
          Copyright: "2026 NJ PBS",
          ImageDescription: "Trenton, N.J.: The State House dome.",
        },
        IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 13/1 0/1" },
      })
      .jpeg()
      .toBuffer();
    const sourceTags = ifd0Tags((await sharp(jpeg).metadata()).exif);
    expect(sourceTags).toContain(0x8825);

    const processed = await processUploadImage(jpeg, "image/jpeg", "webp", {
      width: 64,
      height: 32,
    });

    expect(processed.credits).toEqual({
      credit: "Jane Doe/NJ PBS",
      caption: "Trenton, N.J.: The State House dome.",
      copyright: "2026 NJ PBS",
    });
    const output = await sharp(processed.buffer).metadata();
    expect(output.xmp).toBeUndefined();
    const outputTags = ifd0Tags(output.exif);
    expect(outputTags).not.toContain(0x8825);
    expect(readImageCredits(output)).toEqual(processed.credits);
  });

  it("applies the EXIF orientation to the web copy", async () => {
    const jpeg = await sharp({
      create: { width: 64, height: 32, channels: 3, background: "#224466" },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const dimensions = await inspectUpload(jpeg, "image/jpeg");
    expect(dimensions).toMatchObject({ width: 32, height: 64 });

    const processed = await processUploadImage(jpeg, "image/jpeg", "webp", dimensions);
    const output = await sharp(processed.buffer).metadata();

    expect({ width: output.width, height: output.height }).toEqual({
      width: 32,
      height: 64,
    });
    expect(output.orientation ?? 1).toBe(1);
  });

  it("reads IPTC credits before EXIF and falls back to Latin-1 text", () => {
    const dataset = (number, bytes) =>
      Buffer.concat([Buffer.from([0x1c, 2, number, bytes.length >> 8, bytes.length & 0xff]), bytes]);
    const iptc = Buffer.concat([
      Buffer.from("Photoshop 3.0\0"),
      dataset(80, Buffer.from("By-line name")),
      dataset(110, Buffer.from("AP Photo/Jos\xe9 Garc\xeda", "latin1")),
      dataset(120, Buffer.from("A caption from IPTC")),
    ]);

    expect(readImageCredits({ iptc })).toEqual({
      credit: "AP Photo/José García",
      caption: "A caption from IPTC",
      copyright: null,
    });
    expect(readImageCredits({})).toBeNull();
    expect(readImageCredits({ exif: Buffer.from("not exif"), iptc: Buffer.alloc(3) })).toBeNull();
  });

  it("accepts a minimal valid PDF and refuses a truncated PDF prefix", async () => {
    await expect(
      inspectUpload(minimalPdf(), "application/pdf"),
    ).resolves.toEqual({ width: null, height: null, animated: false });
    await expect(
      inspectUpload(Buffer.from("%PDF-1.7\n"), "application/pdf"),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      inspectUpload(Buffer.from("not a pdf"), "application/pdf"),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("parses one bounded multipart file and rejects an oversized file", async () => {
    const boundary = "cms-media-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="license"\r\n\r\nNJ PBS owned\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="imageProcessing"\r\n\r\nwebp\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      Buffer.from("%PDF-1.7\n"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    };
    await expect(parseMultipartUpload(req, 20)).resolves.toMatchObject({
      originalName: "tiny.pdf",
      mimeType: "application/pdf",
      fields: { license: "NJ PBS owned", imageProcessing: "webp" },
    });
    await expect(parseMultipartUpload(req, 5)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("uses an exact field set for the replacement multipart contract", async () => {
    const boundary = "cms-media-replacement-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="assetId"\r\n\r\nasset-one\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const req = {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    };

    await expect(
      parseMultipartUpload(req, PNG.length + 10, new Set(["assetId"])),
    ).resolves.toMatchObject({
      originalName: "tiny.png",
      mimeType: "image/png",
      fields: { assetId: "asset-one" },
    });
    await expect(parseMultipartUpload(req, PNG.length + 10)).rejects.toThrow(
      "Unknown upload field assetId",
    );
  });

  it("rejects a multipart field that Busboy truncates", async () => {
    const boundary = "cms-media-boundary";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n${"x".repeat(8_001)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n\r\n--${boundary}--\r\n`,
    );

    await expect(
      parseMultipartUpload(
        {
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          rawBody: body,
        },
        20,
      ),
    ).rejects.toThrow("Upload field description is too long");
  });

  it("rejects compressed, non-multipart, and oversized request bodies before parsing", () => {
    expect(() =>
      validateUploadRequest(
        {
          headers: {
            "content-encoding": "gzip",
            "content-type": "multipart/form-data; boundary=test",
          },
          rawBody: PNG,
        },
        100,
      ),
    ).toThrow(expect.objectContaining({ status: 415 }));
    expect(() =>
      validateUploadRequest(
        {
          headers: { "content-type": "application/json" },
          rawBody: PNG,
        },
        100,
      ),
    ).toThrow(expect.objectContaining({ status: 415 }));
    expect(() =>
      validateUploadRequest(
        {
          headers: { "content-type": "multipart/form-data; boundary=test" },
          rawBody: Buffer.alloc(128 * 1024 + 11),
        },
        10,
      ),
    ).toThrow(expect.objectContaining({ status: 413 }));
  });
});

describe("R2 media adapter", () => {
  it("uses only checksums that R2 requires", () => {
    expect(
      r2ClientConfig({
        endpoint: "https://account.r2.cloudflarestorage.com",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      }),
    ).toMatchObject({
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  });

  it("conditionally creates an immutable final object with long-lived cache metadata", async () => {
    const client = { send: vi.fn(async () => ({})) };
    const storage = new R2MediaStorage({ bucket: "cms-media", client });
    await expect(
      storage.putFinal({
        key: "cms-media/news/asset/hash.png",
        body: PNG,
        mimeType: "image/png",
        metadata: { contenthash: "hash" },
      }),
    ).resolves.toEqual({ created: true });
    expect(client.send).toHaveBeenCalledOnce();
    expect(client.send.mock.calls[0][0].input).toMatchObject({
      Bucket: "cms-media",
      Key: "cms-media/news/asset/hash.png",
      ContentLength: PNG.length,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable",
      IfNoneMatch: "*",
      Metadata: { contenthash: "hash" },
    });
  });

  it("reports a conditional conflict without overwriting the existing object", async () => {
    const client = {
      send: vi.fn(async () => {
        const error = new Error("Precondition failed");
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }),
    };
    const storage = new R2MediaStorage({ bucket: "cms-media", client });
    await expect(
      storage.putFinal({
        key: "cms-media/news/asset/hash.png",
        body: PNG,
        mimeType: "image/png",
        metadata: {},
      }),
    ).resolves.toEqual({ created: false });
  });

  it("deletes the requested uncommitted final object", async () => {
    const client = { send: vi.fn(async () => ({})) };
    const storage = new R2MediaStorage({ bucket: "cms-media", client });

    await expect(
      storage.deleteFinal("cms-media/news/asset/hash.png"),
    ).resolves.toBeUndefined();
    expect(client.send).toHaveBeenCalledOnce();
    expect(client.send.mock.calls[0][0].input).toEqual({
      Bucket: "cms-media",
      Key: "cms-media/news/asset/hash.png",
    });
  });

  it("deletes thumbnail objects before the original", async () => {
    const client = { send: vi.fn(async () => ({})) };
    const storage = new R2MediaStorage({ bucket: "cms-media", client });
    await storage.deleteFinal("original.jpg", ["thumb-480.webp", "thumb-960.webp"]);
    expect(client.send.mock.calls.map(([command]) => command.input.Key)).toEqual([
      "thumb-480.webp", "thumb-960.webp", "original.jpg",
    ]);
  });
});

describe("cmsUploadMedia", () => {
  it("stores an explicit upload metadata request in the private record and library summary", async () => {
    const instance = handler({ upload: validUpload({ fields: { ...validUpload().fields, metadataUpdateRequested: "true" } }) });
    const response = await invoke(instance.run);
    expect(response.statusCode).toBe(201);
    expect(response.body.asset.metadataUpdateRequested).toBe(true);
    const listed = await mediaListing.readMediaAssetSummaries(db);
    expect(listed.records.find(asset => asset.id === response.body.asset.id).metadataUpdateRequested).toBe(true);
    expect((await db.collection("media_assets").doc(response.body.asset.id).get()).data().metadataUpdateRequested).toBe(true);
    expect((await db.collection("media_assets_public").doc(response.body.asset.id).get()).data()).not.toHaveProperty("metadataUpdateRequested");
  });

  it("uploads general PCM audio with missing rights metadata through the existing ledger", async () => {
    const upload = validUpload({ originalName: "interview.wav", mimeType: "audio/wav", buffer: pcmWave(),
      fields: { category: "news", name: "Interview", description: "Station interview" } });
    const instance = handler({ upload });
    const response = await invoke(instance.run);
    expect(response.statusCode).toBe(201);
    expect(response.body.asset).toMatchObject({ kind: "audio", mimeType: "audio/wav", width: null, height: null,
      name: "Interview", license: null, credit: null, categories: ["news"] });
    const rows = await documents("media_assets");
    expect(rows).toHaveLength(1);
    expect(rows[0].mediaDiscovery).toMatchObject({ schema: 1, eligible: true });
    expect([...instance.storage.objects.keys()]).toEqual([
      expect.stringMatching(/^cms-media\/news\/asset-one\/[a-f0-9]{64}\.wav$/),
    ]);
    const repeated = handler({ upload, storage: instance.storage, mintId: ids("asset-two", "attempt-two") });
    const duplicate = await invoke(repeated.run);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.duplicateAssetId).toBe("asset-one");
    expect(await documents("media_assets")).toHaveLength(1);
    const reader = { ...actor([{role:"editor",sections:["arts"],registeredMediaSections:["arts"]},{role:"staff"}]), emailVerified:true,approvedActive:true };
    const crossCategory = handler({ upload:validUpload({originalName:"interview.wav",mimeType:"audio/wav",buffer:pcmWave(),fields:{category:"arts"}}),
      principal:reader,storage:instance.storage,mintId:ids("asset-three","attempt-three") });
    const reused = await invoke(crossCategory.run);
    expect(reused.statusCode).toBe(409);
    expect(reused.body.duplicateAssetId).toBe("asset-one");
    expect(await documents("media_assets")).toHaveLength(1);
  });

  it("reuses private voiceover bytes across categories without creating a public object", async () => {
    const buffer = pcmWave();
    const takeId = "watching-station-01";
    const assetId = `voiceover-${takeId}`;
    await db.collection("media_assets").doc(assetId).set({
      kind: "audio", mimeType: "audio/wav", lifecycle: "active", source: "voiceover", category: "arts",
      voiceoverTakeId: takeId, storageKey: `takes/v1/${takeId}.wav`, sizeBytes: buffer.length,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      voiceover: { manifestVersion: 1, id: takeId, family_id: "watching-station", family: "Watching NJ PBS",
        take: 1, style: "soft-spoken", performer_id: "jules-avery", performer_name: "Jules Avery",
        text: "Watching NJ PBS", display_text: "Watching NJ PBS", complete: true, flags: [] },
    });
    const upload = validUpload({ originalName: "reading.wav", mimeType: "audio/wav", buffer });
    const visible = handler({ upload });
    const response = await invoke(visible.run);
    expect(response.statusCode).toBe(409);
    expect(response.body.duplicateAssetId).toBe(assetId);
    expect(visible.storage.objects.size).toBe(0);
    const hidden = handler({ upload, principal: actor([{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }]) });
    const denied = await invoke(hidden.run);
    expect(denied.statusCode).toBe(409);
    expect(denied.body.duplicateAssetId).toBe(assetId);
    expect(hidden.storage.objects.size).toBe(0);
    const mixedGrants = [{role:"editor",sections:["news"],registeredMediaSections:["news"]},{role:"staff"}];
    const reader = handler({upload,principal:{...actor(mixedGrants),emailVerified:true,approvedActive:true}});
    const reused = await invoke(reader.run);
    expect(reused.statusCode).toBe(409);
    expect(reused.body.duplicateAssetId).toBe(assetId);
    expect(reader.storage.objects.size).toBe(0);
    const unverified = handler({upload,principal:{...actor(mixedGrants),emailVerified:false,approvedActive:true}});
    expect((await invoke(unverified.run)).body.duplicateAssetId).toBe(assetId);
    const unapproved = handler({upload,principal:{...actor(mixedGrants),emailVerified:true,approvedActive:false}});
    expect((await invoke(unapproved.run)).body.duplicateAssetId).toBe(assetId);
    expect(await documents("media_assets")).toHaveLength(1);
  });

  it("blocks malformed audio and callers without upload before storage", async () => {
    const malformed = handler({ upload: validUpload({ originalName: "forged.wav", mimeType: "audio/wav", buffer: PNG }) });
    expect((await invoke(malformed.run)).statusCode).toBe(415);
    expect(malformed.storage.objects.size).toBe(0);
    const forbidden = handler({ principal: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]),
      upload: validUpload({ originalName: "interview.wav", mimeType: "audio/wav", buffer: pcmWave() }) });
    expect((await invoke(forbidden.run)).statusCode).toBe(403);
    expect(await documents("media_assets")).toHaveLength(0);
  });
  it("returns the committed original with a retry state when thumbnail storage fails", async () => {
    const storage = memoryStorage();
    const putFinal = storage.putFinal.bind(storage);
    storage.putFinal = vi.fn(async (input) => {
      if (input.key.includes("/thumbs/")) throw new Error("Thumbnail write failed");
      return putFinal(input);
    });
    const log = { error: vi.fn(), warn: vi.fn() };
    const instance = handler({ storage, log });
    const res = await invoke(instance.run);
    expect(res.statusCode).toBe(201);
    expect(res.body.asset).not.toHaveProperty("thumbnails");
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .not.toHaveProperty("thumbnails");
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toHaveProperty("thumbnailStatus", "retryable");
    expect(log.warn).toHaveBeenCalledWith(
      "Media thumbnails could not be saved",
      expect.objectContaining({ assetId: "asset-one" }),
    );
  });
  it("returns a 401 without an error log for a missing bearer token", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const run = createCmsUploadMediaHandler({
      firestore: db,
      requirePrincipalFn: async () => {
        throw Object.assign(
          new Error("Missing or invalid authorization header"),
          {
            status: 401,
          },
        );
      },
      log,
    });

    const res = await invoke(run);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: "Missing or invalid authorization header",
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("hides an unexpected storage error before reservation", async () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const storage = memoryStorage();
    storage.putStaging = vi.fn(async () => {
      throw new Error(
        "R2 request failed for secret-bucket.r2.cloudflarestorage.com",
      );
    });
    const instance = handler({ storage, log });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: "The media file could not be uploaded",
    });
    expect(log.error).toHaveBeenCalledWith(
      "cmsUploadMedia failed",
      expect.objectContaining({
        error: expect.stringContaining("secret-bucket"),
      }),
    );
  });

  it("stores display dimensions for EXIF orientations 5 through 8", async () => {
    for (const orientation of [5, 6, 7, 8]) {
      const rotated = await sharp({
        create: {
          width: 2,
          height: 3,
          channels: 3,
          background: { r: 30, g: 60, b: 90 },
        },
      })
        .jpeg()
        .withMetadata({ orientation })
        .toBuffer();
      const assetId = `asset-orientation-${orientation}`;
      const instance = handler({
        upload: validUpload({
          originalName: `orientation-${orientation}.jpg`,
          mimeType: "image/jpeg",
          buffer: rotated,
        }),
        mintId: ids(assetId, `attempt-orientation-${orientation}`),
      });
      const res = await invoke(instance.run);

      expect(res.statusCode, `orientation ${orientation}`).toBe(201);
      expect(res.body.asset, `orientation ${orientation}`).toMatchObject({
        width: 3,
        height: 2,
      });
      const projection = await db
        .collection("media_assets_public")
        .doc(assetId)
        .get();
      expect(projection.data(), `orientation ${orientation}`).toMatchObject({
        width: 3,
        height: 2,
      });
    }
  });

  it("commits the immutable original and thumbnail, private record, five-field projection, owner, and audit row", async () => {
    const contentHash = createHash("sha256").update(PNG).digest("hex");
    const thumbnailKey = `cms-media/news/asset-one/thumbs/${contentHash}-w1.webp`;
    const instance = handler();
    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({
      id: "asset-one",
      category: "news",
      categories: ["news"],
      tags: ["studio", "newsroom"],
      mimeType: "image/png",
      width: 1,
      height: 1,
      lifecycle: "active",
      license: "NJ PBS owned",
      version: 1,
      url: expect.stringMatching(
        /^https:\/\/media\.njpbs\.org\/cms-media\/news\/asset-one\/[a-f0-9]{64}\.png$/,
      ),
    });
    expect(res.body.asset).not.toHaveProperty("contentHash");
    expect(res.body.asset).not.toHaveProperty("storageKey");
    expect(instance.storage.objects.has("cms-media-staging/attempt-one")).toBe(
      false,
    );
    expect([...instance.storage.objects.keys()]).toEqual([
      `cms-media/news/asset-one/${contentHash}.png`,
      thumbnailKey,
    ]);

    const privateRows = await documents("media_assets");
    expect(privateRows).toHaveLength(1);
    expect(privateRows[0]).toMatchObject({
      id: "asset-one",
      createdBy: "editor-1",
      version: 1,
      thumbnailStatus: "ready",
    });
    expect(privateRows[0].thumbnails).toEqual([{
      storageKey: thumbnailKey,
      url: `https://media.njpbs.org/${thumbnailKey}`,
      width: 1,
      height: 1,
    }]);
    const publicRows = await documents("media_assets_public");
    expect(publicRows).toHaveLength(1);
    expect(Object.keys(publicRows[0]).sort()).toEqual([
      "altText",
      "credit",
      "height",
      "id",
      "mimeType",
      "url",
      "width",
    ]);
    const owner = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(privateRows[0].contentHash)
      .get();
    expect(owner.data()).toMatchObject({
      state: "committed",
      attemptId: "attempt-one",
      assetId: "asset-one",
    });
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.upload",
        target: "media_assets/asset-one",
      }),
    ]);
  });

  it("rechecks the managed category in the final upload transaction", async () => {
    const ref = db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc("a".repeat(64));
    await ref.set({
      attemptId: "attempt-one",
      state: "object_ready",
      leaseExpiresAt: "2026-08-13T12:15:00.000Z",
    });
    await db.collection("mediaCategories").doc("news").update({ active: false });

    await expect(
      commitUpload({
        firestore: db,
        ref,
        attemptId: "attempt-one",
        record: {
          id: "asset-one",
          category: "news",
          contentHash: "a".repeat(64),
          mimeType: "image/png",
          sizeBytes: PNG.length,
          license: "NJ PBS owned",
        },
        projection: { id: "asset-one" },
        actor: actor(),
        source: {},
        nowIso: "2026-08-13T12:00:00.000Z",
        expectedLeaseExpiresAt: "2026-08-13T12:15:00.000Z",
      }),
    ).rejects.toMatchObject({
      message: "Choose an active media category",
      status: 400,
    });
    expect(await documents("media_assets")).toHaveLength(0);
    expect((await ref.get()).data()?.state).toBe("object_ready");
  });

  it("discards an upload when its category is archived before commit", async () => {
    const storage = memoryStorage();
    const commitAfterArchive = vi.fn(async (options) => {
      await db
        .collection("mediaCategories")
        .doc("news")
        .update({ active: false });
      return commitUpload(options);
    });
    const instance = handler({
      storage,
      commitUploadFn: commitAfterArchive,
    });

    const response = await invoke(instance.run);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "Choose an active media category",
    });
    expect(commitAfterArchive).toHaveBeenCalledOnce();
    expect([...storage.objects.keys()]).toEqual([]);
    const owners = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(owners.empty).toBe(true);
    expect(await documents("media_assets")).toHaveLength(0);
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.upload.discard",
        before: expect.objectContaining({
          category: "news",
          reason: "invalid_media_category",
        }),
        after: null,
      }),
    ]);
  });

  it("commits multiple active category assignments without changing the owning path", async () => {
    const instance = handler({
      upload: validUpload({
        fields: {
          ...validUpload().fields,
          categories: JSON.stringify(["arts", "news"]),
        },
      }),
    });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({
      category: "news",
      categories: ["news", "arts"],
      url: expect.stringContaining("/cms-media/news/asset-one/"),
    });
    expect((await db.collection("media_assets").doc("asset-one").get()).data())
      .toMatchObject({ category: "news", categories: ["news", "arts"] });
  });

  it("stores requested PNG processing as an immutable WebP object", async () => {
    const png = await sharp({
      create: {
        width: 2,
        height: 3,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    }).png().toBuffer();
    const instance = handler({
      upload: validUpload({
        buffer: png,
        fields: { ...validUpload().fields, imageProcessing: "webp" },
      }),
    });
    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({
      originalName: "studio.png",
      mimeType: "image/webp",
      width: 2,
      height: 3,
      url: expect.stringMatching(/\.webp$/),
    });
    const [[key, object]] = [...instance.storage.objects.entries()];
    expect(key).toMatch(/\.webp$/);
    expect(object.mimeType).toBe("image/webp");
    await expect(inspectUpload(object.body, object.mimeType)).resolves.toEqual({
      width: 2,
      height: 3,
      animated: false,
    });
  });

  it("refuses a processed image that exceeds the upload size limit", async () => {
    const maxUploadBytes = PNG.length + 10;
    const processUploadImageFn = vi.fn(async () => ({
      buffer: Buffer.alloc(maxUploadBytes + 1),
      mimeType: "image/webp",
    }));
    const instance = handler({
      upload: validUpload({
        fields: { ...validUpload().fields, imageProcessing: "webp" },
      }),
      maxUploadBytes,
      processUploadImageFn,
    });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toMatch(/processed file exceeds/i);
    expect(instance.storage.objects.size).toBe(0);
  });

  it("returns the existing asset for duplicate bytes and removes only the new staging object", async () => {
    const storage = memoryStorage();
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(201);

    const second = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
    });
    const duplicate = await invoke(second.run);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toEqual({
      error: "This file is already in the media library",
      duplicateAssetId: "asset-one",
    });
    expect(storage.objects.has("cms-media-staging/attempt-two")).toBe(false);
    expect(await documents("media_assets")).toHaveLength(1);
  });

  it.each([1, 2])("allows upload of A after %i replacements while retaining its receipt", async (count) => {
    const storage = memoryStorage();
    const original = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(original.run)).statusCode).toBe(201);
    const contentHash = createHash("sha256").update(PNG).digest("hex");
    const ownerRef = db.doc(`system/media/hashOwners/${contentHash}`);
    let successorHash;
    for (let index = 0; index < count; index += 1) {
      const buffer = await sharp({
        create: { width: 2 + index, height: 2, channels: 3, background: "red" },
      }).png().toBuffer();
      successorHash = createHash("sha256").update(buffer).digest("hex");
      const run = replacement.createCmsReplaceMediaBinaryHandler({
        firestore: db,
        requirePrincipalFn: async () => actor(),
        parseUploadFn: async () => ({
          originalName: "replacement.png", mimeType: "image/png", buffer,
          fields: { assetId: "asset-one" },
        }),
        storageFactory: () => storage,
        mintId: () => `replace-attempt-${index}`,
        now: () => new Date("2026-08-14T12:00:00.000Z"),
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        publicOrigin: "https://media.njpbs.org",
        log: { error: vi.fn(), warn: vi.fn() },
      });
      const res = makeRes();
      await run({
        method: "POST", rawBody: buffer,
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "if-match": mediaLibrary.formatMediaEtag("asset-one", index + 1),
        },
      }, res);
      expect(res.statusCode).toBe(200);
    }
    const receipt = (await ownerRef.get()).data();
    const reupload = handler({ storage, mintId: ids("asset-two", "attempt-two") });
    const response = await invoke(reupload.run);

    expect(response.statusCode).toBe(201);
    expect(response.body.asset).toMatchObject({ id: "asset-two" });
    expect((await db.doc("media_assets/asset-one").get()).data().contentHash).toBe(successorHash);
    expect((await ownerRef.get()).data()).toMatchObject({
      state: "committed", assetId: "asset-two",
    });
    expect((await ownerRef.collection("superseded").doc("attempt-one").get()).data())
      .toEqual(receipt);
  });

  it("denies a caller with no upload capability every category but the profile one", async () => {
    // An approved contributor can parse a profile-sized upload but cannot use
    // that scope to add an image to another library category.
    await db.collection("users").doc("editor-1").set({ active: true, grants: [{ role: "contributor" }] });
    const parseUploadFn = vi.fn(async () => validUpload());
    const storageFactory = vi.fn(() => memoryStorage());
    const run = createCmsUploadMediaHandler({
      firestore: db,
      requirePrincipalFn: async () => actor([{ role: "contributor" }]),
      parseUploadFn,
      storageFactory,
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      publicOrigin: "https://media.njpbs.org",
    });
    const res = await invoke(run);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: media.FORBIDDEN_MESSAGE });
    expect(parseUploadFn).toHaveBeenCalledWith(
      expect.anything(),
      AUTHOR_PHOTO_MAX_BYTES,
    );
    expect(storageFactory).not.toHaveBeenCalled();
  });

  it("checks billing after authorization and before parsing or storage creation", async () => {
    const events = [];
    const parseUploadFn = vi.fn(async () => {
      events.push("parse");
      return validUpload();
    });
    const storageFactory = vi.fn(() => {
      events.push("storage");
      return memoryStorage();
    });
    const assertBillingEnabledFn = vi.fn(async () => {
      events.push("billing");
      throw Object.assign(
        new Error("billing is disabled: budget threshold reached"),
        {
          code: "failed-precondition",
        },
      );
    });
    const run = createCmsUploadMediaHandler({
      firestore: db,
      requirePrincipalFn: async () => {
        events.push("authorize");
        return actor();
      },
      assertBillingEnabledFn,
      parseUploadFn,
      storageFactory,
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
      publicOrigin: "https://media.njpbs.org",
    });
    const res = await invoke(run);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "billing is disabled: budget threshold reached",
    });
    expect(events).toEqual(["authorize", "billing"]);
    expect(assertBillingEnabledFn).toHaveBeenCalledWith(db);
    expect(parseUploadFn).not.toHaveBeenCalled();
    expect(storageFactory).not.toHaveBeenCalled();
  });

  it.each([
    { name: "staff without upload rights", role: "staff", account: null, error: media.FORBIDDEN_MESSAGE },
    { name: "unapproved contributor", role: "contributor", account: null, error: media.PROFILE_PHOTO_FORBIDDEN_MESSAGE },
    { name: "deactivated contributor", role: "contributor", account: { active: false }, error: media.PROFILE_PHOTO_FORBIDDEN_MESSAGE },
  ])("refuses $name before malformed or oversized body validation", async ({ role, account, error }) => {
    if (account) await db.collection("users").doc("editor-1").set(account);
    const run = createCmsUploadMediaHandler({
      firestore: db,
      requirePrincipalFn: async () => actor([{ role }]),
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    });
    const res = makeRes();
    await run({
      method: "POST", rawBody: PNG,
      headers: { "content-type": "application/octet-stream", "content-length": String(DEFAULT_MAX_UPLOAD_BYTES + 1024 * 1024) },
    }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error });
    expect(await documents("media_assets")).toEqual([]);
    expect(await documents("cmsMediaUploadReservations")).toEqual([]);
  });

  it.each(["general", "staff-profile"])("lets a Watch Editor upload in %s while denying a Viewer", async (category) => {
    // Staff portraits retain their existing 400px minimum on both dimensions.
    const buffer = await sharp({ create: { width: 500, height: 500, channels: 3, background: "blue" } }).png().toBuffer();
    const upload = validUpload({ buffer, fields: { ...validUpload().fields, category, categories: [category] } });
    const viewer = handler({ principal: actor([{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }]), upload });
    expect((await invoke(viewer.run)).statusCode).toBe(403);
    expect(viewer.storage.objects.size).toBe(0);
    const instance = handler({ principal: actor([{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }]), upload });
    const res = await invoke(instance.run);
    expect(res.statusCode).toBe(201);
    expect(res.body.asset.category).toBe(category);
    expect(instance.storage.objects.size).toBeGreaterThan(0);
  });

  it("leaves the exact reservation and staging object for recovery after an R2 final-write failure", async () => {
    const storage = memoryStorage({ failFinal: true });
    const instance = handler({ storage });
    const res = await invoke(instance.run);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: "The upload needs recovery before it can be retried",
      retryable: true,
      attemptId: "attempt-one",
    });
    expect(storage.objects.has("cms-media-staging/attempt-one")).toBe(true);
    const owners = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(owners.docs[0].data()).toMatchObject({
      state: "reserved",
      attemptId: "attempt-one",
      category: "news",
      stagingKey: "cms-media-staging/attempt-one",
    });
    expect(await documents("media_assets")).toHaveLength(0);
  });

  it("never resumes an expired replacement owner as an upload", async () => {
    const contentHash = createHash("sha256").update(PNG).digest("hex");
    const replacementOwner = {
      operation: "replacement",
      state: "reserved",
      assetId: "asset-existing",
      attemptId: "replacement-attempt",
      contentHash,
      category: "news",
      baseVersion: 2,
      before: { version: 2 },
      finalKey: `cms-media/news/asset-existing/${contentHash}.png`,
      publicUrl:
        `https://media.njpbs.org/cms-media/news/asset-existing/${contentHash}.png`,
      stagingKey: "cms-media-staging/replacement-attempt",
      mimeType: "image/png",
      sizeBytes: PNG.length,
      recordSeed: {
        originalName: "studio.png",
        dimensions: { width: 1, height: 1 },
        actor: { uid: "editor-1", email: "editor@example.org" },
        source: "203.0.113.7",
      },
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
      leaseExpiresAt: "2026-08-13T12:15:00.000Z",
    };
    const ownerRef = db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc(contentHash);
    await ownerRef.set(replacementOwner);
    const storage = memoryStorage();
    const instance = handler({
      storage,
      mintId: ids("asset-new", "upload-attempt"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });

    const response = await invoke(instance.run);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: "A media replacement claim cannot be resumed as an upload",
    });
    expect((await ownerRef.get()).data()).toEqual(replacementOwner);
    expect(storage.objects.size).toBe(0);
    expect(await documents("media_assets")).toHaveLength(0);
    expect(await documents("admin_logs")).toHaveLength(0);
  });

  it("resumes the exact expired claim instead of permanently blocking the file hash", async () => {
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailFinal(false);
    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);
    expect(recovered.statusCode).toBe(201);
    expect(recovered.body.asset).toMatchObject({
      id: "asset-one",
      lifecycle: "active",
    });
    expect(recovered.body.asset).not.toHaveProperty("storageKey");
    expect(storage.objects.has("cms-media-staging/attempt-one")).toBe(false);
    expect(storage.objects.has("cms-media-staging/attempt-two")).toBe(false);
    const owner = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc((await documents("media_assets"))[0].contentHash)
      .get();
    expect(owner.data()).toMatchObject({
      state: "committed",
      attemptId: "attempt-one",
      assetId: "asset-one",
      recoveryCount: 1,
    });
    expect(await documents("media_assets")).toHaveLength(1);
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        action: "media.upload",
        target: "media_assets/asset-one",
      }),
    ]);
  });

  it("keeps the original metadata and actor when an expired claim is recovered", async () => {
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailFinal(false);
    const retryActor = {
      uid: "editor-2",
      email: "fixture-e396eca9ea@example.org",
      principal: { id: "editor-2", grants: [{ role: "editor" }] },
    };
    const retry = handler({
      upload: validUpload({
        originalName: "replacement.png",
        fields: {
          ...validUpload().fields,
          name: "Replacement name",
          description: "Replacement description",
          altText: "Replacement alt text",
          license: "Replacement license",
          credit: "Replacement credit",
          tags: "replacement",
        },
      }),
      principal: retryActor,
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);

    expect(recovered.statusCode).toBe(201);
    expect(recovered.body.asset).toMatchObject({
      id: "asset-one",
      name: "Studio control room",
      originalName: "studio.png",
      description: "The NJ PBS studio control room.",
      altText: "Monitors in the NJ PBS control room",
      license: "NJ PBS owned",
      credit: "NJ PBS",
      tags: ["studio", "newsroom"],
      createdBy: "editor-1",
      updatedBy: "editor-1",
    });
    expect(await documents("admin_logs")).toEqual([
      expect.objectContaining({
        actorUid: "editor-1",
        actorEmail: "editor@example.org",
      }),
    ]);
  });

  it("keeps a live claim exclusive and removes only the retry's staging object", async () => {
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailFinal(false);
    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:14:00.000Z"),
    });
    const blocked = await invoke(retry.run);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toEqual({
      error:
        "An upload of this file is already being recovered. Try again later.",
      retryable: true,
    });
    expect(storage.objects.has("cms-media-staging/attempt-one")).toBe(true);
    expect(storage.objects.has("cms-media-staging/attempt-two")).toBe(false);
    expect(await documents("media_assets")).toHaveLength(0);
  });

  it("resumes an expired object_ready claim and confirms the existing final object", async () => {
    const contentHash = createHash("sha256").update(PNG).digest("hex");
    const thumbnailKey = `cms-media/news/asset-one/thumbs/${contentHash}-w1.webp`;
    const storage = memoryStorage();
    const failCommit = vi.fn(async () => {
      throw new Error("Firestore commit response failed");
    });
    const first = handler({
      storage,
      mintId: ids("asset-one", "attempt-one"),
      commitUploadFn: failCommit,
    });
    expect((await invoke(first.run)).statusCode).toBe(503);
    expect(failCommit).toHaveBeenCalledOnce();
    const beforeRetry = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(beforeRetry.docs[0].data()).toMatchObject({
      state: "object_ready",
      attemptId: "attempt-one",
    });
    expect([...storage.objects.keys()]).toEqual([
      "cms-media-staging/attempt-one",
      expect.stringMatching(/^cms-media\/news\/asset-one\/[a-f0-9]{64}\.png$/),
    ]);

    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);
    expect(recovered.statusCode).toBe(201);
    expect(recovered.body.asset.id).toBe("asset-one");
    expect([...storage.objects.keys()]).toEqual([
      `cms-media/news/asset-one/${contentHash}.png`,
      thumbnailKey,
    ]);
    const privateRows = await documents("media_assets");
    expect(privateRows).toHaveLength(1);
    expect(privateRows[0].thumbnailStatus).toBe("ready");
    expect(privateRows[0].thumbnails).toEqual([{
      storageKey: thumbnailKey,
      url: `https://media.njpbs.org/${thumbnailKey}`,
      width: 1,
      height: 1,
    }]);
  });

  it("resumes an expired capacity-cleanup claim after an interrupted cleanup", async () => {
    const storage = memoryStorage();
    const failCommit = vi.fn(async () => {
      throw new Error("Firestore commit response failed");
    });
    const first = handler({
      storage,
      mintId: ids("asset-one", "attempt-one"),
      commitUploadFn: failCommit,
    });
    expect((await invoke(first.run)).statusCode).toBe(503);
    const owners = db
      .collection("system")
      .doc("media")
      .collection("hashOwners");
    const owner = (await owners.get()).docs[0];
    await owner.ref.update({
      state: "capacity_cleanup",
      capacityCleanupAt: "2026-08-13T12:00:00.000Z",
    });

    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);

    expect(recovered.statusCode).toBe(201);
    expect(recovered.body.asset.id).toBe("asset-one");
    expect((await owner.ref.get()).data()).toMatchObject({
      state: "committed",
      capacityCleanupAt: null,
      recoveryCount: 1,
    });
  });

  it("refuses an expired claim through a different authorized category", async () => {
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailFinal(false);
    const retry = handler({
      upload: validUpload({
        fields: {
          ...validUpload().fields,
          category: "arts",
          categories: ["arts"],
        },
      }),
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const blocked = await invoke(retry.run);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error).toBe(
      "The pending upload uses different file metadata and cannot be resumed",
    );
    expect(storage.objects.has("cms-media-staging/attempt-one")).toBe(true);
    expect(storage.objects.has("cms-media-staging/attempt-two")).toBe(false);
    expect(await documents("media_assets")).toHaveLength(0);
  });

  it("serializes two expired-lease retries and commits the original claim once", async () => {
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailFinal(false);
    const retryA = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const retryB = handler({
      storage,
      mintId: ids("asset-three", "attempt-three"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const responses = await Promise.all([
      invoke(retryA.run),
      invoke(retryB.run),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const success = responses.find((response) => response.statusCode === 201);
    expect(success.body.asset.id).toBe("asset-one");
    expect(await documents("media_assets")).toHaveLength(1);
    expect(await documents("media_assets_public")).toHaveLength(1);
    expect(await documents("admin_logs")).toHaveLength(1);
    expect(storage.objects.has("cms-media-staging/attempt-one")).toBe(false);
    expect(storage.objects.has("cms-media-staging/attempt-two")).toBe(false);
    expect(storage.objects.has("cms-media-staging/attempt-three")).toBe(false);
  });

  async function seedActiveAssets(count) {
    const batch = db.batch();
    for (let index = 0; index < count; index += 1) {
      batch.set(db.collection("media_assets").doc(`seed-${index}`), {
        lifecycle: "active",
      });
    }
    await batch.commit();
  }

  async function seedActiveAssetsInChunks(count) {
    const commits = [];
    for (let start = 0; start < count; start += 500) {
      const batch = db.batch();
      for (let index = start; index < Math.min(start + 500, count); index++) {
        batch.set(db.collection("media_assets").doc(`seed-${index}`), {
          lifecycle: "active",
        });
      }
      commits.push(batch.commit());
    }
    await Promise.all(commits);
  }

  async function distinctPng(shade) {
    return sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: shade, g: shade, b: shade },
      },
    })
      .png()
      .toBuffer();
  }

  it("refuses the upload that would create the 501st active asset", async () => {
    await seedActiveAssets(500);
    const instance = handler();
    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(507);
    expect(res.body).toEqual({
      error: "The media library has reached its active media limit",
    });
    expect(await documents("media_assets")).toHaveLength(500);
    expect(await documents("media_assets_public")).toHaveLength(0);
    expect(instance.storage.objects.size).toBe(0);
    const owners = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(owners.empty).toBe(true);
  });

  it("admits the 501st active asset only after indexed discovery is ready", async () => {
    await Promise.all([
      seedActiveAssets(500),
      db.doc("system/mediaDiscovery").set({
        schema: 1,
        state: "ready",
        revision: 1,
        sourceSha: "a".repeat(40),
      }),
    ]);
    const instance = handler();

    const response = await invoke(instance.run);

    expect(response.statusCode).toBe(201);
    expect((await db.collection("media_assets").doc("asset-one").get()).exists)
      .toBe(true);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      schema: 1,
      state: "ready",
      revision: 2,
    });
  });

  it("serializes media admission ledger allocation at the last global slot", async () => {
    await seedActiveAssets(499);
    await db.doc("system/mediaDiscovery").set({ admission: { schema: 1, activeCount: 499, revision: 0 } });
    const first = handler({ upload: validUpload({ buffer: await distinctPng(31) }), mintId: ids("slot-a", "attempt-a") });
    const second = handler({ upload: validUpload({ buffer: await distinctPng(32) }), mintId: ids("slot-b", "attempt-b") });
    const clock = vi.spyOn(firestoreBackoff, "delayExecution").mockImplementation(callback => { queueMicrotask(callback); });
    let responses;
    try { responses = await Promise.all([invoke(first.run), invoke(second.run)]); }
    finally { clock.mockRestore(); }
    expect(responses.map(res => res.statusCode).sort()).toEqual([201, 507]);
    expect((await db.collection("media_assets").where("lifecycle", "==", "active").get()).size).toBe(500);
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(500);
    const winner = responses.findIndex(res => res.statusCode === 201);
    const retry = handler({ upload: validUpload({ buffer: await distinctPng(winner === 0 ? 31 : 32) }), mintId: ids("retry", "retry-attempt") });
    const duplicate = await invoke(retry.run);
    expect(duplicate.statusCode).toBe(409);
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(500);
  });

  it.each([5000, 5001])("refuses the upload that would exceed the indexed 5,000-asset limit (%i existing)", async (count) => {
    await Promise.all([
      seedActiveAssetsInChunks(count),
      db.doc("system/mediaDiscovery").set({
        schema: 1,
        state: "ready",
        revision: 1,
        sourceSha: "a".repeat(40),
      }),
    ]);
    const instance = handler();

    const response = await invoke(instance.run);

    expect(response.statusCode).toBe(507);
    expect(response.body).toEqual({
      error: "The media library has reached its active media limit",
    });
    expect((await db.collection("media_assets").doc("asset-one").get()).exists)
      .toBe(false);
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({
      schema: 1,
      state: "ready",
      revision: 1,
    });
    expect(instance.storage.objects.size).toBe(0);
  });

  // The one destructive transport in the upload path: it removes a finished
  // object from the media store and drops its ownership claim, so it leaves an
  // audit row like every other server-owned removal (#205).
  it("audits the discard of the capacity-rejected object", async () => {
    await seedActiveAssets(500);
    const instance = handler();

    expect((await invoke(instance.run)).statusCode).toBe(507);

    const rows = await documents("admin_logs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUid: "editor-1",
      actorEmail: "editor@example.org",
      action: "media.upload.discard",
      target: "media_assets/asset-one",
      after: null,
    });
    expect(rows[0].before).toMatchObject({
      attemptId: "attempt-one",
      category: "news",
      mimeType: "image/png",
      storageKey: expect.stringMatching(/^cms-media\/news\/asset-one\//),
      reason: "active_media_capacity",
    });
    expect(typeof rows[0].at).toBe("string");
    // Keyed by the attempt, so a discard that is interrupted and finished
    // elsewhere cannot leave two rows for one destroyed object.
    expect(rows[0].id).toBe("media-discard_attempt-one");
  });

  it("keeps one discard receipt across an interrupted and resumed cleanup", async () => {
    await seedActiveAssets(500);
    const storage = memoryStorage({ failDeleteStaging: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });

    expect((await invoke(first.run)).statusCode).toBe(503);

    storage.setFailDeleteStaging(false);
    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    expect((await invoke(retry.run)).statusCode).toBe(507);

    const rows = await documents("admin_logs");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "media.upload.discard" });
  });

  it("keeps concurrent uploads from crossing the active asset cap", async () => {
    await seedActiveAssets(499);
    const storage = memoryStorage();
    const [first, second] = await Promise.all([
      distinctPng(10),
      distinctPng(200),
    ]);
    const runA = handler({
      storage,
      upload: validUpload({ buffer: first }),
      mintId: ids("asset-a", "attempt-a"),
    });
    const runB = handler({
      storage,
      upload: validUpload({ buffer: second }),
      mintId: ids("asset-b", "attempt-b"),
    });

    const responses = await Promise.all([invoke(runA.run), invoke(runB.run)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 507,
    ]);
    expect(await documents("media_assets")).toHaveLength(500);
    const storedKeys = [...storage.objects.keys()];
    expect(storedKeys).toHaveLength(2);
    const originalKey = storedKeys.find((key) => key.endsWith(".png"));
    expect(originalKey).toMatch(/^cms-media\/news\/asset-[ab]\/[a-f0-9]{64}\.png$/);
    expect(storedKeys).toContainEqual(
      expect.stringMatching(new RegExp(`^${originalKey.slice(0, originalKey.lastIndexOf("/"))}/thumbs/[a-f0-9]{64}-w2\\.webp$`)),
    );
    const owners = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(owners.size).toBe(1);
    expect(owners.docs[0].data().state).toBe("committed");
  });

  it("keeps capacity cleanup recoverable when the final object cannot be removed", async () => {
    await seedActiveAssets(500);
    const storage = memoryStorage({ failDeleteFinal: true });
    const instance = handler({ storage });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error:
        "The capacity-rejected upload needs recovery before it can be retried",
      retryable: true,
      attemptId: "attempt-one",
    });
    expect([...storage.objects.keys()]).toEqual([
      "cms-media-staging/attempt-one",
      expect.stringMatching(/^cms-media\/news\/asset-one\/[a-f0-9]{64}\.png$/),
    ]);
    const owners = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(owners.docs[0].data()).toMatchObject({
      state: "object_ready",
      attemptId: "attempt-one",
    });
  });

  it("rebuilds and removes the final object after partial capacity cleanup", async () => {
    await seedActiveAssets(500);
    const storage = memoryStorage({ failDeleteStaging: true });
    const first = handler({ storage, mintId: ids("asset-one", "attempt-one") });

    const interrupted = await invoke(first.run);

    expect(interrupted.statusCode).toBe(503);
    expect([...storage.objects.keys()]).toEqual([
      "cms-media-staging/attempt-one",
    ]);
    const owners = db
      .collection("system")
      .doc("media")
      .collection("hashOwners");
    expect((await owners.get()).docs[0].data()).toMatchObject({
      state: "object_ready",
      attemptId: "attempt-one",
    });

    storage.setFailDeleteStaging(false);
    const retry = handler({
      storage,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const refused = await invoke(retry.run);

    expect(refused.statusCode).toBe(507);
    expect([...storage.objects.keys()]).toEqual([]);
    expect((await owners.get()).empty).toBe(true);
  });

  it("does not delete a final object after the claim is committed", async () => {
    const ref = db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .doc("content-hash");
    await ref.set({ state: "committed", attemptId: "attempt-one" });
    const storage = memoryStorage();
    storage.deleteFinal = vi.fn(storage.deleteFinal);

    await expect(
      discardCapacityRejectedUpload({
        firestore: db,
        storage,
        ref,
        attemptId: "attempt-one",
        finalKey: "cms-media/news/asset-one/content-hash.png",
        stagingKeys: ["cms-media-staging/attempt-one"],
        nowIso: "2026-08-13T12:00:00.000Z",
        leaseExpiresAt: "2026-08-13T12:15:00.000Z",
      }),
    ).rejects.toThrow("changed before cleanup");
    expect(storage.deleteFinal).not.toHaveBeenCalled();
    expect((await ref.get()).data().state).toBe("committed");
  });

  it("does not discard an object after its recovery lease changes", async () => {
    const ref = db.collection("system").doc("media")
      .collection("hashOwners").doc("content-hash");
    await ref.set({ state: "object_ready", attemptId: "attempt-one",
      leaseExpiresAt: "2026-08-13T12:30:00.000Z" });
    const storage = memoryStorage();
    storage.deleteFinal = vi.fn(storage.deleteFinal);
    await expect(discardCapacityRejectedUpload({ firestore: db, storage, ref,
      attemptId: "attempt-one", finalKey: "cms-media/news/asset-one/content-hash.png",
      stagingKeys: [], nowIso: "2026-08-13T12:00:00.000Z",
      leaseExpiresAt: "2026-08-13T12:15:00.000Z" }))
      .rejects.toThrow("changed before cleanup");
    expect(storage.deleteFinal).not.toHaveBeenCalled();
    expect((await ref.get()).data().state).toBe("object_ready");
  });

  it("shows the duplicate asset id to a media holder across categories", async () => {
    const storage = memoryStorage();
    const owner = handler({ storage, mintId: ids("asset-one", "attempt-one") });
    expect((await invoke(owner.run)).statusCode).toBe(201);

    const outsider = handler({
      storage,
      principal: actor([{ role: "editor", sections: ["arts"], registeredMediaSections: ["arts"] }]),
      upload: validUpload({
        fields: {
          ...validUpload().fields,
          category: "arts",
          categories: ["arts"],
        },
      }),
      mintId: ids("asset-two", "attempt-two"),
    });
    const duplicate = await invoke(outsider.run);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toEqual({
      error: "This file is already in the media library",
      duplicateAssetId: "asset-one",
    });
    expect(await documents("media_assets")).toHaveLength(1);
  });
});

// -- the scoped profile-photo path --------------------------------------------
//
// A staff member owns their own byline, so they can add their own head shot
// without holding media.upload. The whole point of these is that the shortcut
// buys nothing else: one category, the ratified photo bounds, and an approved
// active account, all decided by the server.

describe("cmsUploadMedia masters", () => {
  async function creditedJpeg(background = "#113355") {
    return sharp({
      create: { width: 40, height: 20, channels: 3, background },
    })
      .withExif({ IFD0: { Artist: "Pat Photographer", ImageDescription: "A caption" } })
      .jpeg()
      .toBuffer();
  }

  function masterStore({ fail = false } = {}) {
    const objects = new Map();
    return {
      objects,
      async delete(key) { objects.delete(key); },
      async putIfAbsent({ key, body, mimeType, contentHash }) {
        if (fail) throw new Error("R2 connection failed");
        if (objects.has(key)) return { created: false };
        objects.set(key, { body, mimeType, contentHash });
        return { created: true };
      },
    };
  }

  function webpUpload(buffer, fields = {}) {
    return validUpload({
      originalName: "scene.jpg",
      mimeType: "image/jpeg",
      buffer,
      fields: { ...validUpload().fields, imageProcessing: "webp", ...fields },
    });
  }

  it("refuses a purging master lock before storing the original", async () => {
    const jpeg = await creditedJpeg();
    const hash = createHash("sha256").update(jpeg).digest("hex");
    await db.doc(`system/media/masterLocks/${hash}`).set({ state: "purging" });
    const putIfAbsent = vi.fn();
    const instance = handler({ upload: webpUpload(jpeg),
      masterStorageFactory: () => ({ putIfAbsent }) });
    const res = await invoke(instance.run);
    expect(res.statusCode).toBe(503);
    expect(res.body.retryable).toBe(true);
    expect(putIfAbsent).not.toHaveBeenCalled();
    expect((await db.collection("system/media/hashOwners").get()).empty).toBe(true);
  });

  it("reserves the original key before private storage and records readiness", async () => {
    const jpeg = await creditedJpeg();
    const hash = createHash("sha256").update(jpeg).digest("hex");
    const key = masterObjectKey({ contentHash: hash, mimeType: "image/jpeg" });
    const putIfAbsent = vi.fn(async () => {
      const claims = await db.collection("system/media/hashOwners").get();
      expect(claims.size).toBe(1);
      expect(claims.docs[0].data()).toMatchObject({ state: "reserved",
        recordSeed: { master: { key, contentHash: hash, retained: false, reason: "pending" } } });
    });
    const instance = handler({ upload: webpUpload(jpeg),
      masterStorageFactory: () => ({ putIfAbsent }) });
    expect((await invoke(instance.run)).statusCode).toBe(201);
    expect(putIfAbsent).toHaveBeenCalledOnce();
    const claims = await db.collection("system/media/hashOwners").get();
    expect(claims.docs[0].data().recordSeed.master).toMatchObject({ key, retained: true });
  });

  it("preserves reserved staging when recording the master result fails", async () => {
    const jpeg = await creditedJpeg();
    const storage = memoryStorage();
    const putIfAbsent = vi.fn(async () => {
      vi.spyOn(db, "runTransaction").mockRejectedValueOnce(new Error("Master result unavailable"));
    });
    try {
      const first = handler({ upload: webpUpload(jpeg), storage,
        masterStorageFactory: () => ({ putIfAbsent }) });
      expect((await invoke(first.run)).statusCode).toBe(503);
      const pending = (await db.collection("system/media/hashOwners").get()).docs[0];
      expect(pending.data()).toMatchObject({ state: "reserved",
        recordSeed: { master: { retained: false, reason: "pending" } } });
      expect(storage.objects.has(pending.data().stagingKey)).toBe(true);
      expect(await documents("media_assets")).toEqual([]);
      const retry = handler({ upload: webpUpload(jpeg), storage,
        masterStorageFactory: () => masterStore(),
        mintId: ids("asset-two", "attempt-two"),
        now: () => new Date("2026-08-13T12:16:00.000Z") });
      expect((await invoke(retry.run)).statusCode).toBe(201);
      expect((await documents("media_assets"))[0].master.retained).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rechecks the master lock when Firestore retries an aborted reservation", async () => {
    const jpeg = await creditedJpeg();
    const hash = createHash("sha256").update(jpeg).digest("hex");
    const lock = db.doc(`system/media/masterLocks/${hash}`);
    const original = db.runTransaction.bind(db);
    let attempts = 0;
    let readLock = false;
    vi.spyOn(db, "runTransaction").mockImplementationOnce((callback) => original(async (transaction) => {
      attempts += 1;
      // The first transaction has released its read locks before this retry.
      if (attempts === 2) await lock.set({ state: "purging" });
      const get = transaction.get.bind(transaction);
      transaction.get = async (ref) => {
        const snapshot = await get(ref);
        if (ref.path === lock.path) readLock = true;
        return snapshot;
      };
      const set = transaction.set.bind(transaction);
      transaction.set = (...args) => {
        if (attempts === 1) {
          expect(readLock).toBe(true);
          // ABORTED is the SDK's retryable transaction-conflict status.
          throw Object.assign(new Error("Reservation conflict"), { code: 10 });
        }
        return set(...args);
      };
      return callback(transaction);
    }));
    const putIfAbsent = vi.fn();
    try {
      const response = await invoke(handler({ upload: webpUpload(jpeg),
        masterStorageFactory: () => ({ putIfAbsent }) }).run);
      expect(response.statusCode).toBe(503);
      expect(response.body.retryable).toBe(true);
      expect(attempts).toBe(2);
      expect(putIfAbsent).not.toHaveBeenCalled();
      expect((await db.collection("system/media/hashOwners").get()).empty).toBe(true);
      expect((await lock.get()).data()).toEqual({ state: "purging" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses a different original with the same optimized bytes during recovery", async () => {
    const jpeg = await creditedJpeg();
    const different = await sharp(jpeg).withMetadata({ density: 144 }).jpeg().toBuffer();
    expect(different).not.toEqual(jpeg);
    const processed = await processUploadImage(jpeg, "image/jpeg", "webp", { width: 40, height: 20 });
    // Fix the optimized output to isolate original identity from conversion details.
    const processUploadImageFn = async () => processed;
    const storage = memoryStorage({ failFinal: true });
    const first = handler({ upload: webpUpload(jpeg), storage, processUploadImageFn,
      masterStorageFactory: () => masterStore() });
    expect((await invoke(first.run)).statusCode).toBe(503);
    const pending = (await db.collection("system/media/hashOwners").get()).docs[0];
    const before = pending.data();
    const masterStorageFactory = vi.fn(() => masterStore());
    storage.setFailFinal(false);
    const refused = await invoke(handler({ upload: webpUpload(different), storage,
      processUploadImageFn, masterStorageFactory, mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z") }).run);
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toContain("different original");
    expect((await pending.ref.get()).data()).toEqual(before);
    expect(masterStorageFactory).not.toHaveBeenCalled();
    expect(await documents("media_assets")).toEqual([]);
  });

  it("keeps the original privately and records it beside the web copy", async () => {
    const jpeg = await creditedJpeg();
    const masters = masterStore();
    const instance = handler({
      upload: webpUpload(jpeg),
      masterStorageFactory: () => masters,
    });

    const res = await invoke(instance.run);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).not.toHaveProperty("master");
    const contentHash = createHash("sha256").update(jpeg).digest("hex");
    const key = masterObjectKey({ contentHash, mimeType: "image/jpeg" });
    expect(key).toBe(`masters/${contentHash.slice(0, 2)}/${contentHash}.jpg`);
    expect(masters.objects.get(key)).toMatchObject({ body: jpeg, mimeType: "image/jpeg" });
    const [record] = await documents("media_assets");
    expect(record.master).toEqual({
      retained: true,
      key,
      contentHash,
      mimeType: "image/jpeg",
      sizeBytes: jpeg.length,
      width: 40,
      height: 20,
    });
    expect(record.mimeType).toBe("image/webp");
    expect(JSON.stringify(await documents("media_assets_public"))).not.toContain(key);
  });

  it("publishes the web copy and flags the master when the private store is missing or fails", async () => {
    const jpeg = await creditedJpeg();
    const missing = handler({ upload: webpUpload(jpeg) });
    expect((await invoke(missing.run)).statusCode).toBe(201);
    expect((await documents("media_assets"))[0].master).toMatchObject({
      retained: false,
      reason: "not-configured",
    });

    const other = await sharp(jpeg).jpeg({ quality: 70 }).toBuffer();
    const failing = handler({
      upload: webpUpload(other),
      mintId: ids("asset-two", "attempt-two"),
      masterStorageFactory: () => masterStore({ fail: true }),
    });
    expect((await invoke(failing.run)).statusCode).toBe(201);
    const failed = (await documents("media_assets")).find((row) => row.id === "asset-two");
    expect(failed.master).toMatchObject({
      retained: false,
      reason: "store-failed",
    });
    expect(failing.log.warn).toHaveBeenCalledWith(
      "cmsUploadMedia master was not kept",
      expect.any(Object),
    );
  });

  it.each(["not-configured", "store-failed"])("recovers an original after %s on the first attempt", async (reason) => {
    const jpeg = await creditedJpeg();
    const storage = memoryStorage({ failFinal: true });
    const first = handler({
      upload: webpUpload(jpeg),
      storage,
      masterStorageFactory: () => reason === "not-configured" ? null : masterStore({ fail: true }),
    });
    expect((await invoke(first.run)).statusCode).toBe(503);
    const pending = await db.collection("system").doc("media").collection("hashOwners").get();
    expect(pending.docs[0].data().recordSeed.master).toMatchObject({
      retained: false,
      reason,
    });

    const masters = masterStore();
    storage.setFailFinal(false);
    const retry = handler({
      upload: webpUpload(jpeg),
      storage,
      masterStorageFactory: () => masters,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);

    expect(recovered.statusCode).toBe(201);
    const contentHash = createHash("sha256").update(jpeg).digest("hex");
    const key = masterObjectKey({ contentHash, mimeType: "image/jpeg" });
    expect(masters.objects.get(key)).toMatchObject({ body: jpeg, mimeType: "image/jpeg" });
    const [record] = await documents("media_assets");
    expect(record.id).toBe("asset-one");
    expect(record.master).toMatchObject({ retained: true, key, contentHash, mimeType: "image/jpeg" });
    expect(JSON.stringify(await documents("media_assets_public"))).not.toContain(key);
  });

  it.each(["reserved", "object_ready", "capacity_cleanup"])("keeps a stored master when a %s claim resumes", async (state) => {
    const jpeg = await creditedJpeg("#224466");
    const storage = memoryStorage({ failFinal: true });
    const masters = masterStore();
    const first = handler({
      upload: webpUpload(jpeg),
      storage,
      masterStorageFactory: () => masters,
    });
    expect((await invoke(first.run)).statusCode).toBe(503);

    const pending = (await db.collection("system/media/hashOwners").get()).docs[0];
    await pending.ref.update({ state });
    const masterStorageFactory = vi.fn(() => null);
    storage.setFailFinal(false);
    const retry = handler({
      upload: webpUpload(jpeg),
      storage,
      masterStorageFactory,
      mintId: ids("asset-two", "attempt-two"),
      now: () => new Date("2026-08-13T12:16:00.000Z"),
    });
    const recovered = await invoke(retry.run);

    expect(recovered.statusCode).toBe(201);
    expect(masterStorageFactory).not.toHaveBeenCalled();
    const contentHash = createHash("sha256").update(jpeg).digest("hex");
    const key = masterObjectKey({ contentHash, mimeType: "image/jpeg" });
    expect(masters.objects.has(key)).toBe(true);
    expect((await documents("media_assets"))[0].master).toMatchObject({
      retained: true,
      key,
      contentHash,
    });
  });

  it("stores no master when the original is published as is", async () => {
    const masterStorageFactory = vi.fn(() => masterStore());
    const instance = handler({ masterStorageFactory });

    expect((await invoke(instance.run)).statusCode).toBe(201);
    expect(masterStorageFactory).not.toHaveBeenCalled();
    expect((await documents("media_assets"))[0]).not.toHaveProperty("master");
  });

  it("fills an empty credit and description from the photo, and form values win", async () => {
    const jpeg = await creditedJpeg();
    const empty = handler({
      upload: webpUpload(jpeg, { credit: "", description: "" }),
    });
    expect((await invoke(empty.run)).body.asset).toMatchObject({
      credit: "Pat Photographer",
      description: "A caption",
    });

    const typed = await creditedJpeg("#553311");
    const kept = handler({
      upload: webpUpload(typed),
      mintId: ids("asset-two", "attempt-two"),
    });
    expect((await invoke(kept.run)).body.asset).toMatchObject({
      credit: "NJ PBS",
      description: "The NJ PBS studio control room.",
    });
  });
});

describe("profile photo uploads", () => {
  const CONTRIBUTOR = {
    uid: "contributor-1",
    email: "contributor@example.org",
    principal: { id: "contributor-1", grants: [{ role: "contributor" }] },
  };

  /** A real 500x500 JPEG, so the dimension check runs on decoded pixels. */
  async function headshot(size = 500) {
    return sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    })
      .jpeg()
      .toBuffer();
  }

  async function profileUpload(overrides = {}) {
    const buffer = overrides.buffer ?? (await headshot());
    return {
      originalName: "headshot.jpg",
      mimeType: "image/jpeg",
      buffer,
      fields: {
        name: "Profile photo: Sasha Mercer",
        category: "staff-profile",
        altText: "Sasha Mercer",
        license: "Profile photo: supplied by the staff member, cleared for use",
        ...overrides.fields,
      },
    };
  }

  async function seedAccount(uid, fields = {}) {
    await db
      .collection("users")
      .doc(uid)
      .set({ email: `${uid}@example.org`, active: true, grants: [], ...fields });
  }

  function run({
    upload,
    firestore = db,
    principal = CONTRIBUTOR,
    storage = memoryStorage(),
    inspectUploadFn,
    mintId = ids("photo-asset", "photo-attempt"),
    now = () => new Date("2026-08-21T18:00:00.000Z"),
  }) {
    return {
      storage,
      handler: createCmsUploadMediaHandler({
        firestore,
        requirePrincipalFn: async () => principal,
        parseUploadFn: async () => upload,
        storageFactory: () => storage,
        mintId,
        now,
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        publicOrigin: "https://media.njpbs.org",
        ...(inspectUploadFn ? { inspectUploadFn } : {}),
        log: { error: vi.fn(), warn: vi.fn() },
      }),
    };
  }

  it("lets an approved contributor upload into the profile category only", async () => {
    await seedAccount("contributor-1");
    const instance = run({ upload: await profileUpload() });
    const res = await invoke(instance.handler);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({
      id: "photo-asset",
      category: "staff-profile",
      width: 500,
      height: 500,
    });
    // The ordinary media record, through the ordinary boundary: the same
    // immutable key, the same content-hash claim, the same audit row.
    const record = (await db.collection("media_assets").doc("photo-asset").get()).data();
    expect(record.storageKey).toMatch(/^cms-media\/staff-profile\/photo-asset\//);
    expect(record.createdBy).toBe("contributor-1");
    const claims = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(claims.docs.map((doc) => doc.data().state)).toEqual(["committed"]);
    const logs = await db.collection("admin_logs").get();
    expect(logs.docs.map((doc) => doc.data().action)).toEqual(["media.upload"]);
  });

  it("limits active profile photos created through the scoped upload path", async () => {
    await seedAccount("contributor-1");
    const storage = memoryStorage();

    for (let index = 0; index < media.MAX_SCOPED_PROFILE_PHOTOS; index += 1) {
      const instance = run({
        upload: await profileUpload({ buffer: await headshot(500 + index) }),
        storage,
        mintId: ids(`photo-asset-${index}`, `photo-attempt-${index}`),
      });
      expect((await invoke(instance.handler)).statusCode).toBe(201);
    }

    const rejected = run({
      upload: await profileUpload({
        buffer: await headshot(500 + media.MAX_SCOPED_PROFILE_PHOTOS),
      }),
      storage,
      mintId: ids("photo-asset-rejected", "photo-attempt-rejected"),
    });
    const response = await invoke(rejected.handler);

    expect(response.statusCode).toBe(409);
    expect(response.body.error).toBe(
      `A staff member can keep at most ${media.MAX_SCOPED_PROFILE_PHOTOS} active profile photos`,
    );
    expect(await documents("media_assets")).toHaveLength(
      media.MAX_SCOPED_PROFILE_PHOTOS,
    );
    expect(await documents("media_assets_public")).toHaveLength(
      media.MAX_SCOPED_PROFILE_PHOTOS,
    );
    expect(storage.objects.has("cms-media-staging/photo-attempt-rejected")).toBe(
      false,
    );
    expect(
      (await db.collection("media_assets").doc("photo-asset-rejected").get())
        .exists,
    ).toBe(false);
    expect(
      [...storage.objects.keys()].some((key) =>
        key.includes("photo-asset-rejected"),
      ),
    ).toBe(false);
    const claims = await db
      .collection("system")
      .doc("media")
      .collection("hashOwners")
      .get();
    expect(claims.size).toBe(media.MAX_SCOPED_PROFILE_PHOTOS);
    expect(
      (
        await db
          .collection("admin_logs")
          .doc("media-discard_photo-attempt-rejected")
          .get()
      ).data(),
    ).toMatchObject({
      action: "media.upload.discard",
      before: { reason: "active_media_capacity" },
    });

    const editor = run({
      upload: await profileUpload({ buffer: await headshot(600) }),
      principal: actor(),
      storage,
      mintId: ids("editor-photo", "editor-attempt"),
    });
    expect((await invoke(editor.handler)).statusCode).toBe(201);
  });

  it("counts only the scoped uploader's active profile photos", async () => {
    await seedAccount("contributor-1");
    const batch = db.batch();
    for (let index = 0; index < media.MAX_SCOPED_PROFILE_PHOTOS; index += 1) {
      batch.set(db.collection("media_assets").doc(`other-${index}`), {
        category: "staff-profile",
        createdBy: "another-contributor",
        lifecycle: "active",
      });
      batch.set(db.collection("media_assets").doc(`old-${index}`), {
        category: "staff-profile",
        createdBy: "contributor-1",
        lifecycle: "tombstoned",
      });
    }
    await batch.commit();

    const instance = run({ upload: await profileUpload() });

    expect((await invoke(instance.handler)).statusCode).toBe(201);
  });

  it.each([
    ["profile", media.MAX_SCOPED_PROFILE_PHOTOS, CONTRIBUTOR, 409,
      `A staff member can keep at most ${media.MAX_SCOPED_PROFILE_PHOTOS} active profile photos`],
    ["library", media.MAX_ACTIVE_MEDIA_ASSETS, actor(), 507,
      "The media library has reached its active media limit"],
  ])("releases %s quota refusal locks before cleaning up the losing upload",
    async (_quota, limit, principal, status, error) => {
    await seedAccount("contributor-1");
    const batch = db.batch();
    for (let index = 0; index < limit; index += 1) {
      batch.set(db.collection("media_assets").doc(`winner-${index}`), {
        category: "staff-profile", createdBy: "contributor-1", lifecycle: "active",
      });
    }
    await batch.commit();

    // Hold rollback delivery at the network boundary. Conflicting requests while
    // its transaction still holds locks get the emulator's ABORTED lock error.
    // The real SDK and database handle all other requests without substitution.
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
    const upstream = connect(`http://${emulatorHost}`);
    const pendingRollbacks = [];
    const proxy = createServer();
    proxy.on("stream", async (stream, headers) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const forward = () => {
        const request = upstream.request({ ...headers,
          ":authority": emulatorHost });
        const response = [];
        let responseHeaders;
        let trailers;
        request.on("response", (value) => { responseHeaders = value; });
        request.on("trailers", (value) => { trailers = value; });
        request.on("data", (chunk) => response.push(chunk));
        request.on("end", () => {
          stream.respond(responseHeaders, { waitForTrailers: true });
          stream.on("wantTrailers", () => stream.sendTrailers(trailers));
          stream.end(Buffer.concat(response));
        });
        request.end(Buffer.concat(chunks));
      };
      if (headers[":path"].endsWith("/Rollback")) {
        pendingRollbacks.push(forward);
      } else if (pendingRollbacks.length) {
        stream.respond({ ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({
          "grpc-status": "10", "grpc-message": "Transaction lock timeout.",
        }));
        stream.end();
      } else {
        forward();
      }
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const { Firestore } = adminRequire("@google-cloud/firestore");
    process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${proxy.address().port}`;
    let isolatedDb;
    try {
      isolatedDb = new Firestore({ projectId: db.projectId });
    } finally {
      process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;
    }
    const storage = memoryStorage();
    const instance = run({ upload: await profileUpload(), firestore: isolatedDb, storage, principal });
    const clock = vi.spyOn(firestoreBackoff, "delayExecution")
      .mockImplementation((callback) => { queueMicrotask(callback); });
    let response;
    try {
      response = await invoke(instance.handler);
    } finally {
      clock.mockRestore();
      for (const forward of pendingRollbacks) forward();
      await isolatedDb.terminate();
      upstream.close();
      await new Promise((resolve) => proxy.close(resolve));
    }

    expect(response.statusCode, JSON.stringify(response.body)).toBe(status);
    expect(response.body.error).toBe(error);
    expect(await documents("media_assets")).toHaveLength(limit);
    expect(await documents("media_assets_public")).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    const owners = await db.collection("system").doc("media").collection("hashOwners").get();
    expect(owners.size).toBe(0);
    expect(await documents("admin_logs")).toMatchObject([{
      action: "media.upload.discard", before: { reason: "active_media_capacity" },
    }]);
  });

  it("serializes concurrent scoped uploads at the owner quota", async () => {
    await seedAccount("contributor-1");
    const batch = db.batch();
    for (
      let index = 0;
      index < media.MAX_SCOPED_PROFILE_PHOTOS - 1;
      index += 1
    ) {
      batch.set(db.collection("media_assets").doc(`existing-${index}`), {
        category: "staff-profile",
        createdBy: "contributor-1",
        lifecycle: "active",
      });
    }
    await batch.commit();
    const storage = memoryStorage();
    const first = run({
      upload: await profileUpload({ buffer: await headshot(700) }),
      storage,
      mintId: ids("concurrent-a", "concurrent-attempt-a"),
    });
    const second = run({
      upload: await profileUpload({ buffer: await headshot(701) }),
      storage,
      mintId: ids("concurrent-b", "concurrent-attempt-b"),
    });

    // Keep the SDK's contention scheduling: immediate microtasks can make
    // both uploads exhaust their attempts against the emulator's read locks.
    const responses = await Promise.all([
      invoke(first.handler),
      invoke(second.handler),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      201, 409,
    ]);
    const active = await db
      .collection("media_assets")
      .where("createdBy", "==", "contributor-1")
      .where("category", "==", "staff-profile")
      .where("lifecycle", "==", "active")
      .get();
    expect(active.size).toBe(media.MAX_SCOPED_PROFILE_PHOTOS);
  });

  it.each([
    ["an aborted commit when the quota fills", 10, true, 409],
    ["an HTTP-aborted commit when the quota fills", 409, true, 409],
    ["an aborted commit with capacity remaining", 10, false, 503],
    ["an unavailable service when the quota fills", 14, true, 503],
    ["a lost commit response after later uploads exceed the scoped quota", 10, true, 201, true],
  ])("handles %s after the SDK exhausts its attempts", async (_label, code, quotaFull, status, lostResponse = false) => {
    await seedAccount("contributor-1");
    const batch = db.batch();
    for (let index = 0; index < media.MAX_SCOPED_PROFILE_PHOTOS - 1; index += 1) {
      batch.set(db.collection("media_assets").doc(`existing-${index}`), {
        category: "staff-profile", createdBy: "contributor-1", lifecycle: "active",
      });
    }
    await batch.commit();

    const { Firestore } = adminRequire("@google-cloud/firestore");
    const isolatedDb = new Firestore({ projectId: db.projectId });
    const request = isolatedDb.request.bind(isolatedDb);
    const requestStream = isolatedDb.requestStream.bind(isolatedDb);
    let rejectCommitReads = false;
    let contentionStarted = false;
    let commitLanded = false;
    // Fault only the final transaction's initial network read, before it holds
    // locks. Reservation, object readiness, quota reads and cleanup use the
    // real emulator, and the SDK keeps its normal attempt limit.
    const unary = vi.spyOn(isolatedDb, "request").mockImplementation(async (method, body, ...rest) => {
      const result = await request(method, body, ...rest);
      if (method === "commit" && body.writes?.some((write) =>
        write.update?.fields?.state?.stringValue === "object_ready")) {
        rejectCommitReads = true;
      }
      if (lostResponse && method === "commit" && body.writes?.some((write) =>
        write.update?.name.endsWith("/media_assets/photo-asset"))) {
        commitLanded = true;
        // A media-capable uploader can exceed the scoped quota. The landed
        // photo sorts beyond the bounded quota result and still owns success.
        await db.collection("media_assets").doc("another-upload").set({
          category: "staff-profile", createdBy: "contributor-1", lifecycle: "active",
        });
        throw Object.assign(new Error("Commit response lost"), { code: 14 });
      }
      return result;
    });
    const streaming = vi.spyOn(isolatedDb, "requestStream").mockImplementation(async (method, bidirectional, body, ...rest) => {
      if (rejectCommitReads && method === "batchGetDocuments" && body.newTransaction &&
        (!lostResponse || commitLanded)) {
        if (!contentionStarted && quotaFull && !lostResponse) {
          await db.collection("media_assets").doc("concurrent-winner").set({
            category: "staff-profile", createdBy: "contributor-1", lifecycle: "active",
          });
        }
        contentionStarted = true;
        throw Object.assign(new Error(code === 14 ? "Service unavailable" : "Transaction lock timeout."), { code });
      }
      if (method === "runQuery" && !body.newTransaction && !body.transaction) {
        rejectCommitReads = false;
      }
      return requestStream(method, bidirectional, body, ...rest);
    });
    const instance = run({ upload: await profileUpload(), firestore: isolatedDb });
    // These transport failures acquire no read locks, so advancing this clock
    // cannot synchronize competing emulator transactions as in the race test.
    const clock = vi.spyOn(firestoreBackoff, "delayExecution")
      .mockImplementation((callback) => { queueMicrotask(callback); });
    let response;
    try {
      response = await invoke(instance.handler);
    } finally {
      clock.mockRestore();
      unary.mockRestore();
      streaming.mockRestore();
      await isolatedDb.terminate();
    }

    expect(contentionStarted).toBe(true);
    expect(response.statusCode, JSON.stringify(response.body)).toBe(status);
    expect((await db.collection("media_assets").doc("photo-asset").get()).exists).toBe(lostResponse);
    expect(await documents("media_assets")).toHaveLength(
      media.MAX_SCOPED_PROFILE_PHOTOS - (quotaFull ? 0 : 1) + (lostResponse ? 1 : 0),
    );
    const claims = await db.collection("system/media/hashOwners").get();
    if (status === 409) {
      expect(response.body.error).toBe(
        `A staff member can keep at most ${media.MAX_SCOPED_PROFILE_PHOTOS} active profile photos`,
      );
      expect(instance.storage.objects.size).toBe(0);
      expect(claims.empty).toBe(true);
      expect(await documents("admin_logs")).toMatchObject([{
        action: "media.upload.discard", before: { reason: "active_media_capacity" },
      }]);
    } else if (status === 503) {
      expect(response.body).toMatchObject({
        error: "The upload needs recovery before it can be retried", retryable: true,
      });
      expect(claims.docs.map((claim) => claim.data().state)).toEqual(["object_ready"]);
      expect(instance.storage.objects.size).toBeGreaterThan(0);
      expect(await documents("admin_logs")).toEqual([]);
    } else {
      expect(response.body.asset.id).toBe("photo-asset");
      expect(claims.docs.map((claim) => claim.data().state)).toEqual(["committed"]);
      expect(instance.storage.objects.size).toBeGreaterThan(0);
      expect(await documents("admin_logs")).toMatchObject([{ action: "media.upload" }]);
    }
  });

  it("refuses profile-photo uploads from guide-only staff", async () => {
    const staff = {
      uid: "staff-1",
      email: "staff@example.org",
      principal: { id: "staff-1", grants: [{ role: "staff" }] },
    };
    await seedAccount("staff-1", { grants: [{ role: "staff" }] });
    const instance = run({
      upload: await profileUpload(),
      principal: staff,
    });

    const res = await invoke(instance.handler);

    expect(res.statusCode).toBe(403);
    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it("keeps an oriented profile JPEG as the immutable original", async () => {
    await seedAccount("contributor-1");
    const oriented = await sharp({
      create: {
        width: 450,
        height: 500,
        channels: 3,
        background: { r: 20, g: 40, b: 80 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const instance = run({
      upload: await profileUpload({
        buffer: oriented,
      }),
    });

    const res = await invoke(instance.handler);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({
      mimeType: "image/jpeg",
      width: 500,
      height: 450,
    });
    const [object] = [...instance.storage.objects.values()];
    expect(object.body).toEqual(oriented);
    const metadata = await sharp(object.body).metadata();
    expect(metadata).toMatchObject({
      format: "jpeg",
      width: 450,
      height: 500,
      orientation: 6,
    });
  });

  it("accepts a valid profile photo above the WebP processing pixel cap", async () => {
    await seedAccount("contributor-1");
    const instance = run({
      upload: await profileUpload(),
      inspectUploadFn: vi.fn(async () => ({ width: 5_001, height: 5_001 })),
    });

    const res = await invoke(instance.handler);

    expect(res.statusCode).toBe(201);
    expect(res.body.asset).toMatchObject({ width: 5_001, height: 5_001 });
  });

  it("refuses destructive WebP processing for a profile photo", async () => {
    await seedAccount("contributor-1");
    const instance = run({
      upload: await profileUpload({ fields: { imageProcessing: "webp" } }),
    });

    const res = await invoke(instance.handler);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Profile photos must keep the original file");
    expect(instance.storage.objects.size).toBe(0);
  });

  it("refuses the same caller any other category", async () => {
    await seedAccount("contributor-1");
    for (const category of ["general", "news", "staff", "staff-profiles"]) {
      const instance = run({
        upload: await profileUpload({ fields: { category } }),
      });
      const res = await invoke(instance.handler);
      expect(res.statusCode).toBe(403);
      expect(instance.storage.objects.size).toBe(0);
    }
    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it("refuses an account that is not approved or has been deactivated", async () => {
    // No users document at all: a signed-in identity awaiting approval.
    const pending = run({ upload: await profileUpload() });
    expect((await invoke(pending.handler)).statusCode).toBe(403);

    await seedAccount("contributor-1", { active: false });
    const deactivated = run({ upload: await profileUpload() });
    const res = await invoke(deactivated.handler);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe(media.PROFILE_PHOTO_FORBIDDEN_MESSAGE);
  });

  it("enforces the ratified photo bounds on the bytes", async () => {
    await seedAccount("contributor-1");

    const small = run({ upload: await profileUpload({ buffer: await headshot(320) }) });
    const smallRes = await invoke(small.handler);
    expect(smallRes.statusCode).toBe(400);
    expect(smallRes.body.error).toMatch(/at least 400 by 400/);

    const animated = run({
      upload: {
        ...(await profileUpload()),
        mimeType: "image/gif",
        originalName: "wave.gif",
      },
    });
    expect((await invoke(animated.handler)).statusCode).toBe(415);

    expect((await db.collection("media_assets").get()).empty).toBe(true);
  });

  it("accepts a profile photo with any license text", async () => {
    // The rights basis is confirmed on the profile that uses the photo, so the
    // library license does not block the upload.
    await seedAccount("contributor-1");
    const instance = run({
      upload: await profileUpload({ fields: { license: "NJ PBS owned" } }),
    });
    const res = await invoke(instance.handler);
    expect(res.statusCode).toBe(201);
    expect(res.body.asset.license).toBe("NJ PBS owned");
  });

  it("still lets an editor with the capability upload a profile photo", async () => {
    await seedAccount("editor-1", { grants: [{ role: "editor" }] });
    const instance = run({
      upload: await profileUpload(),
      principal: actor(),
    });
    expect((await invoke(instance.handler)).statusCode).toBe(201);
  });

  it("hands a scoped uploader back their own asset id after a lost response", async () => {
    // The retry a contributor is most likely to make. The first upload committed
    // the bytes and the response never arrived, so they press Upload again and
    // the hash owner is already committed. Deciding disclosure on capability
    // alone answered with a null id -- and a contributor cannot browse the media
    // library, so their own head shot was unreachable and unattachable.
    await seedAccount("contributor-1");
    const storage = memoryStorage();
    const first = run({ upload: await profileUpload(), storage });
    expect((await invoke(first.handler)).statusCode).toBe(201);

    const retry = {
      storage,
      handler: createCmsUploadMediaHandler({
        firestore: db,
        requirePrincipalFn: async () => CONTRIBUTOR,
        parseUploadFn: async () => await profileUpload(),
        storageFactory: () => storage,
        mintId: ids("photo-asset-2", "photo-attempt-2"),
        now: () => new Date("2026-08-21T18:05:00.000Z"),
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        publicOrigin: "https://media.njpbs.org",
        log: { error: vi.fn(), warn: vi.fn() },
      }),
    };
    const duplicate = await invoke(retry.handler);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toEqual({
      error: "This file is already in the media library",
      duplicateAssetId: "photo-asset",
    });
    // Recovery only, never a second record or a stray staging object.
    expect(await documents("media_assets")).toHaveLength(1);
    expect(storage.objects.has("cms-media-staging/photo-attempt-2")).toBe(false);
  });

  it("does not hand a scoped uploader someone else's profile photo", async () => {
    // The scope is one category AND their own asset. Another person's head shot
    // in the same category is still a stranger's file: the retry gets the generic
    // duplicate answer, exactly as an outsider does.
    await seedAccount("contributor-1");
    await seedAccount("contributor-2");
    const storage = memoryStorage();
    const owner = {
      storage,
      handler: createCmsUploadMediaHandler({
        firestore: db,
        requirePrincipalFn: async () => ({
          uid: "contributor-2",
          email: "fixture-0a8b684dc2@example.org",
          principal: { id: "contributor-2", grants: [{ role: "contributor" }] },
        }),
        parseUploadFn: async () => await profileUpload(),
        storageFactory: () => storage,
        mintId: ids("photo-asset", "photo-attempt"),
        now: () => new Date("2026-08-21T18:00:00.000Z"),
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        publicOrigin: "https://media.njpbs.org",
        log: { error: vi.fn(), warn: vi.fn() },
      }),
    };
    expect((await invoke(owner.handler)).statusCode).toBe(201);

    const intruder = run({
      upload: await profileUpload(),
      storage,
    });
    const duplicate = await invoke(intruder.handler);

    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body.duplicateAssetId).toBeNull();
  });

  it("does not renew another account's expired profile-photo claim", async () => {
    await seedAccount("contributor-1");
    await seedAccount("contributor-2");
    const upload = await profileUpload();
    const storage = memoryStorage({ failFinal: true });
    const owner = run({
      upload,
      storage,
      principal: {
        uid: "contributor-2",
        email: "fixture-0a8b684dc2@example.org",
        principal: { id: "contributor-2", grants: [{ role: "contributor" }] },
      },
      mintId: ids("owner-asset", "owner-attempt"),
    });
    expect((await invoke(owner.handler)).statusCode).toBe(503);
    const ownerRef = (await db.collection("system").doc("media")
      .collection("hashOwners").get()).docs[0].ref;
    const claimBefore = (await ownerRef.get()).data();

    storage.setFailFinal(false);
    const retry = run({
      upload,
      storage,
      mintId: ids("retry-asset", "retry-attempt"),
      now: () => new Date("2026-08-21T18:16:00.000Z"),
    });
    const response = await invoke(retry.handler);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "This file is already reserved by another account",
    });
    expect((await ownerRef.get()).data()).toEqual(claimBefore);
    expect(await documents("media_assets")).toHaveLength(0);
  });

  it("bounds a scoped upload at the profile ceiling", () => {
    // The unit of the rule, stated once: 5 MiB and 400 pixels are the ratified
    // numbers, and the handler reads them from the profile contract rather than
    // keeping its own copy.
    expect(AUTHOR_PHOTO_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(() =>
      media.assertProfilePhotoUpload({
        metadata: { license: "Profile photo: NJ PBS or Montclair State photograph" },
        mimeType: "image/png",
        sizeBytes: AUTHOR_PHOTO_MAX_BYTES + 1,
        dimensions: { width: 800, height: 800 },
      }),
    ).toThrow(/5 MB or smaller/);
  });
});
