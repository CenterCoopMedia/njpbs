import { describe, expect, it } from "vitest";
import {
  containsVideo,
  isPublicVideoUrl,
  renderVideoBlock,
  withoutPublicVideoData,
  type VideoBlockData,
} from "../../packages/content-core/src/video-block";

const hash = "0123456789abcdef".repeat(4);
const base = (extension: string) =>
  `https://media.njpbs.org/cms-media/video/abc123/${hash}.${extension}`;
const published: VideoBlockData = {
  sourceId: "video-library",
  assetId: "abc123",
  title: "Clip",
  public: { url: base("mp4"), posterUrl: base("jpg"), width: 1920, height: 1080, mimeType: "video/mp4" },
};

describe("video block rendering", () => {
  it("renders nothing without a published copy", () => {
    const { public: _public, ...draft } = published;
    expect(renderVideoBlock(draft)).toBe("");
  });

  it("holds an unpublished video's space in a draft preview without a player or media url (#2760)", () => {
    const { public: _public, ...draft } = published;
    const html = renderVideoBlock({ ...draft, title: 'A "<b>" & C', caption: "<i>cap</i>" }, { placeholder: true });
    expect(html).toContain('class="cms-video cms-video--pending"');
    expect(html).toContain("A &quot;&lt;b&gt;&quot; &amp; C");
    expect(html).toContain("Video appears after publishing");
    expect(html).toContain("&lt;i&gt;cap&lt;/i&gt;");
    expect(html).not.toMatch(/<video|<source|src=|poster=/);
  });

  it("plays a published video in a draft preview", () => {
    expect(renderVideoBlock(published, { placeholder: true })).toBe(renderVideoBlock(published));
  });

  it("renders the figure with a lazy controlled player", () => {
    const html = renderVideoBlock({ ...published, caption: "A caption" });
    expect(html).toContain('<figure class="cms-video">');
    expect(html).toContain("controls");
    expect(html).toContain('preload="none"');
    expect(html).toContain('width="1920" height="1080"');
    expect(html).toContain(`<source src="${base("mp4")}" type="video/mp4">`);
    expect(html).toContain(`poster="${base("jpg")}"`);
    expect(html).toContain('<figcaption class="cms-video__caption">A caption</figcaption>');
  });

  it("escapes the title and caption", () => {
    const html = renderVideoBlock({ ...published, title: 'A "<b>" & C', caption: "<script>x</script>" });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });
});

describe("public video urls", () => {
  it("accepts the exact station object url", () => {
    expect(isPublicVideoUrl(base("mp4"), "mp4")).toBe(true);
    expect(isPublicVideoUrl(base("jpg"), "jpg")).toBe(true);
  });

  it("rejects other hosts, query strings, non-hex names, and wrong extensions", () => {
    expect(isPublicVideoUrl(base("mp4").replace("media.njpbs.org", "example.com"), "mp4")).toBe(false);
    expect(isPublicVideoUrl(`${base("mp4")}?x=1`, "mp4")).toBe(false);
    expect(isPublicVideoUrl(`${base("mp4")}#t=1`, "mp4")).toBe(false);
    expect(isPublicVideoUrl(base("mp4").replace(hash, "z".repeat(64)), "mp4")).toBe(false);
    expect(isPublicVideoUrl(base("mp4").replace(hash, hash.slice(1)), "mp4")).toBe(false);
    expect(isPublicVideoUrl(base("jpg"), "mp4")).toBe(false);
    expect(isPublicVideoUrl(base("mp4"), "jpg")).toBe(false);
    expect(isPublicVideoUrl(base("webm"), "mp4")).toBe(false);
  });
});

describe("video block list helpers", () => {
  const image = { id: "i", type: "image", data: { public: "keep" } };
  const video = { id: "v", type: "video", data: { ...published } };

  it("detects a video block", () => {
    expect(containsVideo([image, video])).toBe(true);
    expect(containsVideo([image])).toBe(false);
    expect(containsVideo(undefined)).toBe(false);
  });

  it("ignores a video block with no published copy, as the renderer does", () => {
    const { public: _public, ...hidden } = published;
    expect(containsVideo([image, { id: "h", type: "video", visible: false, data: hidden }])).toBe(false);
    expect(renderVideoBlock(hidden)).toBe("");
  });

  it("strips public only from video blocks", () => {
    const [kept, stripped] = withoutPublicVideoData([image, video]) as Array<{ data: Record<string, unknown> }>;
    expect(kept.data.public).toBe("keep");
    expect("public" in stripped.data).toBe(false);
    expect(stripped.data.assetId).toBe("abc123");
  });
});
