import { Window, type HTMLButtonElement, type HTMLInputElement, type HTMLIFrameElement, type HTMLDialogElement } from "happy-dom";
import { dataHubPageEnabled } from "./build-target";
import reader from "../data/njpbs-data-hub-v16.html?raw";
import tokens from "../styles/design-tokens.css?raw";

const sourcePattern = /(<script id="source-data" type="application\/json">)[\s\S]*?(<\/script>)/;
const script = reader.match(/<script>([\s\S]*?)<\/script>/)![1];

type Snapshot = { asOf: string; metrics: { id: string; status: string; value: number | null; sourceUrl: string; editorialOverride?: boolean }[] };
export type FigureEmbedPage = { id: string; snapshot: string | undefined; html: string };
const snapshots = import.meta.glob<Snapshot>("../data/data-hub-revisions/*.json", { eager: true, import: "default" });

/** Run the shipped dialog renderer at build time. No reader script reaches the embed. */
async function renderSnapshot(snapshot: Snapshot, revision: string | undefined): Promise<FigureEmbedPage[]> {
  const window = new Window({ url: "https://njpbs.org/data-hub/", settings: {
    disableIframePageLoading: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
  } });
  try {
    const source = reader.replace(sourcePattern, (_match, open, close) => open + JSON.stringify(snapshot) + close);
    window.document.head.innerHTML = `<style>${tokens}</style>`;
    window.document.body.innerHTML = `<main class="data-hub">${source}</main>`;
    // Happy DOM resolves root tokens but does not inherit custom properties.
    const rootStyle = window.getComputedStyle(window.document.documentElement);
    const hub = window.document.querySelector("main")!;
    for (const [, name] of tokens.matchAll(/(--[\w-]+)\s*:/g)) {
      hub.style.setProperty(name, rootStyle.getPropertyValue(name));
    }
    window.eval(script);
    const pages: FigureEmbedPage[] = [];
    for (const metric of snapshot.metrics) {
      if (metric.status !== "verified" || !Number.isFinite(metric.value) || metric.editorialOverride) continue;
      const button = window.document.querySelector(`[data-open-figure="${metric.id}"]`) as HTMLButtonElement | null;
      if (!button) throw new Error(`Published Data Hub figure unavailable: ${metric.id}`);
      button.click();
      for (const view of ["chart", "number"]) {
        (window.document.querySelector(`input[name="figure-view"][value="${view}"]`) as HTMLInputElement).click();
        const html = (window.document.querySelector("#figure-frame") as HTMLIFrameElement).srcdoc;
        if (!html || /<script\b|<iframe\b/i.test(html)) throw new Error(`Data Hub embed must be script-free: ${metric.id}`);
        const path = revision ? `${revision}/${view}` : view === "number" ? "number" : undefined;
        pages.push({ id: metric.id, snapshot: path, html });
      }
      (window.document.querySelector("#figure-dialog") as HTMLDialogElement).close();
    }
    return pages;
  } finally {
    await window.happyDOM.close();
  }
}

let pages: Promise<FigureEmbedPage[]> | undefined;
export function dataHubEmbedPages(env: Record<string, string | undefined>): Promise<FigureEmbedPage[]> {
  if (!dataHubPageEnabled(env)) return Promise.resolve([]);
  return pages ??= (async () => {
    const current: Snapshot = JSON.parse(reader.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    const published = snapshots[`../data/data-hub-revisions/${current.asOf}.json`];
    if (JSON.stringify(published) !== JSON.stringify(current)) {
      throw new Error("Save the updated Data Hub source under a new snapshot date before publishing embed code.");
    }
    const latest = await renderSnapshot(current, undefined);
    const result = [...latest];
    for (const [path, snapshot] of Object.entries(snapshots).sort(([left], [right]) => left.localeCompare(right))) {
      const revision = path.split("/").at(-1)!.slice(0, -5);
      if (JSON.stringify(snapshot) === JSON.stringify(current)) {
        result.push(...latest.map(page => ({ ...page, snapshot: `${revision}/${page.snapshot ?? "chart"}` })));
      } else {
        result.push(...await renderSnapshot(snapshot, revision));
      }
    }
    return result;
  })();
}
