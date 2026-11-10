import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { assertPrivateGuideBucket, storageClient } from "./upload-guide-videos.mjs";
import { readFile } from "node:fs/promises";
import { guideTranscriptFiles, versionedGuideVideoKey, publishGuideVideoRelease, putGuideVideoObjects } from "./lib/guide-video-upload.mjs";

test("all 16 transcript objects come from the reviewed private guide", async () => {
  const catalog = JSON.parse(await readFile(new URL("../admin/src/lib/guide-videos.json", import.meta.url), "utf8"));
  const markdown = await readFile(new URL("../site/src/pages/_admin-docs/video-tutorials/index.md", import.meta.url), "utf8");
  const transcripts = guideTranscriptFiles(markdown, catalog);
  assert.equal(transcripts.length, 16);
  for (const [index, file] of transcripts.entries()) {
    assert.equal(file.key, `videos/${catalog[index].id}.txt`);
    assert.equal(file.contentType, "text/plain; charset=utf-8");
    assert.equal(file.size, Buffer.byteLength(file.body));
    assert.ok(file.body.length > 100);
    assert.ok(!file.body.includes("<p>"));
    assert.ok(!file.body.includes("&quot;"));
    assert.ok(versionedGuideVideoKey("0123456789abcdef", file.key).endsWith(".txt"));
  }
  assert.deepEqual(guideTranscriptFiles(markdown.replaceAll("\n", "\r\n"), catalog), transcripts);
  assert.throws(() => guideTranscriptFiles("", catalog), /Missing/);
  assert.throws(() => guideTranscriptFiles(markdown, [{ ...catalog[0], id: "../invalid" }]), /catalog is invalid/);
  assert.throws(() => guideTranscriptFiles(markdown.replace("&quot;", "&mdash;"), catalog), /literal Unicode/);
  assert.throws(() => guideTranscriptFiles(markdown.replace("&quot;", "&constructor;"), catalog), /literal Unicode/);
  for (const entity of ["&#x110000;", "&#xD800;", "&#0;"]) {
    assert.throws(() => guideTranscriptFiles(markdown.replace("&quot;", entity), catalog), /Invalid numeric entity/);
  }
  const numeric = guideTranscriptFiles(markdown.replaceAll("&quot;", "&#X22;"), catalog);
  assert.deepEqual(numeric, transcripts);
});

test("bucket privacy admission fails closed on public or malformed metadata", async (t) => {
  const credentials = { bucket: "njpbs-admin-guide", accountId: "fixture", apiToken: "fixture" };
  const fetch = t.mock.method(globalThis, "fetch");
  const cases = [
    [{ enabled: true }, { domains: [] }, false],
    [{ enabled: false }, { domains: [{ enabled: true }] }, false],
    [{}, { domains: [] }, false],
    [{ enabled: false }, {}, false],
    [{ enabled: false }, { domains: [null] }, false],
    [{ enabled: false }, { domains: [] }, true],
  ];
  for (const [managed, custom, allowed] of cases) {
    fetch.mock.mockImplementation(async (url) => Response.json({
      success: true,
      result: url.endsWith("/managed") ? managed : custom,
    }));
    if (allowed) await assert.doesNotReject(assertPrivateGuideBucket(credentials));
    else await assert.rejects(assertPrivateGuideBucket(credentials));
  }
});

function integrityFixture({ existing, corruptPut = false, brokenRead = false } = {}) {
  const body = "good";
  const file = {
    key: "videos/analytics.mp4", body, size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"), contentType: "video/mp4",
  };
  const stored = new Map();
  const puts = [];
  const client = storageClient({ bucket: "offline-fixture" }, {
    send: async (command) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        puts.push(Key);
        stored.set(Key, corruptPut ? "evil" : Body);
        return {};
      }
      assert.equal(command.constructor.name, "GetObjectCommand");
      const bytes = stored.get(Key) ?? existing;
      if (bytes === undefined) throw Object.assign(new Error("absent"), { name: "NoSuchKey" });
      return {
        // Deliberately plausible metadata for same-length corrupt bytes.
        ContentLength: file.size, Metadata: { sha256: file.sha256 },
        Body: Readable.from((async function* () {
          yield Buffer.from(bytes.slice(0, 2));
          if (brokenRead) throw new Error("read interrupted");
          yield Buffer.from(bytes.slice(2));
        })()),
      };
    },
  });
  return { file, client, puts };
}

test("stored bytes override forged metadata before an existing object is skipped", async () => {
  const { file, client, puts } = integrityFixture({ existing: "evil" });
  assert.deepEqual(await putGuideVideoObjects([file], client), {
    uploaded: [file.key], skipped: [],
  });
  assert.deepEqual(await putGuideVideoObjects([file], client), {
    uploaded: [], skipped: [file.key],
  });
  assert.deepEqual(puts, [file.key]);
});

test("corrupt uploaded bytes fail verification and cannot activate a release", async () => {
  for (const publish of [putGuideVideoObjects, publishGuideVideoRelease]) {
    const { file, client, puts } = integrityFixture({ corruptPut: true });
    await assert.rejects(publish([file], client), /did not verify/);
    assert.ok(!puts.includes("videos/current"));
  }
});

test("release assets and the pointer are verified on upload and on rerun", async () => {
  const { file, client, puts } = integrityFixture();
  const release = await publishGuideVideoRelease([file], client);
  assert.equal(await publishGuideVideoRelease([file], client), release);
  assert.deepEqual(puts, [`videos/r/${release}/analytics.mp4`, "videos/current"]);
});

test("interrupted stored-body reads fail closed before writing", async () => {
  const { file, client, puts } = integrityFixture({ existing: "good", brokenRead: true });
  await assert.rejects(publishGuideVideoRelease([file], client), /read interrupted/);
  assert.deepEqual(puts, []);
});
