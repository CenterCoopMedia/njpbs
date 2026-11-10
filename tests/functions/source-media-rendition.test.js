import { describe, expect, it, vi } from "vitest";
import sourceMedia from "../../functions/source-media.js";
import sourceContract from "../../functions/lib/source-media-contract.js";
import renditionContract from "../../functions/lib/source-media-rendition.js";
import s3MediaSource from "../../functions/lib/s3-media-source.js";

const { createCmsCreateSourceMediaReadHandler } = sourceMedia;
const {
  parseSourceMediaAsset,
  parseSourceMediaReadRequest,
  sourceMediaAssetSummary,
} = sourceContract;
const {
  sourceMediaRenditionId,
  sourceMediaRenditionOutputPrefix,
} = renditionContract;
const { createS3MediaSourceReader } = s3MediaSource;
const RENDITION_ID = "e745dbead6330fe24cd9e7a2c0d2312545055fb703713e9bf97f1275f952f2f3";

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

function source() {
  return {
    id: "video-library",
    label: "Shared video library",
    description: "Station video.",
    mediaKind: "video",
    bucket: "njpbs-video-originals-123456789012-us-east-2",
    expectedBucketOwner: "123456789012",
    prefix: "objects/",
    roleArn: "arn:aws:iam::123456789012:role/njpbs-boardwalk-video-read",
    access: "active_staff",
    writable: true,
    enabled: true,
  };
}

function storedAsset(overrides = {}) {
  return {
    sourceId: "video-library",
    lifecycle: "active",
    name: "County meeting.mxf",
    originalName: "County meeting.mxf",
    description: "A county government meeting.",
    nameSort: "county meeting.mxf",
    updatedAtSort: "2026-09-14T16:00:00.000Z",
    mimeType: "application/mxf",
    kind: "video",
    sizeBytes: 8_000_000,
    preview: "download_only",
    rightsStatus: "complete",
    license: "Station owned",
    credit: "NJ PBS",
    tags: ["county"],
    version: 1,
    createdAt: "2026-09-14T15:00:00.000Z",
    updatedAt: "2026-09-14T16:00:00.000Z",
    objectKey: "objects/county-meeting.mxf",
    objectVersionId: "original-version-id",
    ...overrides,
  };
}

function readyRendition(assetId = "asset-1", assetValue = storedAsset(), overrides = {}) {
  const identity = { id: assetId, ...assetValue };
  const attemptId = "attempt-1";
  const prefix = sourceMediaRenditionOutputPrefix(identity, attemptId);
  return {
    schemaVersion: 1,
    state: "ready",
    sourceObjectKey: identity.objectKey,
    sourceObjectVersionId: identity.objectVersionId,
    sourceSizeBytes: identity.sizeBytes,
    attemptId,
    updatedAt: "2026-09-14T16:02:00.000Z",
    web: {
      objectKey: `${prefix}preview.mp4`,
      objectVersionId: "web-version-id",
      sizeBytes: 2_000_000,
      mimeType: "video/mp4",
      width: 1920,
      height: 1080,
      durationSeconds: 92.5,
    },
    poster: {
      objectKey: `${prefix}preview-poster.0000000.jpg`,
      objectVersionId: "poster-version-id",
      sizeBytes: 24_000,
      mimeType: "image/jpeg",
    },
    ...overrides,
  };
}

function parsedReadyAsset(overrides = {}) {
  const value = storedAsset(overrides);
  return parseSourceMediaAsset("asset-1", {
    ...value,
    rendition: readyRendition("asset-1", value),
  });
}

function reader({ headResult, onSign } = {}) {
  const headInputs = [];
  const signedInputs = [];
  class FakeS3Client {
    async send(command) {
      headInputs.push(command.input);
      if (headResult) return headResult(command.input);
      if (command.input.Bucket === source().bucket) {
        return { VersionId: "original-version-id", ContentLength: 8_000_000 };
      }
      if (command.input.Key.endsWith("preview.mp4")) {
        return { VersionId: "web-version-id", ContentLength: 2_000_000 };
      }
      return { VersionId: "poster-version-id", ContentLength: 24_000 };
    }
  }
  const createRead = createS3MediaSourceReader(
    {
      audience: "njpbs-boardwalk-s3",
      region: "us-east-2",
      renditionBucket: "njpbs-video-renditions-123456789012-us-east-2",
      renditionExpectedBucketOwner: "123456789012",
    },
    {
      S3ClientCtor: FakeS3Client,
      createAwsRoleCredentialsFn: async () => ({
        accessKeyId: "temporary",
        secretAccessKey: "temporary",
        sessionToken: "temporary",
      }),
      getSignedUrlFn: async (_client, command) => {
        signedInputs.push(command.input);
        await onSign?.();
        return "https://signed.example/read";
      },
      nowFn: () => Date.parse("2026-09-14T16:00:00.000Z"),
    },
  );
  return { createRead, headInputs, signedInputs };
}

