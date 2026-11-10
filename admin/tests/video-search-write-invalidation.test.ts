import { expect, it, vi } from "vitest";
import { postFunction } from "../src/lib/functions";
import { deleteSourceMedia, updateSourceMediaMetadata } from "../src/lib/source-media";
import { videoSearchCacheRevision } from "../src/lib/video-search-session-cache";

vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn() }));

it("preserves an opted-in metadata cache and invalidates other confirmed writes", async () => {
  vi.mocked(postFunction).mockResolvedValueOnce({ success: true, asset: {} });
  const before = videoSearchCacheRevision();
  const updated = await updateSourceMediaMetadata("token", "video-library", "asset", 1, { name: "Updated" },
    { preserveVideoSearchCache: true });
  expect(updated.videoSearchRevision).toBe(before);
  expect(videoSearchCacheRevision()).toBe(before);

  vi.mocked(postFunction).mockRejectedValueOnce(new Error("Write failed"));
  await expect(deleteSourceMedia("token", "video-library", "asset", 2)).rejects.toThrow("Write failed");
  expect(videoSearchCacheRevision()).toBe(before);

  vi.mocked(postFunction).mockResolvedValueOnce({ success: true, asset: {} });
  const ordinary = await updateSourceMediaMetadata("token", "video-library", "asset", 2, { name: "Updated again" });
  expect(ordinary).not.toHaveProperty("videoSearchRevision");
  expect(videoSearchCacheRevision()).toBe(before + 1);

  vi.mocked(postFunction).mockResolvedValueOnce({ success: true, deleted: true });
  await deleteSourceMedia("token", "video-library", "asset", 2);
  expect(videoSearchCacheRevision()).toBe(before + 2);
});
