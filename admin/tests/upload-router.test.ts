import { describe, expect, it } from "vitest";
import {
  clearRejectedUploads,
  finishLibraryUpload,
  registerLibraryUpload,
  registerVideoUpload,
  resetUploadRouter,
  routeChosenFiles,
  uploadRouterSnapshot,
} from "../src/lib/upload-router";
import { authorizedMediaUploadCategory } from "../src/lib/media-upload";
import { uploadableSharedVideoSource } from "../src/lib/source-media";
import type { Principal } from "../../packages/content-core/src/rbac";

function file(name: string, type: string) {
  return new File(["x"], name, { type });
}

describe("upload router", () => {
  it("keeps a routed library batch mounted after the form takes the files", () => {
    resetUploadRouter();
    const seen: string[][] = [];
    routeChosenFiles([file("shore.jpg", "image/jpeg")]);
    expect(uploadRouterSnapshot().librarySession).toBe(true);
    const stop = registerLibraryUpload((files) => {
      seen.push(files.map((item) => item.name));
    });
    expect(seen).toEqual([["shore.jpg"]]);
    expect(uploadRouterSnapshot().library).toEqual([]);
    expect(uploadRouterSnapshot().librarySession).toBe(true);
    finishLibraryUpload();
    expect(uploadRouterSnapshot().librarySession).toBe(false);
    stop();
  });

  it("routes a mixed batch and keeps an unsupported file from stopping the others", () => {
    resetUploadRouter();
    const library: string[] = [];
    const video: string[] = [];
    const stopLibrary = registerLibraryUpload((files) => {
      library.push(...files.map((item) => item.name));
    });
    const stopVideo = registerVideoUpload((files) => {
      video.push(...files.map((item) => item.name));
    });
    routeChosenFiles([
      file("shore.jpg", "image/jpeg"),
      file("notes.txt", "text/plain"),
      file("clip.mp4", "video/mp4"),
      file("brief.pdf", "application/pdf"),
    ]);
    expect(library).toEqual(["shore.jpg", "brief.pdf"]);
    expect(video).toEqual(["clip.mp4"]);
    expect(uploadRouterSnapshot().rejected).toEqual(["notes.txt"]);
    expect(uploadRouterSnapshot().librarySession).toBe(false);
    expect(uploadRouterSnapshot().videoSession).toBe(false);
    stopLibrary();
    stopVideo();
  });

  it("clears held files and rejection names when the account boundary resets", () => {
    resetUploadRouter();
    routeChosenFiles([file("notes.txt", "text/plain"), file("clip.mp4", "video/mp4")]);
    expect(uploadRouterSnapshot().rejected).toEqual(["notes.txt"]);
    expect(uploadRouterSnapshot().videoSession).toBe(true);
    clearRejectedUploads();
    expect(uploadRouterSnapshot().rejected).toEqual([]);
    routeChosenFiles([file("other.txt", "text/plain")]);
    resetUploadRouter();
    expect(uploadRouterSnapshot()).toEqual({
      library: [],
      video: [],
      rejected: [],
      librarySession: false,
      videoSession: false,
    });
  });
});

describe("routed upload admission", () => {
  const sectionEditor = {
    id: "sam",
    grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
  } as unknown as Principal;

  it("defaults to General for an area-scoped uploader and skips inactive categories", () => {
    expect(authorizedMediaUploadCategory(sectionEditor, [
      { id: "general", active: true, canUpload: true },
      { id: "news", active: true, canUpload: true },
    ])).toBe("general");
    expect(authorizedMediaUploadCategory(sectionEditor, [
      { id: "general", active: true, canUpload: true },
    ])).toBe("general");
    expect(authorizedMediaUploadCategory(sectionEditor, [
      { id: "general", active: false, canUpload: true },
      { id: "staff-profile", active: true, canUpload: true },
    ])).toBe("staff-profile");
    expect(authorizedMediaUploadCategory({ grants: [{ role: "staff" }] }, [
      { id: "general", active: true, canUpload: true },
    ])).toBe("");
  });

  it("routes video only to an uploadable shared library", () => {
    expect(uploadableSharedVideoSource([
      { id: "archive-originals", canUpload: false },
      { id: "video-library", canUpload: true },
    ])?.id).toBe("video-library");
    expect(uploadableSharedVideoSource([
      { id: "video-library", canUpload: false },
    ])).toBeNull();
    expect(uploadableSharedVideoSource([])).toBeNull();
  });
});
