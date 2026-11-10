import assert from "node:assert/strict";
import { test } from "node:test";
import { planGuideVideoUpload, putGuideVideoObjects } from "./guide-video-upload.mjs";

const videos = [{ id: "analytics" }];
const members = [
  "_site/videos/analytics.mp4",
  "_site/posters/analytics.jpg",
  "_site/chapters/analytics.vtt",
  "_site/index.html",
];

test("plans the private guide video objects from an archive listing", () => {
  const plan = planGuideVideoUpload(members, videos);
  assert.deepEqual(plan.map((item) => item.key), [
    "videos/analytics.mp4",
    "videos/analytics.jpg",
    "videos/analytics.vtt",
  ]);
  assert.equal(plan[0].contentType, "video/mp4");
  assert.equal(plan[0].member, "_site/videos/analytics.mp4");
  assert.equal(plan[2].contentType, "text/vtt; charset=utf-8");
});

test("rejects a partial archive and an unsafe path", () => {
  assert.throws(
    () => planGuideVideoUpload(["videos/analytics.mp4"], videos),
    /missing guide video files/,
  );
  assert.throws(
    () => planGuideVideoUpload(["../videos/analytics.mp4"], videos),
    /unsafe path/,
  );
});

test("skips an unchanged object and writes a new one", async () => {
  const puts = [];
  const client = {
    head: async (key) => (key.endsWith(".mp4") ? { size: 4, sha256: "same" } : puts.includes(key) ? { size: 2, sha256: "new" } : null),
    put: async (file) => { puts.push(file.key); },
  };
  const files = [
    { key: "videos/analytics.mp4", size: 4, sha256: "same" },
    { key: "videos/analytics.jpg", size: 2, sha256: "new" },
  ];
  const first = await putGuideVideoObjects(files, client);
  assert.deepEqual(first, {
    uploaded: ["videos/analytics.jpg"],
    skipped: ["videos/analytics.mp4"],
  });
  client.head = async (key) => ({ size: key.endsWith(".mp4") ? 4 : 2, sha256: key.endsWith(".mp4") ? "same" : "new" });
  const second = await putGuideVideoObjects(files, client);
  assert.deepEqual(second.uploaded, []);
  assert.deepEqual(puts, ["videos/analytics.jpg"]);
});
