import { describe, expect, it } from "vitest";
import { routedBatchNotice, splitUploadFiles } from "../src/lib/upload-destination";

function file(name: string, type: string) {
  return new File(["x"], name, { type });
}

describe("upload destination", () => {
  it("routes generic and browser WAV MIME variants through the media upload path", () => {
    const split = splitUploadFiles([file("interview.wav", ""), file("report.wav", "audio/x-wav"), file("take.wav", "audio/vnd.wave")]);
    expect(split.library.map(item => item.type)).toEqual(["audio/wav", "audio/wav", "audio/wav"]);
    expect(split.video).toEqual([]);
    expect(split.unsupported).toEqual([]);
  });
  it("sends images and PDFs to the library and videos to the shared video library", () => {
    const split = splitUploadFiles([
      file("shore.jpg", "image/jpeg"),
      file("notes.pdf", "application/pdf"),
      file("debate.mp4", "video/mp4"),
      file("debate.mxf", ""),
      file("notes.txt", "text/plain"),
    ]);
    expect(split.library.map((item) => item.name)).toEqual(["shore.jpg", "notes.pdf"]);
    expect(split.video.map((item) => item.name)).toEqual(["debate.mp4", "debate.mxf"]);
    expect(split.unsupported.map((item) => item.name)).toEqual(["notes.txt"]);
  });

  it("gives an extension-routed library file the MIME type validation accepts", () => {
    const split = splitUploadFiles([
      file("photo.jpg", ""),
      file("brief.pdf", "application/octet-stream"),
      file("page.html", "text/html"),
    ]);
    expect(split.library.map((item) => [item.name, item.type])).toEqual([
      ["photo.jpg", "image/jpeg"],
      ["brief.pdf", "application/pdf"],
    ]);
    expect(split.unsupported.map((item) => item.name)).toEqual(["page.html"]);
  });
});

describe("routed batch notice", () => {
  it("waits for the routed files and ignores work that is still open", () => {
    expect(routedBatchNotice("Videos", "video", [
      { name: "clip.mp4", outcome: "ready" },
      { name: "other.mp4" },
    ])).toBeNull();
  });

  it("names one ready file when another routed file failed", () => {
    expect(routedBatchNotice("Videos", "video", [
      { name: "clip.mp4", outcome: "ready" },
      { name: "other.mp4", outcome: "failed" },
    ])).toBe("clip.mp4 is in Videos.");
  });

  it("counts a finished batch and starts the next batch empty", () => {
    expect(routedBatchNotice("Videos", "video", [
      { name: "one.mp4", outcome: "ready" },
      { name: "two.mp4", outcome: "ready" },
    ])).toBe("2 videos are in Videos.");
    expect(routedBatchNotice("Videos", "video", [])).toBeNull();
  });
});
