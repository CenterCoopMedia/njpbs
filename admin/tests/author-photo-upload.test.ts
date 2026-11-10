import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../src/lib/functions", () => ({
  cmsUploadMedia: mocks.upload,
  cmsListMedia: mocks.list,
}));

import { uploadAuthorPhoto } from "../src/lib/author-photo";

describe("uploadAuthorPhoto", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.upload.mockResolvedValue({ asset: { id: "photo-one" } });
  });

  it("retains the original JPEG profile photo", async () => {
    const file = new File(["jpeg bytes"], "profile.jpg", {
      type: "image/jpeg",
    });

    await uploadAuthorPhoto("id-token", file, {
      displayName: "Sam Morgan",
      rightsBasis: "own-photo",
    });

    expect(mocks.upload).toHaveBeenCalledWith(
      "id-token",
      file,
      expect.objectContaining({
        category: "staff-profile",
      }),
      undefined,
    );
    expect(mocks.upload.mock.calls[0][2]).not.toHaveProperty(
      "imageProcessing",
    );
  });

  it("reuses the existing asset when the same image is uploaded again", async () => {
    const file = new File(["same jpeg bytes"], "profile.jpg", {
      type: "image/jpeg",
    });
    const existing = {
      id: "photo-one",
      category: "staff-profile",
      kind: "image",
      license: "Profile photo: supplied by the staff member, cleared for use",
    };
    mocks.upload
      .mockResolvedValueOnce({ asset: existing })
      .mockRejectedValueOnce({
        status: 409,
        data: { duplicateAssetId: "photo-one" },
      });
    mocks.list.mockResolvedValue({ records: [existing] });

    await uploadAuthorPhoto("id-token", file, {
      displayName: "Sam Morgan",
      rightsBasis: "own-photo",
    });
    const second = await uploadAuthorPhoto("id-token", file, {
      displayName: "Sam Morgan",
      rightsBasis: "own-photo",
    });

    expect(second.asset).toBe(existing);
    expect(mocks.list).toHaveBeenCalledWith(
      "id-token",
      expect.objectContaining({
        q: "photo-one",
        categories: ["staff-profile"],
        profilePhotoScope: "self",
      }),
    );
  });

  it("reads a duplicate in another category by its exact id", async () => {
    const file = new File(["same jpeg bytes"], "profile.jpg", { type: "image/jpeg" });
    const general = { id: "photo-general", category: "general", kind: "image", license: "NJ PBS owned" };
    mocks.upload.mockRejectedValueOnce({ status: 409, data: { duplicateAssetId: "photo-general" } });
    mocks.list.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [general] });

    const result = await uploadAuthorPhoto("id-token", file, { displayName: "Olivia Thornton", rightsBasis: "station-photo" });

    expect(result.asset).toBe(general);
    expect(mocks.list).toHaveBeenLastCalledWith(
      "id-token",
      expect.objectContaining({ q: "", categories: [], assetIds: ["photo-general"] }),
    );
    expect(mocks.list.mock.calls[1][1]).not.toHaveProperty("profilePhotoScope");
  });
});
