import { useEffect, useRef, useState } from "react";
import designTokens from "../../../site/src/styles/design-tokens.css?inline";
import publicSiteStyles from "../../../site/src/styles/public-site.css?inline";
import postBrandingStyles from "../../../packages/content-core/src/post-branding.css?inline";
import homeEditorialStyles from "../../../site/src/styles/home-editorial.css?inline";
import { publicSiteOrigin } from "../lib/dev-origins";
import { CMS_MEDIA_ORIGIN } from "../../../packages/content-core/src/media-origin";
import "./home-preview-frame.css";
import { mountSpotlightImages } from "../../../packages/content-core/src/spotlight-image-dom";
import { mountHomeStoryImages } from "../../../packages/content-core/src/home-story-image-dom";

const FRAME_ROOT_ID = "home-preview-root";
// Draft markup stays inert. Only these cross-origin player documents can run
// their own scripts; local/srcdoc children inherit script-src 'none'.
const FRAME_CONTENT_POLICY = `default-src 'none'; script-src 'none'; style-src 'self' https: data: blob: 'unsafe-inline'; img-src 'self' ${publicSiteOrigin} https://njpbs.org/brand/ https://image.pbs.org https://media.njpbs.org ${CMS_MEDIA_ORIGIN} data: blob:; font-src 'self' https: data: blob:; media-src 'self' https: blob:; frame-src about: https://interactives.apelections.org https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.instagram.com https://www.facebook.com https://player.pbs.org; connect-src 'none'; object-src 'none'; base-uri ${publicSiteOrigin}; form-action 'none'`;
const PUBLIC_DOCUMENT_STYLES = `
@font-face {
  font-family: "PBS Sans";
  src: url("https://media.njpbs.org/cms-media/fonts/f5b121c412775fea2088ea19d170364abf29e7db73a541259b517be880784a9b/PBSSans-Light.woff2") format("woff2");
  font-weight: 300; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "PBS Sans";
  src: url("https://media.njpbs.org/cms-media/fonts/6d1461f427c030aed42aaa039eb8ce7409a261a7a62e46ff0854d7c79db00123/PBSSans.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "PBS Sans";
  src: url("https://media.njpbs.org/cms-media/fonts/1a6fab5544c4b6b5d57d60e4c2e9a1d82488a4a510a54b6ec652e77261627cc1/PBSSans-Medium.woff2") format("woff2");
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "PBS Sans";
  src: url("https://media.njpbs.org/cms-media/fonts/d2a1a10beac03a9cf986714d6388978379efaa9d9b4a662ec374b262104851b5/PBSSans-Bold.woff2") format("woff2");
  font-weight: 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "PBS Sans";
  src: url("https://media.njpbs.org/cms-media/fonts/5b13467ba9da8daed32c4989a1f46bb11ece667e4607b9552c74315368b98cc9/PBSSans-Black.woff2") format("woff2");
  font-weight: 900; font-style: normal; font-display: swap;
}

html {
  color-scheme: dark;
  background: var(--bg-0);
  scroll-padding-top: 5rem;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
body {
  margin: 0;
  font-family: var(--font-sans);
  color: var(--text);
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(38, 56, 196, 0.25), transparent 60%),
    linear-gradient(180deg, var(--bg-1) 0%, var(--bg-0) 100%);
  background-attachment: fixed;
  line-height: 1.6;
}
/* Include the public sections' outer margins in the measured frame height. */
#${FRAME_ROOT_ID} { display: flow-root; }
h1, h2, h3 { font-weight: 700; line-height: 1.15; letter-spacing: 0; }
::selection { background: var(--color-brand); color: var(--color-text-on-brand); }
img, svg, video, canvas { max-width: 100%; }
a, button, summary, [role="button"] {
  -webkit-tap-highlight-color: rgba(38, 56, 196, 0.24);
}
html[data-saver] body { background-attachment: scroll; }
@media (prefers-reduced-data: reduce) {
  body { background-attachment: scroll; }
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: var(--focus-outline);
  outline-offset: var(--focus-offset);
}
@media (forced-colors: active) {
  :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
    outline-color: Highlight;
  }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: var(--motion-duration-fast) !important;
    animation-iteration-count: 1 !important;
    transition-duration: var(--motion-duration-fast) !important;
    scroll-behavior: auto !important;
  }
}
html[data-motion="off"] *,
html[data-motion="off"] *::before,
html[data-motion="off"] *::after {
  animation-duration: var(--motion-duration-fast) !important;
  animation-iteration-count: 1 !important;
  transition-duration: var(--motion-duration-fast) !important;
  scroll-behavior: auto !important;
}
`;

