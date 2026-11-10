import { extractPartnerPlayerSrc } from "./partner-player.ts";

/** Progressive enhancement shared by public Home and Boardwalk's phone frame.
 * The link stays usable without JS; no iframe or player request exists at rest. */
export function installHomeNewscastPlayers(root: Document | HTMLElement): () => void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[data-home-newscast-play]")) {
    link.setAttribute("role", "button");
    link.tabIndex = 0;
  }
  const activate = (event: Event) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    const link = typeof target?.closest === "function" ? target.closest<HTMLAnchorElement>("a[data-home-newscast-play]") : null;
    if (!link || !root.contains(link)) return;
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (key !== "Enter" && key !== " ") return;
    } else if ((event as MouseEvent).button !== 0 || (event as MouseEvent).metaKey ||
        (event as MouseEvent).ctrlKey || (event as MouseEvent).shiftKey || (event as MouseEvent).altKey) return;
    const src = extractPartnerPlayerSrc(link.dataset.playerSrc);
    const episode = link.closest(".home-newscast__episode");
    const media = episode?.querySelector(".home-newscast__media");
    if (!src || src !== link.dataset.playerSrc || !media) return;
    event.preventDefault();
    const document = link.ownerDocument;
    const player = document.createElement("iframe");
    const url = new URL(src); url.searchParams.set("autoplay", "true");
    player.src = url.href;
    player.title = `PBS player: ${link.dataset.episodeTitle ?? "Latest newscast"}`;
    player.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    player.tabIndex = 0;
    const section = link.closest("[data-home-section='home-newscast']");
    const poster = media.closest("a");
    // Unwrap before attaching the frame: moving an already connected iframe
    // would navigate it a second time.
    poster?.replaceWith(media);
    media.replaceChildren(player);
    episode?.querySelector("[data-home-newscast-watch]")?.remove();
    const fallback = section?.querySelector<HTMLElement>("[data-home-newscast-fallback]");
    if (fallback) { fallback.hidden = false; fallback.tabIndex = 0; }
    player.focus({ preventScroll: true });
  };
  root.addEventListener("click", activate);
  root.addEventListener("keydown", activate);
  return () => {
    root.removeEventListener("click", activate);
    root.removeEventListener("keydown", activate);
  };
}
