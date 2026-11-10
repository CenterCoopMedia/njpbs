import { beforeEach, describe, expect, it, vi } from "vitest";

const { postFunction } = vi.hoisted(() => ({ postFunction: vi.fn() }));
vi.mock("../src/lib/functions", () => ({ postFunction }));

import {
  listMediaCollectionItems,
  listMediaCollections,
  mutateMediaCollection,
  setMediaCollectionItems,
} from "../src/lib/media-collections";

describe("media collection client", () => {
  beforeEach(() => postFunction.mockReset());

  it("uses bounded read endpoints without App Check", () => {
    listMediaCollections("token", {
      scope: "all_staff",
      lifecycle: "active",
      limit: 20,
    });
    listMediaCollectionItems("token", {
      collectionId: "a".repeat(64),
      cursor: "cursor",
    });
    expect(postFunction).toHaveBeenNthCalledWith(1, "cmsListMediaCollections", "token", {
      scope: "all_staff",
      lifecycle: "active",
      limit: 20,
    });
    expect(postFunction).toHaveBeenNthCalledWith(2, "cmsListMediaCollectionItems", "token", {
      collectionId: "a".repeat(64),
      cursor: "cursor",
    });
  });

  it("requires App Check for metadata and membership writes", () => {
    mutateMediaCollection("token", {
      action: "create",
      requestId: "request_12345678",
      scope: "private",
      name: "My selects",
    });
    setMediaCollectionItems("token", {
      collectionId: "a".repeat(64),
      requestId: "request_abcdefgh",
      baseMembershipVersion: 1,
      present: true,
      refs: [{ backend: "r2", id: "asset-1" }],
    });
    expect(postFunction.mock.calls[0]?.[4]).toEqual({ appCheck: true });
    expect(postFunction.mock.calls[1]?.[4]).toEqual({ appCheck: true });
  });
});