const FRAME_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="referrer" content="no-referrer">
    <meta http-equiv="Content-Security-Policy" content="${FRAME_CONTENT_POLICY}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <base href="${publicSiteOrigin}/">
    <style>${designTokens}\n${publicSiteStyles}\n${PUBLIC_DOCUMENT_STYLES}\n${postBrandingStyles}\n${homeEditorialStyles}</style>
  </head>
  <body><main id="${FRAME_ROOT_ID}"></main></body>
</html>`;

export interface HomePreviewFrameProps {
  html: string;
  title: string;
  styles?: string;
  onSelectBlock?: (id: string) => void;
  blockLabels?: Readonly<Record<string, string>>;
  onRender?: (root: HTMLElement) => void | (() => void);
  viewportHeight?: number;
  interactivePlayers?: boolean;
}

function eventElement(event: Event): Element | null {
  const target = event.target as { closest?: unknown } | null;
  return target && typeof target.closest === "function"
    ? (target as unknown as Element)
    : null;
}

export function HomePreviewFrame({ html, title, styles = "", onSelectBlock, blockLabels = {}, onRender, viewportHeight, interactivePlayers = false }: HomePreviewFrameProps) {
  const [frameDocument] = useState(() =>
    FRAME_DOCUMENT.replace("</style>", `${styles}</style>`),
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latestHtml = useRef(html);
  const fixedHeight = useRef(viewportHeight);
  fixedHeight.current = viewportHeight;
  const selectBlock = useRef(onSelectBlock);
  selectBlock.current = onSelectBlock;
  const selectionLabels = useRef(blockLabels);
  selectionLabels.current = blockLabels;
  const renderFrame = useRef(onRender);
  renderFrame.current = onRender;
  const replaceHtml = useRef<((nextHtml: string) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  latestHtml.current = html;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let stopped = false;
    let frameId: number | null = null;
    let disconnectDocument: (() => void) | null = null;

    const connect = () => {
      disconnectDocument?.();
      disconnectDocument = null;

      const document = iframe.contentDocument;
      const frameWindow = iframe.contentWindow;
      if (!document || !frameWindow) {
        replaceHtml.current = null;
        iframe.style.height = "0px";
        setError("The page preview document is not available.");
        return;
      }
      const main = document.getElementById(FRAME_ROOT_ID);
      if (!main) {
        replaceHtml.current = null;
        iframe.style.height = "0px";
        setError("The page preview document is not available.");
        return;
      }

      let documentStopped = false;
      let tracks: HTMLElement[] = [];

      const updateButtonState = (track: HTMLElement) => {
        const id = track.id;
        const previous = id
          ? document.querySelector<HTMLButtonElement>(
              `[data-rail-prev="${CSS.escape(id)}"]`,
            )
          : null;
        const next = id
          ? document.querySelector<HTMLButtonElement>(
              `[data-rail-next="${CSS.escape(id)}"]`,
            )
          : null;
        if (!previous || !next) return;

        const maximum = track.scrollWidth - track.clientWidth;
        const hasOverflow = maximum > 8;
        previous.disabled = track.scrollLeft <= 2;
        next.disabled = track.scrollLeft >= maximum - 2;
        previous.hidden = !hasOverflow || previous.disabled;
        next.hidden = !hasOverflow || next.disabled;
      };

      const measureHeight = () => {
        if (documentStopped || stopped) return;
        frameId = null;
        const height = Math.max(
          1,
          Math.ceil(main.getBoundingClientRect().height),
          main.offsetHeight,
          main.scrollHeight,
        );
        iframe.style.height = `${fixedHeight.current ?? height}px`;
      };

      const scheduleHeight = () => {
        if (documentStopped || stopped || frameId !== null) return;
        frameId = frameWindow.requestAnimationFrame(measureHeight);
      };

      const updateLayout = () => {
        tracks.forEach(updateButtonState);
        scheduleHeight();
      };

      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(updateLayout);

      let cleanupRender: (() => void) | undefined;
      const replace = (nextHtml: string) => {
        if (documentStopped || stopped || !main.isConnected) return;
        // The shared renderer supplies safe markup. The document CSP also
        // blocks draft scripts and handlers while trusted players stay usable.
        cleanupRender?.();
        main.innerHTML = nextHtml;
        mountSpotlightImages(main);
        mountHomeStoryImages(main);
        // The public hero controller does not run in this inert preview.
        main.querySelectorAll<HTMLImageElement>("img[data-home-hero-image][srcset]:not([data-spotlight-fallback])").forEach(image => {
          const retryOriginal = () => {
            image.removeAttribute("srcset");
            image.removeAttribute("sizes");
          };
          image.addEventListener("error", retryOriginal, { once: true });
          if (image.complete && image.naturalWidth === 0) retryOriginal();
        });
        cleanupRender = renderFrame.current?.(main) || undefined;
        document.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
          if (!interactivePlayers || !anchor.matches('[data-home-newscast-play][role="button"]')) anchor.tabIndex = -1;
        });
        if (selectBlock.current) {
          main.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "service-canvas-select";
            button.textContent = `Edit ${selectionLabels.current[element.dataset.blockId ?? ""] ?? "content section"}`;
            element.prepend(button);
          });
        }
        tracks.forEach((track) =>
          track.removeEventListener("scroll", updateLayout),
        );
        tracks = Array.from(
          document.querySelectorAll<HTMLElement>(".rail__track"),
        );
        tracks.forEach((track) =>
          track.addEventListener("scroll", updateLayout, { passive: true }),
        );
        resizeObserver?.disconnect();
        resizeObserver?.observe(main);
        tracks.forEach((track) => resizeObserver?.observe(track));
        updateLayout();
      };

      const preventLinkNavigation = (event: Event) => {
        const target = eventElement(event);
        if (target?.closest("a")) event.preventDefault();
      };

      const handleClick = (event: MouseEvent) => {
        const target = eventElement(event);
        if (!target) return;
        const block = target.closest<HTMLElement>("[data-block-id]");
        if (block?.dataset.blockId && selectBlock.current) {
          event.preventDefault();
          selectBlock.current(block.dataset.blockId);
          return;
        }
        if (target.closest("a")) {
          event.preventDefault();
          return;
        }

        const button = target.closest<HTMLElement>(
          "[data-rail-prev], [data-rail-next]",
        );
        if (!button) return;
        const targetId =
          button.getAttribute("data-rail-prev") ??
          button.getAttribute("data-rail-next");
        const track = targetId ? document.getElementById(targetId) : null;
        if (!track || !track.classList.contains("rail__track")) return;

        const direction = button.hasAttribute("data-rail-prev") ? -1 : 1;
        const maximum = track.scrollWidth - track.clientWidth;
        const nextLeft = Math.max(
          0,
          Math.min(
            maximum,
            track.scrollLeft +
              direction * Math.max(320, track.clientWidth * 0.78),
          ),
        );
        const reduceMotion =
          document.documentElement.dataset.motion === "off" ||
          frameWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
        track.scrollTo({
          left: nextLeft,
          behavior: reduceMotion ? "auto" : "smooth",
        });
        track.focus({ preventScroll: true });
      };

      const handleKey = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const block = eventElement(event)?.closest<HTMLElement>("[data-block-id]");
        if (!block?.dataset.blockId || !selectBlock.current) return;
        event.preventDefault();
        selectBlock.current(block.dataset.blockId);
      };
      document.addEventListener("click", handleClick);
      document.addEventListener("keydown", handleKey);
      document.addEventListener("auxclick", preventLinkNavigation);
      document.addEventListener("load", updateLayout, true);
      frameWindow.addEventListener("resize", updateLayout);
      replaceHtml.current = replace;
      replace(latestHtml.current);
      setError(null);

      void document.fonts.ready.then(() => {
        if (
          !documentStopped &&
          !stopped &&
          iframe.contentDocument === document
        ) {
          updateLayout();
        }
      });

      disconnectDocument = () => {
        cleanupRender?.();
        documentStopped = true;
        replaceHtml.current = null;
        if (frameId !== null) {
          frameWindow.cancelAnimationFrame(frameId);
          frameId = null;
        }
        resizeObserver?.disconnect();
        tracks.forEach((track) =>
          track.removeEventListener("scroll", updateLayout),
        );
        document.removeEventListener("click", handleClick);
        document.removeEventListener("keydown", handleKey);
        document.removeEventListener("auxclick", preventLinkNavigation);
        document.removeEventListener("load", updateLayout, true);
        frameWindow.removeEventListener("resize", updateLayout);
      };
    };

    iframe.addEventListener("load", connect);
    if (iframe.contentDocument?.getElementById(FRAME_ROOT_ID)) connect();

    return () => {
      stopped = true;
      iframe.removeEventListener("load", connect);
      disconnectDocument?.();
      replaceHtml.current = null;
    };
  }, []);

  useEffect(() => {
    replaceHtml.current?.(html);
  }, [html, onRender]);

  return (
    <div className="home-preview-frame-shell">
      {error ? (
        <p className="home-preview-frame-error" role="alert">
          {error}
        </p>
      ) : null}
      <iframe
        ref={iframeRef}
        className="home-preview-frame"
        title={title}
        sandbox={interactivePlayers ? "allow-same-origin allow-scripts" : "allow-same-origin"}
        allow={interactivePlayers ? "autoplay; encrypted-media; fullscreen; picture-in-picture" : undefined}
        referrerPolicy="no-referrer"
        srcDoc={frameDocument}
      />
    </div>
  );
}
