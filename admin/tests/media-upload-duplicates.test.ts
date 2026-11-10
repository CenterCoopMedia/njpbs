import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/functions";
import { uploadMediaReusingDuplicates } from "../src/lib/media-upload";

const mocks = vi.hoisted(() => ({
  cmsUploadMedia: vi.fn(),
  cmsListMedia: vi.fn(),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsUploadMedia: mocks.cmsUploadMedia,
  cmsListMedia: mocks.cmsListMedia,
}));

afterEach(() => vi.resetAllMocks());

describe("uploadMediaReusingDuplicates", () => {
  it("preserves the disclosed id when the matching file is absent from the active library", async () => {
    const refusal = new HttpError(409, "This file is already in the media library", { duplicateAssetId: "binned" });
    mocks.cmsUploadMedia.mockRejectedValue(refusal);
    mocks.cmsListMedia.mockResolvedValue({ records: [] });
    await expect(uploadMediaReusingDuplicates("token", new File(["same"], "copy.png", { type: "image/png" }), { category: "news" }, new AbortController().signal)).rejects.toBe(refusal);
  });
  it("reports a cancel during the duplicate lookup as a cancel", async () => {
    const controller = new AbortController();
    mocks.cmsUploadMedia.mockRejectedValue(
      new HttpError(409, "Duplicate media", { duplicateAssetId: "existing" }),
    );
    mocks.cmsListMedia.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      uploadMediaReusingDuplicates(
        "id-token",
        new File(["same"], "copy.png", { type: "image/png" }),
        { category: "news", license: "NJ PBS owned" },
        controller.signal,
      ),
    ).rejects.toThrow("The upload was canceled.");
  });
});
