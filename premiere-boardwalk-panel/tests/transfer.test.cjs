"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { download, upload, safeFilename, requireSignedTransferUrl } = require("../transfer.js");
const { BoardwalkClient } = require("../client.js");

const signedUrl = "https://owned-fixture.s3.us-east-2.amazonaws.com/video?X-Amz-Signature=fixture";
const fixture = Buffer.from("An independent transfer fixture with irregular byte boundaries.");
const digest = async data => createHash("sha256").update(new Uint8Array(data)).digest("base64");

async function disk(t) {
  const folder = await fs.mkdtemp(path.join(tmpdir(), "premiere-transfer-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const descriptors = new Map();
  let next = 0;
  return { folder, adapter: {
    async open(name, flag) { const id = next++; descriptors.set(id, await fs.open(name, flag)); return id; },
    async close(id) { await descriptors.get(id).close(); descriptors.delete(id); },
    async write(id, buffer, offset, length, position) {
      return descriptors.get(id).write(new Uint8Array(buffer), offset, Math.min(length, 3), position);
    },
    async read(id, buffer, offset, length, position) {
      return descriptors.get(id).read(new Uint8Array(buffer), offset, Math.min(length, 3), position);
    },
  } };
}
function responseFor(bytes) {
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
    controller.close();
  } }));
}

test("streaming preserves exact bytes through nonzero view offsets and partial disk writes", async t => {
  const { folder, adapter } = await disk(t);
  const destination = path.join(folder, "video.partial");
  let progress = 0;
  await download({ fs: adapter, fetcher: async () => responseFor(fixture), url: signedUrl,
    path: destination, expectedBytes: fixture.length, onProgress: bytes => { progress = bytes; } });
  assert.deepEqual(await fs.readFile(destination), fixture);
  assert.equal(progress, fixture.length);
});

test("truncation and unexpected extra bytes never complete a download", async t => {
  const { folder, adapter } = await disk(t);
  for (const length of [fixture.length - 1, fixture.length + 1]) {
    await assert.rejects(download({ fs: adapter, fetcher: async () => responseFor(fixture), url: signedUrl,
      path: path.join(folder, `video-${length}.partial`), expectedBytes: length, onProgress() {} }), /size changed|incomplete/);
  }
});

test("a download cannot overwrite an existing cached file", async t => {
  const { folder, adapter } = await disk(t);
  const destination = path.join(folder, "existing.mov");
  await fs.writeFile(destination, fixture);
  await assert.rejects(download({ fs: adapter, fetcher: async () => responseFor(Buffer.from("replacement")), url: signedUrl,
    path: destination, expectedBytes: 11, onProgress() {} }), /EEXIST/);
  assert.deepEqual(await fs.readFile(destination), fixture);
});

test("Premiere's plain aborted stream error is an expected cancellation", async t => {
  const { folder, adapter } = await disk(t);
  const controller = new AbortController();
  await assert.rejects(download({ fs: adapter, path: path.join(folder, "stopped.partial"), url: signedUrl,
    signal: controller.signal, expectedBytes: fixture.length, onProgress() {},
    fetcher: async () => ({ ok: true, body: { getReader: () => ({
      async read() { controller.abort(); throw new Error("aborted"); },
      async cancel() { throw new Error("aborted"); },
    }) } }),
  }), error => error.expected === true && /Transfer stopped/.test(error.message));
});

test("transfer URLs cannot send bytes to an arbitrary host, HTTP, or credential URL", () => {
  for (const url of ["http://owned-fixture.s3.us-east-2.amazonaws.com/file", "https://example.test/file", "https://user:pass@owned-fixture.s3.us-east-2.amazonaws.com/file", "https://owned-fixture.s3.us-east-2.amazonaws.com.evil.test/file"]) {
    assert.throws(() => requireSignedTransferUrl(url));
  }
  assert.equal(requireSignedTransferUrl(signedUrl), signedUrl);
  assert.equal(safeFilename("../CON.mp4"), "..-CON.mp4");
  assert.equal(safeFilename("CON.mp4"), "media-CON.mp4");
  assert.equal(safeFilename(`${"long-title".repeat(40)}.mov`).length, 120);
  assert.ok(safeFilename(`${"long-title".repeat(40)}.mov`).endsWith(".mov"));
});