describe("source media rendition contract", () => {
  it("derives the rendition identity from the exact original tuple", () => {
    const asset = { id: "asset-1", ...storedAsset() };
    expect(sourceMediaRenditionId(asset)).toBe(RENDITION_ID);
    expect(sourceMediaRenditionOutputPrefix(asset, "attempt-1"))
      .toBe(`outputs/${RENDITION_ID}/attempt-1/`);
  });

  it("projects ready metadata without private storage coordinates", () => {
    const asset = parsedReadyAsset();
    const summary = sourceMediaAssetSummary(asset);
    expect(summary.viewingCopy).toEqual({
      state: "ready",
      sizeBytes: 2_000_000,
      width: 1920,
      height: 1080,
      durationSeconds: 92.5,
    });
    expect(JSON.stringify(summary)).not.toContain("outputs/");
    expect(summary.viewingCopy).not.toHaveProperty("objectKey");
    expect(summary.viewingCopy).not.toHaveProperty("objectVersionId");
  });

  it.each([
    ["replaced original", (rendition) => ({
      ...rendition,
      sourceObjectVersionId: "stale-version",
    })],
    ["wrong web prefix", (rendition) => ({
      ...rendition,
      web: { ...rendition.web, objectKey: "outputs/another/attempt-1/preview.mp4" },
    })],
    ["wrong poster name", (rendition) => ({
      ...rendition,
      poster: { ...rendition.poster, objectKey: rendition.poster.objectKey.replace(
        "preview-poster.0000000.jpg",
        "preview-poster.jpg",
      ) },
    })],
    ["missing poster", (rendition) => {
      const copy = { ...rendition };
      delete copy.poster;
      return copy;
    }],
    ["unknown field", (rendition) => ({ ...rendition, signedUrl: "https://example.test" })],
  ])("treats %s rendition metadata as not prepared", (_label, mutate) => {
    const value = storedAsset();
    const asset = parseSourceMediaAsset("asset-1", {
      ...value,
      rendition: mutate(readyRendition("asset-1", value)),
    });
    expect(asset).not.toBeNull();
    expect(asset.rendition).toBeNull();
    expect(sourceMediaAssetSummary(asset).viewingCopy).toEqual({ state: "not_prepared" });
  });

  it("exposes a bounded failure code without internal fields", () => {
    const value = storedAsset();
    const ready = readyRendition("asset-1", value);
    const asset = parseSourceMediaAsset("asset-1", {
      ...value,
      rendition: {
        schemaVersion: 1,
        state: "failed",
        sourceObjectKey: value.objectKey,
        sourceObjectVersionId: value.objectVersionId,
        sourceSizeBytes: value.sizeBytes,
        attemptId: ready.attemptId,
        updatedAt: ready.updatedAt,
        errorCode: "unsupported_input",
      },
    });
    expect(sourceMediaAssetSummary(asset).viewingCopy).toEqual({
      state: "failed",
      errorCode: "unsupported_input",
    });
  });

  it.each(["preview", "download", "poster", "download_web"])(
    "accepts the %s private read action",
    (action) => {
      expect(parseSourceMediaReadRequest({
        sourceId: "video-library",
        assetId: "asset-1",
        action,
      }).action).toBe(action);
    },
  );
});

