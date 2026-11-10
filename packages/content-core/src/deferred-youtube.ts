import { youtubePlayerSrc } from "./embed-player.ts";

const mounted = new WeakSet<HTMLIFrameElement>();
const marker = "data-deferred-youtube-src";
const admitted = (src: string) => youtubePlayerSrc(src) === src;

/** Native iframe lazy loading can initialize a player well below the viewport.
 * Observe its actual frame, and also activate on focus for keyboard/AT readers. */
export function mountDeferredYoutubeEmbeds(root: ParentNode = document): void {
  const frames = [...root.querySelectorAll<HTMLIFrameElement>(`iframe[${marker}]`)]
    .filter(frame => !mounted.has(frame) && admitted(frame.getAttribute(marker) ?? ""));
  if (!frames.length) return;
  const pending = new Set(frames);
  let observer: IntersectionObserver | undefined;
  const load = (frame: HTMLIFrameElement) => {
    if (!pending.has(frame)) return;
    const source = frame.getAttribute(marker) ?? "";
    if (!admitted(source)) return;
    frame.src = source;
    frame.removeAttribute(marker);
    frame.removeEventListener("focus", focus);
    pending.delete(frame);
    observer?.unobserve(frame);
    if (!pending.size) observer?.disconnect();
  };
  const focus = (event: Event) => load(event.currentTarget as HTMLIFrameElement);
  for (const frame of frames) { mounted.add(frame); frame.addEventListener("focus", focus); }
  const view = frames[0].ownerDocument.defaultView;
  if (view?.IntersectionObserver) {
    observer = new view.IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) load(entry.target as HTMLIFrameElement);
    });
    frames.forEach(frame => observer!.observe(frame));
  } else frames.forEach(load);
}
