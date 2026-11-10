import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentEditorDialog } from "../src/components/ComponentEditorDialog";
import { HomePreviewFrame } from "../src/components/HomePreviewFrame";
import { renderHomeEditorialHero } from "../../packages/content-core/src/home-editorial-render";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import { HomeHeroLayoutPreview } from "../src/components/HomeHeroLayoutPreview";
import { HomeShelfLayoutPreview } from "../src/components/HomeShelfLayoutPreview";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import type { HomeHeroConfig } from "../../packages/content-core/src/home-hero";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import type { AdminBlock } from "../src/lib/block-factory";
import postBrandingStyles from "../../packages/content-core/src/post-branding.css?inline";
import currentCatalog from "../../site/tests/fixtures/home-v2-current-catalog.json";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";

// Vitest stubs CSS by default. Keep the canonical bytes for the frame document
// assertion without relying on jsdom to load or lay out an iframe document.
vi.mock("../../packages/content-core/src/post-branding.css?inline", async () => ({
  default: (await import("node:fs")).readFileSync("../packages/content-core/src/post-branding.css", "utf8"),
}));

const published: HomeSourceSnapshot = {
  heroCatalog: [{ id: "native-spotlight", source: "cms_posts", title: "Published native story", summary: "Published summary", href: "/updates/native-spotlight/", categories: [], tags: [], spotlightNews: true, displayDate: "2026-10-08", byline: "Fixture reporter" }],
  schemaVersion: 1,
  publication: { generation: 21, buildBatchId: "published-home-21", commitSha: "a".repeat(40) },
  pbs: { source: "media-manager", checkedAt: null,
    featured: [{ title: "Published featured program", description: "Published description", href: "https://watch.njpbs.org/show/featured/" }],
    more: [{ title: "Published second program", description: "Another program", href: "https://watch.njpbs.org/show/second/" }] },
  spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] },
};

function shelf(): AdminBlock {
  return structuredClone(homeCompositionDefaults().find(block => block.section === "home-featured")!) as AdminBlock;
}

function markup(html: string) {
  return <div data-testid="home-layout-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

const loadPublished = async () => published;

async function previewDocument() {
  await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
  const frame = document.querySelector("iframe")!;
  // jsdom does not load srcdoc. Reproduce the browser document/load boundary.
  const doc = frame.contentDocument!;
  Object.defineProperty(doc, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
  doc.open(); doc.write(frame.srcdoc); doc.close();
  fireEvent.load(frame);
  return doc;
}

const initialWidth = window.innerWidth;
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 }); });
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
  vi.unstubAllGlobals();
});

