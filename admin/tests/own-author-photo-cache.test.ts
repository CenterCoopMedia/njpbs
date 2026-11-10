import { beforeEach, describe, expect, it } from "vitest";
import {
  OWN_AVATAR_MAX_AGE_MS,
  clearOwnAvatarPhoto,
  ownAvatarPhotoEpoch,
  readOwnAvatarPhoto,
  writeOwnAvatarPhoto,
} from "../src/lib/own-author-photo-cache";

beforeEach(() => {
  sessionStorage.clear();
});

describe("own avatar photo cache", () => {
  it("stores the crop for one uid and drops a different account's entry", () => {
    writeOwnAvatarPhoto("person-1", {
      url: "https://media.njpbs.org/a.jpg",
      focalX: 0.25,
      focalY: 0.75,
    });
    expect(readOwnAvatarPhoto("person-1")).toEqual({
      url: "https://media.njpbs.org/a.jpg",
      focalX: 0.25,
      focalY: 0.75,
    });

    expect(readOwnAvatarPhoto("person-2")).toBeUndefined();
    expect(sessionStorage.getItem("njpbs.admin.ownAvatarPhoto")).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain("a.jpg");
  });

  it("remembers a profile with no photograph and ignores a stored token", () => {
    writeOwnAvatarPhoto("person-1", null);
    expect(readOwnAvatarPhoto("person-1")).toBeNull();

    sessionStorage.setItem("njpbs.admin.ownAvatarPhoto", JSON.stringify({
      uid: "person-1",
      photo: { url: "https://media.njpbs.org/a.jpg", focalX: 0.5, focalY: 0.5, token: "id-token" },
    }));
    expect(readOwnAvatarPhoto("person-1")).toEqual({
      url: "https://media.njpbs.org/a.jpg",
      focalX: 0.5,
      focalY: 0.5,
    });
    expect(sessionStorage.getItem("njpbs.admin.ownAvatarPhoto")).not.toContain("id-token");
    clearOwnAvatarPhoto();
    expect(readOwnAvatarPhoto("person-1")).toBeUndefined();
  });

  it("treats a crop older than one minute as a miss when freshness is required", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    writeOwnAvatarPhoto("person-1", { url: "https://media.njpbs.org/a.jpg", focalX: 0, focalY: 1 });
    now.mockReturnValue(5_000 + OWN_AVATAR_MAX_AGE_MS);
    expect(readOwnAvatarPhoto("person-1")).toEqual({
      url: "https://media.njpbs.org/a.jpg",
      focalX: 0,
      focalY: 1,
    });
    expect(readOwnAvatarPhoto("person-1", OWN_AVATAR_MAX_AGE_MS)).toBeUndefined();
    now.mockRestore();
  });

  it("stores a covering thumbnail address and drops an unsafe one", () => {
    writeOwnAvatarPhoto("person-1", {
      url: "https://media.njpbs.org/original.jpg",
      focalX: 0.2,
      focalY: 0.3,
      thumbnails: [
        { url: "https://media.njpbs.org/short.webp", width: 480, height: 40 },
        { url: "http://media.njpbs.org/insecure.webp", width: 480, height: 480 },
        { url: "https://user:pass@media.njpbs.org/auth.webp", width: 480, height: 480 },
        { url: "https://media.njpbs.org/thumb.webp", width: 480, height: 480 },
      ],
    });
    expect(readOwnAvatarPhoto("person-1")).toEqual({
      url: "https://media.njpbs.org/thumb.webp",
      focalX: 0.2,
      focalY: 0.3,
    });
    const stored = sessionStorage.getItem("njpbs.admin.ownAvatarPhoto") ?? "";
    expect(stored).not.toContain("thumbnails");
    expect(stored).not.toContain("insecure.webp");
    expect(stored).not.toContain("auth.webp");
  });

  it("moves the epoch when the stored crop is replaced or cleared", () => {
    const started = ownAvatarPhotoEpoch();
    writeOwnAvatarPhoto("person-1", { url: "https://media.njpbs.org/a.jpg", focalX: 0, focalY: 1 });
    expect(ownAvatarPhotoEpoch()).toBe(started + 1);
    clearOwnAvatarPhoto();
    expect(ownAvatarPhotoEpoch()).toBe(started + 2);
  });
});
