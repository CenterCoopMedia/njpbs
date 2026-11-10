// @vitest-environment jsdom
// jsdom leaves subresources disabled; playback checks never contact PBS.
import { afterEach, describe, expect, it } from "vitest";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";
import provider from "../../site/tests/fixtures/home-sources/newscast-documented-schema.json";
import { createHomeNewscastBlock, renderHomeNewscast } from "../../packages/content-core/src/home-newscast-section";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import { installHomeNewscastPlayers } from "../../packages/content-core/src/home-newscast-player";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";

const cutoffAt = "2026-10-11T19:00:00.000Z";
const source = adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
  checkedAt: cutoffAt, complete: true, response: provider }, cutoffAt);
const catalog = readHomeEditorialCatalog({ ...fixture.editorial.catalog, cutoffAt,
  services: { newsletters: { status: "error" }, newscast: source } });
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; document.body.replaceChildren(); });

describe("progressive newscast playback", () => {
  it("is an episode link without JavaScript and counts as video-bearing before activation", () => {
    const html = renderHomeNewscast(createHomeNewscastBlock("latest"), catalog);
    document.body.innerHTML = html;
    const link = document.querySelector<HTMLAnchorElement>("a[data-home-newscast-play]")!;
    expect(link.href).toBe("https://watch.njpbs.org/video/nj-pbs-news-with-rob-nelson-october-9-2026-0oavxo/");
    expect(link.hasAttribute("role")).toBe(false);
    expect(link).toHaveAccessibleName("Play NJ PBS News with Rob Nelson | October 9, 2026");
    expect(document.querySelector("iframe")).toBeNull();
    expect(hasVideoPlayer(html)).toBe(true);
    expect(hasVideoPlayer('<a href="https://watch.njpbs.org/video/example/">Watch</a>')).toBe(false);
  });
  it.each([
    ["poster", "click"], ["poster", "Enter"], ["poster", " "],
    ["watch", "click"], ["watch", "Enter"], ["watch", " "],
  ])("loads only the approved episode in place from %s on %s, once, and moves focus", (control, action) => {
    document.body.innerHTML = renderHomeNewscast(createHomeNewscastBlock("latest"), catalog);
    cleanup = installHomeNewscastPlayers(document);
    const link = document.querySelector<HTMLAnchorElement>(control === "poster" ? ".home-newscast__poster-link" : "[data-home-newscast-watch]")!;
    expect(link.getAttribute("role")).toBe("button"); expect(link.tabIndex).toBe(0);
    expect(document.querySelector("iframe")).toBeNull();
    link.focus();
    const event = action === "click" ? new MouseEvent("click", { bubbles: true, cancelable: true })
      : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    const player = document.querySelector<HTMLIFrameElement>("iframe")!;
    expect(player.src).toBe("https://player.pbs.org/partnerplayer/3114511752/?autoplay=true");
    expect(player.title).toBe("PBS player: NJ PBS News with Rob Nelson | October 9, 2026");
    expect(document.activeElement).toBe(player);
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector("a[data-home-newscast-play]")).toBeNull();
    expect(document.querySelector(".home-newscast__poster")).toBeNull();
    expect(document.querySelector<HTMLElement>("[data-home-newscast-fallback]")!.hidden).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });
  it("ignores unrelated keys and modified clicks and removes its listeners on cleanup", () => {
    document.body.innerHTML = renderHomeNewscast(createHomeNewscastBlock("latest"), catalog);
    cleanup = installHomeNewscastPlayers(document);
    const link = document.querySelector<HTMLAnchorElement>("a[data-home-newscast-play]")!;
    const preventNavigation = (event: Event) => event.preventDefault();
    document.addEventListener("click", preventNavigation);
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    link.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
    expect(document.querySelector("iframe")).toBeNull();
    cleanup();
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.removeEventListener("click", preventNavigation);
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("keeps the visible staff-edited Watch text in the button's accessible name", () => {
    const block = createHomeNewscastBlock("latest");
    block.data.watchLabel = "Watch tonight's bulletin";
    document.body.innerHTML = renderHomeNewscast(block, catalog);
    cleanup = installHomeNewscastPlayers(document);
    const link = document.querySelector<HTMLAnchorElement>("a[data-home-newscast-watch]")!;
    expect(link).toHaveAccessibleName("Watch tonight's bulletin");
    expect(link).toHaveTextContent("Watch tonight's bulletin");
  });
});