test("resuming checks retained bytes even when name, size and modification time match", async t => {
  const { folder, adapter } = await disk(t);
  const destination = path.join(folder, "video.mp4");
  await fs.writeFile(destination, fixture);
  const partSize = 16;
  const session = { sessionId: "fixture-session", originalName: "video.mp4", sizeBytes: fixture.length,
    lastModified: 1234, partSize, totalParts: Math.ceil(fixture.length / partSize), version: 1,
    completedParts: [{ partNumber: 1, checksumSha256: await digest(Buffer.alloc(partSize)) }] };
  let signed = false;
  const client = new BoardwalkClient({}, async (_url, request) => {
    const { operation } = JSON.parse(request.body);
    if (operation === "cmsResumeSourceMediaUpload") return Response.json({ upload: session });
    signed = true;
    throw new Error("Must not send bytes from a mismatched file");
  });
  client.session = { sessionToken: "test-session" };
  await assert.rejects(upload({ fs: adapter, client, path: destination,
    file: { name: "video.mp4", nativePath: destination, getMetadata: async () => ({ size: fixture.length, dateModified: new Date(1234) }) },
    session, digest, onProgress() {}, onSession() {}, fetcher: async () => { throw new Error("Must not upload"); },
  }), /differs from the uploaded parts/);
  assert.equal(signed, false);
});

test("multipart resume delivers the exact original bytes with a retained first part", async t => {
  const { folder, adapter } = await disk(t);
  const destination = path.join(folder, "video.mp4");
  await fs.writeFile(destination, fixture);
  const session = { sessionId: "fixture-resume", originalName: "video.mp4", sizeBytes: fixture.length,
    lastModified: 1234, partSize: 16, totalParts: Math.ceil(fixture.length / 16), version: 2,
    completedParts: [{ partNumber: 1, checksumSha256: await digest(fixture.subarray(0, 16)) }] };
  const received = new Map([[1, fixture.subarray(0, 16)]]);
  const checksums = new Map();
  let version = 2;
  const client = new BoardwalkClient({}, async (_url, request) => {
    const { operation, payload } = JSON.parse(request.body);
    if (operation === "cmsResumeSourceMediaUpload") return Response.json({ upload: session });
    assert.equal(payload.version, version);
    if (operation === "cmsSignSourceMediaUploadParts") {
      const part = payload.parts[0];
      assert.ok(part.partNumber > 1);
      checksums.set(part.partNumber, part.checksumSha256);
      return Response.json({ version: ++version, parts: [{ partNumber: part.partNumber,
        url: `${signedUrl}&partNumber=${part.partNumber}`, requiredHeaders: { "x-amz-checksum-sha256": part.checksumSha256 } }] });
    }
    assert.equal(operation, "cmsCompleteSourceMediaUpload");
    assert.deepEqual(Buffer.concat([...received.entries()].sort((a, b) => a[0] - b[0]).map(([, bytes]) => bytes)), fixture);
    return Response.json({ asset: { id: "returned", name: "Returned video" } });
  });
  client.session = { sessionToken: "test-session" };
  let progress = 0;
  const asset = await upload({ fs: adapter, client, path: destination, session, digest, onSession() {}, onProgress(bytes) { progress = bytes; },
    file: { name: "video.mp4", nativePath: destination, getMetadata: async () => ({ size: fixture.length, dateModified: new Date(1234) }) },
    fetcher: async (url, request) => {
      const partNumber = Number(new URL(url).searchParams.get("partNumber"));
      assert.equal(request.headers["x-amz-checksum-sha256"], await digest(request.body));
      assert.equal(checksums.get(partNumber), await digest(request.body));
      received.set(partNumber, Buffer.from(request.body));
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(asset.id, "returned");
  assert.equal(progress, fixture.length);
});
