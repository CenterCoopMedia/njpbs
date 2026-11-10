import type { PreviewProgress } from "../lib/saved-preview-operation";
import designTokens from "../design-system/tokens.css?inline";
import progressStyles from "./SavedPreviewProgress.css?inline";

type ProgressState = PreviewProgress | "preparing" | "opening" | "error" | "updating" | "refresh-failed";

export const previewContextRefreshingMessage = {
  heading: "Previews are refreshing",
  detail: "Previews are refreshing after a recent publish. This preview will open when they are ready.",
  error: "Previews are refreshing after a recent publish. Try again in a minute.",
} as const;

export const previewRendererUpdatingMessage = {
  heading: "Preview service is updating",
  detail: "The preview service is updating. Your edits remain in the editor. Return to the CMS and select Preview again in a few minutes.",
  editor: "The preview service is updating. Try Preview again in a few minutes. Your edits remain in the editor.",
} as const;

const messages: Record<ProgressState, { heading: string; detail: string; step: number }> = {
  preparing: { heading: "Preparing preview", detail: "Checking your current draft and saving any changes for this preview.", step: 0 },
  requesting: { heading: "Requesting your preview", detail: "Your draft is saved. Checking for a preview of this exact version.", step: 1 },
  waiting: { heading: "Waiting for an earlier preview", detail: "An earlier version is still being prepared. Your current version will follow automatically.", step: 1 },
  pending: { heading: "Your preview is queued", detail: "Your request is accepted. Waiting for the preview service to start this version.", step: 1 },
  building: { heading: "Building your preview", detail: "Preparing the page and its images from your saved draft.", step: 2 },
  refreshing: { heading: previewContextRefreshingMessage.heading, detail: previewContextRefreshingMessage.detail, step: 2 },
  "refresh-failed": { heading: previewContextRefreshingMessage.heading, detail: previewContextRefreshingMessage.error, step: -1 },
  opening: { heading: "Opening your preview", detail: "Your preview is ready. Preparing private access before opening it here.", step: 3 },
  error: { heading: "Preview unavailable", detail: "Preview is temporarily unavailable. Your edits remain in the editor. Return to the CMS and select Preview to try again.", step: -1 },
  updating: { heading: previewRendererUpdatingMessage.heading, detail: previewRendererUpdatingMessage.detail, step: -1 },
};

/** The owned blank tab has no app shell. Keep its document and live region stable. */
export function createPreviewProgressDocument(popup: Window) {
  const document = popup.document;
  document.documentElement.lang = "en";
  document.documentElement.dataset.cmsTheme = "editorial";
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const style = document.createElement("style");
  style.textContent = `${designTokens}\n${progressStyles}`;
  document.head.replaceChildren(viewport, style);

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  const main = element("main", "cms-preview-progress");
  const header = element("header", "preview-brand");
  const logo = element("img", "preview-brand-image");
  logo.src = new URL("/brand/njpbs-horizontal-white.svg", window.location.origin).href;
  logo.alt = "NJ PBS";
  logo.width = 150;
  logo.height = 42;
  header.append(logo, element("span", "preview-product", "Boardwalk"));

  const scene = element("div", "preview-scene");
  scene.setAttribute("aria-hidden", "true");
  const signal = element("div", "preview-signal");
  for (let index = 0; index < 3; index++) signal.append(element("span", "preview-signal-ring"));
  const screen = element("div", "preview-screen");
  screen.append(element("span", "preview-screen-label", "NJ PBS"), element("div", "preview-screen-picture"),
    element("div", "preview-screen-line"), element("div", "preview-screen-line preview-screen-line-short"));
  signal.append(screen);
  scene.append(signal);

  const content = element("section", "preview-copy");
  const status = element("div", "preview-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-atomic", "true");
  const heading = element("h1", "preview-heading");
  const detail = element("p", "preview-detail");
  status.append(heading, detail);
  const steps = element("ol", "preview-steps");
  steps.setAttribute("aria-label", "Preview stages");
  const stages = ["Draft", "Queue", "Build", "Open"].map(label => element("li", "preview-step", label));
  steps.append(...stages);
  const note = element("p", "preview-note", "This is a private preview. Your public site stays unchanged.");
  const footer = element("div", "preview-footer");
  footer.append(element("p", "preview-help", "You can keep editing in the CMS. This tab will open your preview automatically."));
  const pause = element("button", "preview-motion", "Pause motion");
  pause.type = "button";
  pause.setAttribute("aria-pressed", "false");
  pause.addEventListener("click", () => {
    const paused = main.dataset.paused !== "true";
    main.dataset.paused = String(paused);
    pause.setAttribute("aria-pressed", String(paused));
    pause.textContent = paused ? "Resume motion" : "Pause motion";
  });
  footer.append(pause);
  content.append(status, steps, note, footer);
  main.append(header, scene, content);
  document.body.replaceChildren(main);

  let current: ProgressState | undefined;
  function update(state: ProgressState) {
    if (state === current) return;
    current = state;
    const message = messages[state];
    const failed = state === "error" || state === "updating" || state === "refresh-failed";
    main.dataset.state = failed ? "error" : state;
    document.title = `${message.heading} | Boardwalk`;
    heading.textContent = message.heading;
    detail.textContent = message.detail;
    for (const [index, stage] of stages.entries()) {
      stage.dataset.complete = String(index < message.step);
      if (index === message.step) stage.setAttribute("aria-current", "step");
      else stage.removeAttribute("aria-current");
    }
    steps.hidden = failed;
    footer.hidden = failed;
  }
  update("preparing");
  return { update };
}
