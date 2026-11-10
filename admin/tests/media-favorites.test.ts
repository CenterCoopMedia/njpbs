import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postFunction: vi.fn(),
  adjustMediaFavoritesCount: vi.fn(),
  mediaTabCountsRevision: vi.fn(() => 17),
}));

vi.mock("../src/lib/functions", () => ({ postFunction: mocks.postFunction }));
vi.mock("../src/lib/media-session-cache", () => ({
  adjustMediaFavoritesCount: mocks.adjustMediaFavoritesCount,
  mediaTabCountsRevision: mocks.mediaTabCountsRevision,
}));

import {
  setMediaFavorites,
  summarizeMediaFavoritesResult,
  type MediaFavoriteRef,
  type MediaFavoritesResult,
} from "../src/lib/media-favorites";

const r2 = (id: string): MediaFavoriteRef => ({ backend: "r2", id });
const s3 = (sourceId: string, id: string): MediaFavoriteRef => ({
  backend: "s3",
  sourceId,
  id,
});

beforeEach(() => {
  mocks.postFunction.mockReset();
  mocks.adjustMediaFavoritesCount.mockReset();
  mocks.mediaTabCountsRevision.mockClear();
});

describe("media favorites batch client", () => {
  it("keeps equal asset ids separate by full backend identity", async () => {
    const refs = [r2("shared"), s3("archive", "shared")];
    const response: MediaFavoritesResult = {
      success: true,
      favorite: true,
      results: refs.map(ref => ({ ref, favorite: true, changed: true })),
    };
    mocks.postFunction.mockResolvedValue(response);

    const result = await setMediaFavorites("token", refs, true);

    expect(summarizeMediaFavoritesResult(result)).toEqual({
      changedRefs: refs,
      failedResults: [],
    });
    expect(mocks.postFunction).toHaveBeenCalledWith(
      "cmsSetMediaFavorites",
      "token",
      { refs, favorite: true },
      {},
      { appCheck: true },
    );
    expect(mocks.adjustMediaFavoritesCount).toHaveBeenCalledWith(2, 17);
  });

  it("returns changed refs and per-ref failures from a partial ordered result", async () => {
    const refs = [r2("changed"), s3("archive", "blocked"), r2("unchanged")];
    const failed = { ref: refs[1], error: "Media asset is unavailable", status: 404 };
    mocks.postFunction.mockResolvedValue({
      success: true,
      favorite: false,
      results: [
        { ref: refs[0], favorite: false, changed: true },
        failed,
        { ref: refs[2], favorite: false, changed: false },
      ],
    });

    const result = await setMediaFavorites("token", refs, false);

    expect(summarizeMediaFavoritesResult(result)).toEqual({
      changedRefs: [refs[0]],
      failedResults: [failed],
    });
    expect(mocks.adjustMediaFavoritesCount).toHaveBeenCalledWith(-1, 17);
  });

  it("accepts at most 100 unique bounded full refs", async () => {
    const refs = Array.from({ length: 100 }, (_, index) => r2(`asset_${index}`));
    mocks.postFunction.mockResolvedValue({
      success: true,
      favorite: true,
      results: refs.map(ref => ({ ref, favorite: true, changed: false })),
    });

    await expect(setMediaFavorites("token", refs, true)).resolves.toMatchObject({
      success: true,
      results: expect.any(Array),
    });
    await expect(setMediaFavorites("token", [...refs, r2("asset_100")], true))
      .rejects.toThrow("1 through 100");
    await expect(setMediaFavorites("token", [], true)).rejects.toThrow("1 through 100");
    await expect(setMediaFavorites("token", [refs[0], refs[0]], true))
      .rejects.toThrow("duplicate");
    await expect(setMediaFavorites("token", [r2("bad:id")], true))
      .rejects.toThrow("invalid");
    expect(mocks.postFunction).toHaveBeenCalledTimes(1);
    expect(mocks.adjustMediaFavoritesCount).not.toHaveBeenCalled();
  });

  it("rejects malformed or misordered responses before changing the count", async () => {
    const refs = [r2("same"), s3("archive", "same")];
    const validResults = refs.map(ref => ({ ref, favorite: false, changed: true }));
    const malformed = [
      { success: false, favorite: false, results: validResults },
      { success: true, favorite: true, results: validResults },
      { success: true, favorite: false, results: [validResults[1], validResults[0]] },
      { success: true, favorite: false, results: validResults.slice(0, 1) },
      {
        success: true,
        favorite: false,
        results: [{ ...validResults[0], favorite: true }, validResults[1]],
      },
      {
        success: true,
        favorite: false,
        results: [{ ...validResults[0], changed: "yes" }, validResults[1]],
      },
      {
        success: true,
        favorite: false,
        results: [{ ref: refs[0], error: "Denied", status: 200 }, validResults[1]],
      },
    ];

    for (const response of malformed) {
      mocks.postFunction.mockResolvedValueOnce(response);
      await expect(setMediaFavorites("token", refs, false))
        .rejects.toThrow("Favorite batch response is invalid");
    }
    expect(mocks.adjustMediaFavoritesCount).not.toHaveBeenCalled();
  });

  it("keeps the count unchanged when the batch endpoint is unavailable", async () => {
    mocks.postFunction.mockRejectedValueOnce(new Error("Function unavailable"));
    await expect(setMediaFavorites("token", [r2("image")], false)).rejects.toThrow("Function unavailable");
    expect(mocks.postFunction).toHaveBeenCalledOnce();
    expect(mocks.adjustMediaFavoritesCount).not.toHaveBeenCalled();
  });
});
