import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("explicit public author release", () => {
  it.each([undefined, "", "false", "TRUE", "True", "1", " true "])("keeps publication paused for %s", async (value) => {
    vi.stubEnv("VITE_AUTHOR_PAGES_LIVE", value);
    vi.resetModules();
    const release = await import("../src/lib/author-profile-release");
    expect(release.AUTHOR_PAGES_LIVE).toBe(false);
    expect(release.AUTHOR_PROFILE_RELEASE_COPY.publishingDescription).toContain("Self-service profile publication is paused");
    expect(release.authorPhotoActionCopy({ assetSource: "library", profileIsPublished: true, saveMode: "immediate", subject: "self" })).toContain("Saved photo changes update its public profile data");
    const publishedCopy = [release.AUTHOR_PROFILE_RELEASE_COPY.selfProfileDescription(true), release.AUTHOR_PROFILE_RELEASE_COPY.adminPublishedDescription("/authors/test/")].join(" ");
    expect(publishedCopy).toContain("public profile data");
    expect(publishedCopy).not.toMatch(/does not change njpbs|not available on njpbs|does not appear on njpbs/);
  });

  it("uses the same deliberate release input for publication and photo copy", async () => {
    vi.stubEnv("VITE_AUTHOR_PAGES_LIVE", "true");
    vi.resetModules();
    const release = await import("../src/lib/author-profile-release");
    expect(release.AUTHOR_PAGES_LIVE).toBe(true);
    expect(release.AUTHOR_PROFILE_RELEASE_COPY.publishingDescription).toContain("a public page anyone can read");
    expect(release.AUTHOR_PROFILE_RELEASE_COPY.publishedStatus("/authors/test/")).toBe("Your profile is published at /authors/test/.");
    expect(release.authorPhotoActionCopy({ assetSource: "library", profileIsPublished: true, saveMode: "immediate", subject: "self" })).toContain("Saving the photo updates the public profile.");
  });
});