describe("source media rendition reads", () => {
  it.each([
    ...["download", "download_web", "preview", "poster"].map(action => [action, "replacement", 409]),
    ["preview", "rendition", 409],
    ["poster", "rendition", 409],
    ["download_web", "rendition", 409],
    ["download", "deleted", 404],
    ["download", "source", 404],
    ["download", "metadata", 200],
  ])("rechecks %s after signing across a concurrent %s change", async (action, change, status) => {
    let saved = storedAsset();
    saved.rendition = readyRendition("asset-1", saved);
    const { createRead, signedInputs } = reader({ onSign: async () => {
      if (change === "replacement") saved = { ...saved, objectVersionId: "promoted-original-version" };
      if (change === "rendition") saved = { ...saved, rendition: { ...saved.rendition,
        web: { ...saved.rendition.web, objectVersionId: "new-web-version" },
        poster: { ...saved.rendition.poster, objectVersionId: "new-poster-version" } } };
      if (change === "deleted") saved = { ...saved, lifecycle: "deleted" };
      if (change === "source") saved = { ...saved, sourceId: "another-source" };
      if (change === "metadata") saved = { ...saved, credit: "Updated pool credit", version: 2 };
    } });
    const handler = createCmsCreateSourceMediaReadHandler({
      firestore: { collection: () => ({ doc: id => ({ get: async () => ({
        exists: true, id, data: () => saved,
      }) }) }) },
      requirePrincipalFn: async () => ({ uid: "staff-1" }),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => true,
      createReadFn: createRead,
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({ sourceId: "video-library", assetId: "asset-1", action }), res);
    expect(signedInputs).toHaveLength(1);
    expect(res.statusCode).toBe(status);
    if (status !== 200) {
      expect(res.body).not.toHaveProperty("access");
      expect(JSON.stringify(res.body)).not.toContain("https://signed.example/read");
    } else {
      expect(res.body.access.credit).toBe("Updated pool credit");
      expect(res.body.access.url).toBe("https://signed.example/read");
    }
  });

  it.each([
    ["preview", "preview.mp4", "web-version-id", "video/mp4", "inline"],
    ["download_web", "preview.mp4", "web-version-id", "video/mp4", "attachment"],
    ["poster", "preview-poster.0000000.jpg", "poster-version-id", "image/jpeg", "inline"],
  ])("signs %s only after exact original and rendition HEAD checks", async (
    action,
    fileName,
    versionId,
    mimeType,
    disposition,
  ) => {
    const { createRead, headInputs, signedInputs } = reader();
    const result = await createRead(source(), parsedReadyAsset(), action);
    expect(headInputs).toHaveLength(2);
    expect(headInputs[0]).toMatchObject({
      Bucket: source().bucket,
      Key: "objects/county-meeting.mxf",
      VersionId: "original-version-id",
      ExpectedBucketOwner: "123456789012",
    });
    expect(signedInputs).toHaveLength(1);
    expect(signedInputs[0]).toMatchObject({
      Bucket: "njpbs-video-renditions-123456789012-us-east-2",
      Key: `outputs/${RENDITION_ID}/attempt-1/${fileName}`,
      VersionId: versionId,
      ExpectedBucketOwner: "123456789012",
      ResponseContentType: mimeType,
    });
    expect(result).toMatchObject({ action, mimeType, disposition, supportsRange: true });
  });

  it("always signs the exact original for the original download action", async () => {
    const { createRead, headInputs, signedInputs } = reader();
    const result = await createRead(source(), parsedReadyAsset(), "download");
    expect(headInputs).toHaveLength(1);
    expect(signedInputs[0]).toMatchObject({
      Bucket: source().bucket,
      Key: "objects/county-meeting.mxf",
      VersionId: "original-version-id",
      ResponseContentType: "application/mxf",
    });
    expect(result).toMatchObject({
      action: "download",
      mimeType: "application/mxf",
      disposition: "attachment",
    });
  });

  it("falls back to the browser-compatible original when no web copy is ready", async () => {
    const asset = parseSourceMediaAsset("asset-1", storedAsset({
      mimeType: "video/mp4",
      originalName: "County meeting.mp4",
      preview: "browser",
      rendition: null,
    }));
    const { createRead, signedInputs } = reader();
    const result = await createRead(source(), asset, "preview");
    expect(signedInputs[0]).toMatchObject({
      Bucket: source().bucket,
      VersionId: "original-version-id",
      ResponseContentType: "video/mp4",
    });
    expect(result).toMatchObject({ action: "preview", mimeType: "video/mp4" });
  });

  it("falls back to the original when the indexed web rendition is unavailable", async () => {
    const asset = parsedReadyAsset({
      mimeType: "video/mp4",
      originalName: "County meeting.mp4",
      preview: "browser",
    });
    const { createRead, signedInputs } = reader({
      headResult: (input) => input.Bucket === source().bucket
        ? { VersionId: "original-version-id", ContentLength: 8_000_000 }
        : { VersionId: "another-version", ContentLength: 2_000_000 },
    });
    const result = await createRead(source(), asset, "preview");
    expect(signedInputs[0]).toMatchObject({
      Bucket: source().bucket,
      VersionId: "original-version-id",
    });
    expect(result.mimeType).toBe("video/mp4");
  });

  it.each(["poster", "download_web"])("returns 409 when %s is not ready", async (action) => {
    const asset = parseSourceMediaAsset("asset-1", storedAsset());
    const { createRead, signedInputs } = reader();
    await expect(createRead(source(), asset, action)).rejects.toMatchObject({ status: 409 });
    expect(signedInputs).toHaveLength(0);
  });

  it("does not sign a rendition when the exact original identity fails", async () => {
    const { createRead, signedInputs } = reader({
      headResult: () => ({ VersionId: "replaced-version", ContentLength: 8_000_000 }),
    });
    await expect(createRead(source(), parsedReadyAsset(), "download_web"))
      .rejects.toMatchObject({ status: 409 });
    expect(signedInputs).toHaveLength(0);
  });

  it.each([
    ["version", { VersionId: "another-version", ContentLength: 2_000_000 }],
    ["size", { VersionId: "web-version-id", ContentLength: 1_999_999 }],
  ])("does not sign a web copy when its exact %s fails", async (_label, webHead) => {
    const { createRead, signedInputs } = reader({
      headResult: (input) => input.Bucket === source().bucket
        ? { VersionId: "original-version-id", ContentLength: 8_000_000 }
        : webHead,
    });
    await expect(createRead(source(), parsedReadyAsset(), "download_web"))
      .rejects.toMatchObject({ status: 409 });
    expect(signedInputs).toHaveLength(0);
  });

  it("does not sign a rendition key that bypasses stored-asset parsing", async () => {
    const asset = parsedReadyAsset();
    asset.rendition.web.objectKey = "outputs/another/attempt-1/preview.mp4";
    const { createRead, headInputs, signedInputs } = reader();
    await expect(createRead(source(), asset, "download_web"))
      .rejects.toMatchObject({ status: 409 });
    expect(headInputs).toHaveLength(0);
    expect(signedInputs).toHaveLength(0);
  });

  it("authorizes a poster request before loading or signing the asset", async () => {
    const firestore = { collection: vi.fn() };
    const createReadFn = vi.fn();
    const handler = createCmsCreateSourceMediaReadHandler({
      firestore,
      requirePrincipalFn: async () => ({ uid: "staff-1", principal: { id: "staff-1" } }),
      registryFn: () => new Map([["video-library", source()]]),
      authorizeFn: async () => {
        const error = new Error("Media source access denied");
        error.status = 403;
        throw error;
      },
      createReadFn,
      log: { error: vi.fn() },
    });
    const res = response();
    await handler(request({
      sourceId: "video-library",
      assetId: "asset-1",
      action: "poster",
    }), res);
    expect(res.statusCode).toBe(403);
    expect(firestore.collection).not.toHaveBeenCalled();
    expect(createReadFn).not.toHaveBeenCalled();
  });
});


describe("measured original frame rate", () => {
  it("round trips rational source metadata without changing the original identity or legacy renditions", () => {
    const asset = storedAsset();
    const ready = readyRendition("asset-1", asset);
    const measured = { ...ready, web: { ...ready.web, sourceFrameRateNumerator: 60000, sourceFrameRateDenominator: 1001 } };
    const parsed = parseSourceMediaAsset("asset-1", { ...asset, rendition: measured });
    expect(sourceMediaAssetSummary(parsed).viewingCopy).toMatchObject({ sourceFrameRateNumerator: 60000, sourceFrameRateDenominator: 1001 });
    expect(parsed.objectVersionId).toBe(asset.objectVersionId);
    expect(sourceMediaAssetSummary(parseSourceMediaAsset("asset-1", { ...asset, rendition: ready })).viewingCopy.sourceFrameRateNumerator).toBeUndefined();
    for (const fields of [{ sourceFrameRateDenominator: 0 }, { sourceFrameRateNumerator: 25, sourceFrameRateDenominator: undefined }, { sourceFrameRateNumerator: "25" }]) {
      expect(renditionContract.parseSourceMediaRendition({ ...measured, web: { ...measured.web, ...fields } }, { id: "asset-1", ...asset })).toBeNull();
    }
  });
});
