// @vitest-environment-options {"settings": {"disableIframePageLoading": true}}
import { afterEach, describe, expect, it } from "vitest";
import { renderPostMediaPlayer } from "../../packages/content-core/src/post-media-player";
import { installPostMediaPlayers } from "../src/lib/post-media-player";

const caption = "County meeting <highlights> & community questions";
const external = [
  { kind: "embed", url: "https://youtu.be/dQw4w9WgXcQ", action: "Play" },
  { kind: "linked-video", url: "https://youtu.be/dQw4w9WgXcQ", action: "Play" },
  { kind: "linked-video", url: "https://watch.njpbs.org/video/county-meeting/", action: "Watch" },
  { kind: "embed", url: "https://x.com/njpbs/status/123456789", action: "Watch" },
] as const;
afterEach(() => { document.body.innerHTML = ""; });

describe("external Post lead and entry captions", () => {
  it.each(external.flatMap(value => [false, true].map(preview => ({ ...value, preview }))))(
    "keeps one visible annotation for $kind $url (preview=$preview)", ({ kind, url, action, preview }) => {
      document.body.innerHTML = renderPostMediaPlayer({ kind, data: { url, title: " ", caption: ` ${caption} ` } }, { preview });
      const section = document.querySelector("[data-post-lead-player]")!;
      const control = section.querySelector<HTMLButtonElement | HTMLAnchorElement>(".post-lead-player__play")!;
      expect(section.getAttribute("aria-label")).toBe(caption);
      expect(control.textContent).toContain(`${action} ${caption}`);
      expect(section.querySelector(".post-lead-player__caption")).toBeNull();
      expect(section.querySelector("highlights")).toBeNull();
      expect(section.querySelector("iframe")).toBeNull();
      if (action === "Play") expect(control.getAttribute("aria-label")).toBe(`Play ${caption}`);
      else expect(control.getAttribute("href")).toBe(url);
    });

  it.each([2, 4] as const)("retains the named frame and level-%s heading after explicit Play", headingLevel => {
    document.body.innerHTML = renderPostMediaPlayer({ kind: "embed", data: {
      url: external[0].url, title: "", caption,
    } }, { headingLevel });
    installPostMediaPlayers(document);
    document.querySelector<HTMLButtonElement>("[data-lead-play]")!.click();
    expect(document.querySelector("[data-lead-play]")).toBeNull();
    expect(document.querySelector("template")).toBeNull();
    expect(document.querySelector(".post-lead-player__caption")).toBeNull();
    expect(document.querySelector(`h${headingLevel}`)?.textContent).toBe(caption);
    const frame = document.querySelector("iframe")!;
    expect(frame.title).toBe(`${caption} - YouTube video player`);
    expect(document.activeElement).toBe(frame);
    expect(new URL(frame.src).searchParams.has("autoplay")).toBe(false);
  });

  it.each(external)("keeps a separate caption for a distinct $kind title", ({ kind, url }) => {
    document.body.innerHTML = renderPostMediaPlayer({ kind, data: { url, title: "County meeting", caption } });
    expect(document.querySelector(".post-lead-player__caption")?.textContent).toBe(caption);
    expect(document.querySelector("[data-post-lead-player]")?.getAttribute("aria-label")).toBe("County meeting");
  });

  it.each([caption, "  "])("omits an equal or blank caption paragraph: %s", captionValue => {
    document.body.innerHTML = renderPostMediaPlayer({ kind: "embed", data: {
      url: external[0].url, title: caption, caption: captionValue,
    } });
    expect(document.querySelector(".post-lead-player__caption")).toBeNull();
  });
});