describe("Home component layout previews", () => {
  it.each([undefined, 844])("retries a failed hero derivative with its original in the %s-height preview", async viewportHeight => {
    const base = "https://media.njpbs.org/cms-media/news/photo/";
    const hash = "a".repeat(64);
    const original = `${base}${hash}.jpg`;
    const html = renderHomeEditorialHero([{ id: "lead", title: "Lead story", summary: "", href: "/posts/lead/",
      image: { url: original, width: 3000, height: 2000,
        thumbnails: [{ url: `${base}thumbs/${hash}-w480.webp`, width: 480, height: 320 }] } }]);
    render(<HomePreviewFrame html={html} title="Hero image retry" viewportHeight={viewportHeight} />);
    const doc = await previewDocument();
    const image = doc.querySelector<HTMLImageElement>("[data-home-hero-image]")!;
    expect(image.getAttribute("srcset")).toContain("-w480.webp 480w");
    expect(image.hasAttribute("sizes")).toBe(true);
    fireEvent.error(image);
    expect(image.getAttribute("src")).toBe(original);
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(image.hasAttribute("sizes")).toBe(false);
    expect(image.hidden).toBe(false);
  });

  it("uses the settled published Post outside the bounded hero catalog in the shared phone renderer", async () => {
    const loadRecord = vi.fn().mockResolvedValue({ status: "ready", record: { version: 8, publiclyVisible: true, publicSourceVersion: 7,
      title: "Private working headline", published: { sourceVersion: 7, metadata: { title: "Older published headline", summary: "Older published summary",
        slug: "older-published-post", date: "2026-09-01", editorialDateSource: "editorial", credits: [{ kind: "custom", name: "Published reporter" }] } } } });
    render(<ContentShelfSources.Provider value={{ loadRecord }}><HomeHeroLayoutPreview value={{ mode: "manual", presentation: "editorial",
      items: [{ itemId: "older", source: "cms_posts", sourceId: "older-post", title: "", summary: "", href: "" }] }} loadSources={loadPublished} /></ContentShelfSources.Provider>);
    const doc = await previewDocument();
    await waitFor(() => expect(doc.body.textContent).toContain("Older published headline"));
    expect(doc.body.textContent).toContain("Older published summary");
    expect(doc.body.textContent).toContain("Published reporter");
    expect(doc.body.textContent).not.toContain("Private working headline");
    expect(doc.querySelector(".home-editorial__lead-link")).toHaveAttribute("href", "/posts/older-published-post/");
  });
  it("keeps v1 on its public rail renderer when the published response also carries a v2 catalog", async () => {
    const source = { ...published, editorial: readHomeEditorialSourceReceipt(currentCatalog) };
    const load = async () => source;
    const view = render(<HomeShelfLayoutPreview block={shelf()} loadSources={load} render={markup} />);
    await screen.findByText("Published featured program", { selector: ".card__title" });
    expect(screen.getByTestId("home-layout-preview").querySelector(".home-curated")).toBeNull();
    expect(screen.getByTestId("home-layout-preview").querySelector(".rail__track")).not.toBeNull();
    view.rerender(<HomeShelfLayoutPreview block={shelf()} homeV2 loadSources={load} render={markup} />);
    await screen.findByText("Painting Community");
    expect(screen.getByTestId("home-layout-preview").querySelector(".home-curated")).not.toBeNull();
    expect(screen.queryByText("Published featured program")).toBeNull();
  });
  it("loads no source cards until the existing phone panel opens and reuses its receipt while fields change", async () => {
    const load = vi.fn(async (_signal: AbortSignal) => published);
    const original = shelf();
    function Dialog({ open, block }: { open: boolean; block: AdminBlock }) {
      return <ComponentEditorDialog open={open} onClose={() => {}} title="Shelf settings"
        preview={<HomeShelfLayoutPreview block={block} loadSources={load} render={markup} />}><p>Editable shelf settings</p></ComponentEditorDialog>;
    }
    const view = render(<Dialog open={false} block={original} />);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Dialog open block={original} />);
    expect(await screen.findByText("Published featured program", { selector: ".card__title" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    const changed = { ...original, data: { ...original.data, title: "A draft shelf heading", presentation: "grid", columns: 3, itemLimit: 6 } };
    view.rerender(<Dialog open block={changed} />);
    expect(screen.getByRole("heading", { name: "A draft shelf heading" })).toBeInTheDocument();
    expect(screen.getByText(/Published cards from generation 21/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Scroll featured programs/ })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Dialog open block={{ ...changed, data: { ...changed.data, title: "" } }} />);
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Dialog open block={changed} />);
    expect(await screen.findByRole("heading", { name: "A draft shelf heading" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    const signal = load.mock.calls[0][0] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Close component preview" }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByTestId("home-layout-preview")).not.toBeInTheDocument();
  });

  it("shows receipt mismatch errors and reloads only when Retry is chosen", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("The Home source and publication receipts do not match."))
      .mockResolvedValueOnce(published);
    render(<HomeShelfLayoutPreview block={shelf()} loadSources={load} render={markup} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Home source and publication receipts do not match.");
    expect(screen.queryByText("Published featured program")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading published cards" }));
    expect(await screen.findByText("Published featured program", { selector: ".card__title" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("waits for the collapsed phone preview to expand on a narrow screen", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const load = vi.fn(async (_signal: AbortSignal) => published);
    render(<ComponentEditorDialog open onClose={() => {}} title="Shelf settings"
      preview={<HomeShelfLayoutPreview block={shelf()} loadSources={load} render={markup} />}><p>Editable shelf settings</p></ComponentEditorDialog>);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expand component preview" }));
    expect(await screen.findByText("Published featured program", { selector: ".card__title" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Collapse component preview" }));
    expect(load.mock.calls[0][0].aborted).toBe(true);
  });

  it("distinguishes source provenance and check time from the published generation", async () => {
    const checkedAt = "2026-10-08T12:00:00.000Z";
    const load = vi.fn().mockResolvedValueOnce({ ...published, pbs: { ...published.pbs, source: "manual" } })
      .mockResolvedValueOnce({ ...published, spotlight: { ...published.spotlight, checkedAt } });
    const original = shelf();
    const view = render(<HomeShelfLayoutPreview block={original} loadSources={load} render={markup} />);
    expect(await screen.findByText(/PBS source: manually selected programs/)).toHaveTextContent("No source check time recorded.");
    expect(screen.getByText(/Published cards from generation 21/)).toBeInTheDocument();
    view.rerender(<HomeShelfLayoutPreview block={{ ...original, section: "home-spotlight", data: { ...original.data, source: "spotlight_news" } }} loadSources={load} render={markup} />);
    const sourceStatus = await screen.findByText(/NJ Spotlight News source: RSS/);
    expect(sourceStatus).toHaveTextContent("Source check time is not the publication time.");
    expect(sourceStatus.querySelector("time")).toHaveAttribute("datetime", checkedAt);
  });

  it("ignores a late source response after the preview changes to another source", async () => {
    let finishFirst!: (value: HomeSourceSnapshot) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<HomeSourceSnapshot>(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ ...published, publication: { ...published.publication!, generation: 22 } });
    const original = shelf();
    const view = render(<HomeShelfLayoutPreview block={original} loadSources={load} render={markup} />);
    const firstSignal = load.mock.calls[0][0] as AbortSignal;
    view.rerender(<HomeShelfLayoutPreview block={{ ...original, section: "home-more", data: { ...original.data, source: "pbs_more" } }} loadSources={load} render={markup} />);
    expect(await screen.findByText("Published second program", { selector: ".card__title" })).toBeInTheDocument();
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { finishFirst(published); });
    expect(screen.getByText(/Published cards from generation 22/)).toBeInTheDocument();
    expect(screen.queryByText("Published featured program")).not.toBeInTheDocument();
  });

  it("uses the shared editorial renderer for every manual story and resolves no browser Post queries", async () => {
    const loadMedia = vi.fn();
    const config: HomeHeroConfig = { mode: "manual", presentation: "editorial", supportingCount: 1,
      items: ["Lead", "Supporting", "Still visible"].map((title, index) => ({ itemId: "story-" + index, title, summary: "Story summary", href: "/updates/story-" + index + "/" })) };
    const view = render(<HomeHeroLayoutPreview loadSources={loadPublished} value={config} loadMedia={loadMedia} />);
    const frame = await previewDocument();
    expect(frame.body.textContent).toContain("Lead");
    expect(frame.body.textContent).toContain("Supporting");
    expect(frame.body.textContent).toContain("Still visible");
    expect(loadMedia).not.toHaveBeenCalled();
    view.rerender(<HomeHeroLayoutPreview loadSources={loadPublished} value={{ mode: "category", source: "cms_posts", value: "Public affairs", presentation: "editorial" }} loadMedia={loadMedia} />);
    expect(screen.getByText(/Open the saved page preview to see the stories selected by this category or tag/)).toBeInTheDocument();
    expect(screen.queryByTestId("home-layout-preview")).not.toBeInTheDocument();
    expect(loadMedia).not.toHaveBeenCalled();
  });

  it("resolves native Post branding and dates by a manual destination without querying draft Posts", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const config: HomeHeroConfig = { mode: "manual", presentation: "editorial", items: [
      { itemId: "manual-native", title: "Manually written headline", summary: "Manually written summary", href: "/updates/native-spotlight/" },
    ] };
    const view = render(<HomeHeroLayoutPreview loadSources={loadPublished} value={config} />);
    const frame = await previewDocument();
    expect(frame.querySelector("[data-publication]")).toHaveAttribute("data-publication", "nj-spotlight-news");
    expect(frame.body.textContent).toContain("Manually written headline");
    expect(frame.body.textContent).not.toContain("Published native story");
    expect(frame.querySelector("time")).toHaveAttribute("datetime", "2026-10-08");
    expect(screen.getByText(/Bylines, dates, publication labels and source artwork come from the published catalog/)).toBeInTheDocument();
    expect(frame.body.textContent).toContain("By Fixture reporter");
    expect(fetch).not.toHaveBeenCalled();

    view.rerender(<HomeHeroLayoutPreview loadSources={loadPublished} value={{ ...config, items: [{ ...config.items![0], href: "/updates/unmatched-story/" }] }} />);
    expect(frame.body.textContent).not.toContain("NJ Spotlight News");
    expect(frame.body.textContent).not.toContain("By Fixture reporter");
    expect(frame.querySelector("time")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes the shared publication-label styles in the actual preview document", async () => {
    const document = window.document.createElement("template");
    document.innerHTML = renderToStaticMarkup(<HomePreviewFrame html="" title="Publication label preview" />);
    const frame = document.content.querySelector("iframe")!;
    expect(frame.srcdoc).toContain(postBrandingStyles);
    expect(postBrandingStyles).toContain(".post-publication--card");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const content = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    expect(content.querySelector('meta[name="referrer"]')!.getAttribute("content")).toBe("no-referrer");
    const policy = content.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    const images = policy.split(";").find(directive => directive.trim().startsWith("img-src"))!.trim().split(/\s+/);
    expect(images).toContain("https://image.pbs.org");
    expect(images).toContain("https://media.njpbs.org");
    expect(images).not.toContain("https:");
  });
});
