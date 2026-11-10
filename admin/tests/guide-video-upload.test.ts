import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containedGuideFile,
  guideVideoReleaseId,
  planGuideVideoUpload,
  publishGuideVideoRelease,
  putGuideVideoObjects,
  tarExtractArgs,
  versionedGuideVideoKey,
} from "../../scripts/lib/guide-video-upload.mjs";

const videos = [{ id: "analytics" }];

describe("guide video upload", () => {
  it("plans archive members onto the private prefix and skips unchanged objects", async () => {
    const plan = planGuideVideoUpload([
      "./videos/analytics.mp4",
      "./posters/analytics.jpg",
      "./chapters/analytics.vtt",
    ], videos);
    expect(plan.map((item: { key: string }) => item.key)).toEqual([
      "videos/analytics.mp4",
      "videos/analytics.jpg",
      "videos/analytics.vtt",
    ]);
    expect(plan[0]).toMatchObject({ contentType: "video/mp4", member: "./videos/analytics.mp4" });

    const puts: string[] = [];
    const client = {
      head: async (key: string) => (key.endsWith(".mp4") ? { size: 4, sha256: "same" } : puts.includes(key) ? { size: 2, sha256: "new" } : null),
      put: async (file: { key: string }) => { puts.push(file.key); },
    };
    const files = [
      { key: "videos/analytics.mp4", size: 4, sha256: "same" },
      { key: "videos/analytics.jpg", size: 2, sha256: "new" },
    ];
    await expect(putGuideVideoObjects(files, client)).resolves.toEqual({
      uploaded: ["videos/analytics.jpg"],
      skipped: ["videos/analytics.mp4"],
    });
    client.head = async () => ({ size: 2, sha256: "new" });
    await expect(putGuideVideoObjects([files[1]], client)).resolves.toEqual({
      uploaded: [],
      skipped: ["videos/analytics.jpg"],
    });
    expect(puts).toEqual(["videos/analytics.jpg"]);
  });

  it("publishes a release pointer only after every object verifies", async () => {
    const puts: string[] = [];
    const stored = new Map<string, { size: number; sha256: string }>();
    const files = [
      { key: "videos/analytics.mp4", size: 4, sha256: "a" },
      { key: "videos/analytics.jpg", size: 2, sha256: "b" },
    ];
    const release = guideVideoReleaseId(files);
    const client = {
      head: async (key: string) => stored.get(key) ?? null,
      put: async (file: { key: string; size: number; sha256: string }) => {
        puts.push(file.key);
        if (file.key.endsWith(".jpg")) throw new Error("stop");
        stored.set(file.key, { size: file.size, sha256: file.sha256 });
      },
    };
    await expect(publishGuideVideoRelease(files, client)).rejects.toThrow("stop");
    expect(puts).not.toContain("videos/current");
    client.put = async (file: { key: string; size: number; sha256: string }) => {
      puts.push(file.key);
      stored.set(file.key, { size: file.size, sha256: file.sha256 });
    };
    await expect(publishGuideVideoRelease(files, client)).resolves.toBe(release);
    expect(puts).toContain("videos/current");
    expect(versionedGuideVideoKey(release, "videos/analytics.mp4")).toBe(`videos/r/${release}/analytics.mp4`);
  });

  it("rejects a partial archive and an unsafe member", () => {
    expect(() => planGuideVideoUpload(["./videos/analytics.mp4"], videos)).toThrow(/missing guide video files/);
    expect(() => planGuideVideoUpload(["../secret.mp4"], videos)).toThrow(/unsafe path/);
    expect(() => planGuideVideoUpload(["--to-command=id #/videos/analytics.mp4"], videos)).toThrow(/unsafe path/);
    expect(tarExtractArgs("site.tar.gz", "/tmp/guide", ["./videos/analytics.mp4"])).toEqual([
      "-xzf", "site.tar.gz", "-C", "/tmp/guide", "--", "./videos/analytics.mp4",
    ]);
    expect(planGuideVideoUpload([
      "./",
      "./videos/",
      "./videos/analytics.mp4",
      "./posters/",
      "./posters/analytics.jpg",
      "./chapters/",
      "./chapters/analytics.vtt",
    ], videos).map((item) => item.key)).toEqual([
      "videos/analytics.mp4",
      "videos/analytics.jpg",
      "videos/analytics.vtt",
    ]);
  });

  it("refuses a symlink that leaves the archive directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guide-videos-"));
    const outside = path.join(tmpdir(), `guide-secret-${Date.now()}`);
    await writeFile(outside, "secret");
    await symlink(outside, path.join(root, "analytics.mp4"));
    await writeFile(path.join(root, "plain.mp4"), "video");
    await expect(containedGuideFile(root, "analytics.mp4")).rejects.toThrow(/regular file/);
    await expect(containedGuideFile(root, "plain.mp4")).resolves.toBe(path.join(root, "plain.mp4"));
  });
});
