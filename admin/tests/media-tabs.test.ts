import { describe, expect, it } from "vitest";
import { canReviewUgcSubmissions } from "../src/lib/access";
import {
  currentMediaTabId,
  mediaTabName,
  mediaTabs,
  shouldSuppressTabClick,
  tabEdgeFade,
  tabRevealOffset,
} from "../src/lib/media-tabs";

const sources = [
  { id: "video-library", label: "Videos" },
  { id: "spotlight", label: "NJ Spotlight News originals" },
];

function click(init: Partial<Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {}) {
  return { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init };
}

describe("media tabs", () => {
  it("orders Images, each video source, UGC, Audio, Favorites, Collections with the earlier paths", () => {
    expect(mediaTabs({ canUseImages: true, canReviewSubmissions: true, sources }).map((tab) => [tab.id, tab.label, tab.icon, tab.path])).toEqual([
      ["images", "Images", "image", "/media/images"],
      ["video-library", "Videos", "video", "/media/videos"],
      ["spotlight", "NJ Spotlight News originals", "video", "/media/videos/spotlight"],
      ["submissions", "Public submissions", "folder", "/media/submissions"],
      ["voiceovers", "Audio", "microphone", "/media/voiceovers"],
      ["favorites", "Favorites", "heart", "/media/favorites"],
      ["collections", "Collections", "folder", "/media/collections"],
    ]);
  });

  it("omits Images without media library access", () => {
    expect(mediaTabs({ canUseImages: false, sources }).map((tab) => tab.id)[0]).toBe("video-library");
  });

  it("shows UGC only for a site-wide media manager", () => {
    const scoped = { grants: [{ role: "editor" as const, sections: ["general"] }] };
    const global = { grants: [{ role: "editor" as const }] };
    expect(canReviewUgcSubmissions(scoped)).toBe(false);
    expect(canReviewUgcSubmissions(global)).toBe(true);
    expect(mediaTabs({ canUseImages: true, canReviewSubmissions: canReviewUgcSubmissions(scoped), sources })
      .some(tab => tab.id === "submissions")).toBe(false);
    expect(mediaTabs({ canUseImages: true, canReviewSubmissions: canReviewUgcSubmissions(global), sources })
      .find(tab => tab.id === "submissions")?.path).toBe("/media/submissions");
  });

  it("shows the primary source with its default label before sources load", () => {
    const tabs = mediaTabs({ canUseImages: true, sources: [] });
    expect(tabs[1]).toMatchObject({ id: "video-library", label: "Videos", path: "/media/videos" });
  });

  it("keeps the new label when an older source API returns the old one", () => {
    expect(mediaTabs({ canUseImages: true, sources: [{ id: "video-library", label: "Shared video library" }] })[1].label).toBe("Videos");
  });

  it("attaches known counts and leaves unknown ones out", () => {
    const tabs = mediaTabs({ canUseImages: true, sources, counts: { images: 412, spotlight: 86 } });
    expect(tabs.map((tab) => tab.count)).toEqual([412, undefined, 86, undefined, undefined, undefined]);
  });

  it("marks the current tab from route kind and source id, never by path prefix", () => {
    expect(currentMediaTabId({ kind: "videos", sourceId: "spotlight" }, sources)).toBe("spotlight");
    expect(currentMediaTabId({ kind: "videos", sourceId: null }, sources)).toBe("video-library");
    expect(currentMediaTabId({ kind: "videos", sourceId: null }, [])).toBe("video-library");
    expect(currentMediaTabId({ kind: "images" }, sources)).toBe("images");
  });

  it("keeps Collections current on a collection detail path", () => {
    expect(currentMediaTabId({ kind: "collections", collectionId: "c1" }, sources)).toBe("collections");
  });

  it("marks no tab current while a custom source is still loading", () => {
    const tabs = mediaTabs({ canUseImages: true, sources: [] });
    const current = currentMediaTabId({ kind: "videos", sourceId: "archive" }, []);
    expect(tabs.some((tab) => tab.id === current)).toBe(false);
  });

  it("suppresses only an unmodified primary click on a tab whose path is the current pathname", () => {
    expect(shouldSuppressTabClick(click(), "/media/images", "/media/images")).toBe(true);
    expect(shouldSuppressTabClick(click(), "/media/collections", "/media/collections/c1")).toBe(false);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(shouldSuppressTabClick(click(init), "/media/images", "/media/images")).toBe(false);
    }
  });

  it("names a counted tab with its label and count", () => {
    expect(mediaTabName("Images", 1204)).toBe("Images 1,204 items");
    expect(mediaTabName("Favorites", 1)).toBe("Favorites 1 item");
    expect(mediaTabName("Collections")).toBe("Collections");
  });

  it("reports none, start, mid or end edge fades from the scroll position", () => {
    expect(tabEdgeFade({ scrollLeft: 0, scrollWidth: 500, clientWidth: 500 })).toBe("none");
    expect(tabEdgeFade({ scrollLeft: 0, scrollWidth: 900, clientWidth: 500 })).toBe("end");
    expect(tabEdgeFade({ scrollLeft: 200, scrollWidth: 900, clientWidth: 500 })).toBe("mid");
    expect(tabEdgeFade({ scrollLeft: 400, scrollWidth: 900, clientWidth: 500 })).toBe("start");
  });

  it("returns the scroll offset that reveals the current tab with a 16px margin, or none without a current tab", () => {
    const strip = { scrollLeft: 0, clientWidth: 500 };
    expect(tabRevealOffset(strip, { offsetLeft: 100, offsetWidth: 120 })).toBeNull();
    expect(tabRevealOffset(strip, { offsetLeft: 600, offsetWidth: 120 })).toBe(236);
    expect(tabRevealOffset({ scrollLeft: 300, clientWidth: 500 }, { offsetLeft: 100, offsetWidth: 120 })).toBe(84);
    expect(tabRevealOffset(strip, null)).toBeNull();
  });
});
