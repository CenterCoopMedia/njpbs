import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { HomeHeroEditor } from "../src/components/HomeHeroEditor";
import { publicSiteOrigin } from "../src/lib/dev-origins";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import { RecordForm } from "../src/components/RecordForm";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import type { HomeHeroConfig } from "../../packages/content-core/src/home-hero";

beforeEach(() => vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", undefined));
afterEach(() => vi.unstubAllEnvs());

const published: HomeSourceSnapshot = { schemaVersion: 1, publication: { buildBatchId: "published-home-21", generation: 21, commitSha: "a".repeat(40) },
  pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] },
  heroCatalog: [{ id: "show", source: "media_manager", title: "Painting Community", summary: "Current summary", href: "https://watch.njpbs.org/show/painting-community/", categories: [], tags: [] },
    { id: "post", source: "cms_posts", title: "Current Post headline", summary: "Current Post summary", href: "/posts/current-post/", categories: [], tags: [] }],
};
const loadPublished = async () => published;

function Harness({ initial }: { initial?: HomeHeroConfig }) {
  const [value, setValue] = useState(initial);
  return <HomeHeroEditor value={value} onChange={setValue} loadSources={loadPublished} />;
}
describe("Home hero editor", () => {
  it("shares pins between category and tag selections without restoring removed pins or adding them to manual mode", async () => {
    const changed = vi.fn();
    const pin = { source: "cms_pages" as const, sourceId: "contact", endsAt: "2026-12-01T17:00:00.000Z" };
    function SelectionHarness() {
      const [value, setValue] = useState<HomeHeroConfig>({ mode: "category", source: "cms_posts", value: "News", pins: [pin] });
      return <HomeHeroEditor value={value} onChange={next => { changed(next); setValue(next); }} />;
    }
    render(<SelectionHarness />);
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "tag" } });
    expect(changed.mock.lastCall?.[0].pins).toEqual([pin]);
    fireEvent.change(screen.getByLabelText("Maximum slides"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "category" } });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ value: "News", pins: [pin] });
    fireEvent.click(screen.getByRole("button", { name: "Remove pin 1" }));
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    expect(changed.mock.lastCall?.[0]).not.toHaveProperty("pins");
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "tag" } });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ limit: 7, pins: [] });
  });

  it.each([
    ["page", "manual"], ["post", "manual"],
    ["page", "category"], ["post", "category"],
  ])("ignores a pending %s pin after Selection changes to %s", async (kind, mode) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const pages = [{ id: "contact", title: "Contact", published: true, liveTitle: "Published contact", livePath: "/contact/", liveSourceVersion: 2 }];
    const loadPages = vi.fn().mockResolvedValue(pages);
    const loadRecord = vi.fn(async () => {
      await pending;
      return { status: "ready" as const, record: { publiclyVisible: true, publicSourceVersion: 2,
        published: { sourceVersion: 2, metadata: { title: "Published post", slug: "post" } } } };
    });
    const loadLibrarySelection = vi.fn().mockResolvedValue({ records: [{ id: "post", title: "Published post", liveSourceVersion: 2 }], page: 1, pageCount: 1 });
    render(<ContentShelfSources.Provider value={{ loadPages, loadRecord, loadLibrarySelection }}>
      <Harness initial={{ mode: "tag", source: "cms_posts", value: "home", limit: 10 }} />
    </ContentShelfSources.Provider>);
    const chooser = screen.getByText("Pin published content").closest("details")!;
    chooser.open = true;
    fireEvent(chooser, new Event("toggle"));
    await screen.findByRole("button", { name: "Pin Published contact" });
    if (kind === "page") {
      loadPages.mockImplementation(() => pending.then(() => pages));
    } else {
      fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "post" } });
      fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    }
    const pageReads = loadPages.mock.calls.length;
    fireEvent.click(await screen.findByRole("button", { name: kind === "page" ? "Pin Published contact" : "Pin Published post" }));
    if (kind === "page") expect(loadPages).toHaveBeenCalledTimes(pageReads + 1);
    else expect(loadRecord).toHaveBeenCalledWith("post", "post");
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: mode } });
    if (mode === "manual") {
      fireEvent.click(screen.getByRole("button", { name: "Add a slide with a URL" }));
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep my newer manual edit" } });
    } else {
      fireEvent.change(screen.getByLabelText("Maximum slides"), { target: { value: "7" } });
    }
    await act(async () => finish());
    expect(screen.getByLabelText("Selection")).toHaveValue(mode);
    if (mode === "manual") expect(screen.getByLabelText("Title")).toHaveValue("Keep my newer manual edit");
    else {
      expect(screen.getByLabelText("Maximum slides")).toHaveValue("7");
      expect(screen.getByText("No pins. All stories fill automatically.")).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "tag" } });
    expect(screen.getByText("No pins. All stories fill automatically.")).toBeInTheDocument();
  });

  it("pins only published Pages and Posts, caps at three, reorders, removes and saves Eastern expiry in the Home dialog", async () => {
    const save = vi.fn();
    const loadPages = vi.fn().mockResolvedValue([
      { id: "contact", title: "PRIVATE draft", published: true, liveTitle: "Published contact", livePath: "/contact/", liveSourceVersion: 2 },
      { id: "watch", title: "Unpublished watch", published: false },
    ]);
    const loadRecord = vi.fn(async (kind: string, id: string) => ({ status: "ready" as const, record: {
      title: "PRIVATE draft", version: 3, publiclyVisible: true, publicSourceVersion: 2,
      published: { sourceVersion: 2, metadata: { title: kind === "page" ? "Published contact" : `Published ${id}`, slug: id, categories: [], tags: [] } },
    } }));
    const loadLibrarySelection = vi.fn().mockResolvedValue({ records: [
      { id: "one", title: "Published one", liveSourceVersion: 2 }, { id: "two", title: "Published two", liveSourceVersion: 2 },
      { id: "three", title: "Published three", liveSourceVersion: 2 }, { id: "draft", title: "Draft only" },
    ], page: 1, pageCount: 1 });
    render(<ContentShelfSources.Provider value={{ loadPages, loadRecord, loadLibrarySelection }}>
      <RecordForm canSave kind="page" pageId="home" initial={{ title: "Home", homeHeroTitle: "NJ PBS", homeHeroSubtitle: "New Jersey stories", homeHero: { mode: "tag", source: "cms_posts", value: "home", limit: 10 } }} onSave={save} />
    </ContentShelfSources.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    fireEvent.click(screen.getByText("Pin published content"));
    const chooser = screen.getByText("Pin published content").closest("details")!;
    chooser.open = true;
    fireEvent(chooser, new Event("toggle"));
    fireEvent.click(await screen.findByRole("button", { name: "Pin Published contact" }));
    await waitFor(() => expect(screen.getByLabelText("Content type")).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Pin Unpublished watch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pin Watch" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "post" } });
    fireEvent.change(screen.getByLabelText("Find content"), { target: { value: "Published" } });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pin Published one" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin Published two" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Pin Published two" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin Published three" })).toBeDisabled());
    expect(screen.queryByRole("button", { name: "Pin Draft only" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move pin 3 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove pin 3" }));
    fireEvent.change(screen.getByLabelText("Pin 1 end time (Eastern)"), { target: { value: "2026-11-04T20:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].homeHero).toEqual({ mode: "tag", source: "cms_posts", value: "home", limit: 10, pins: [
      { source: "cms_pages", sourceId: "contact", endsAt: "2026-11-05T01:30:00.000Z" }, { source: "cms_posts", sourceId: "two" },
    ] });
    expect(loadLibrarySelection).toHaveBeenCalledWith(expect.objectContaining({ q: "Published", types: ["post"] }));
  });
  it("saves several hero tags through the existing Home dialog and keeps the single value until edited", async () => {
    const save = vi.fn();
    render(<RecordForm canSave kind="page" pageId="home" initial={{ title: "Home", homeHeroTitle: "NJ PBS", homeHeroSubtitle: "New Jersey stories", homeHero: {
      mode: "tag", source: "cms_posts", value: "announcement", limit: 10,
    } }} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    const input = screen.getByRole("combobox", { name: "Home hero tags" });
    expect(screen.getByRole("button", { name: "Remove tag announcement" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "home,hero,main,Home," } });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag hero" }));
    fireEvent.change(input, { target: { value: "hero" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "breaking" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
    await screen.findByRole("dialog", { name: "Home hero" });
    expect(input).toHaveValue("breaking");
    expect(screen.getByText("Finish the Home hero tag with Enter or a comma, or clear the text.")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].homeHero).toEqual({ mode: "tag", source: "cms_posts", values: ["announcement", "home", "main", "Home", "hero", "breaking"], limit: 10 });
  });

  it("updates the default button guidance when a PBS URL is pasted without binding a provider", () => {
    const changed = vi.fn();
    function ManualHarness() {
      const [value, setValue] = useState<HomeHeroConfig>({ mode: "manual", presentation: "editorial", items: [{
        itemId: "manual-video", title: "Manual report", summary: "", href: "/posts/story/",
      }] });
      return <HomeHeroEditor value={value} onChange={next => { changed(next); setValue(next); }} loadSources={loadPublished} />;
    }
    render(<ManualHarness />);
    const input = screen.getByRole("textbox", { name: "Story button text" });
    const destination = screen.getByLabelText("Destination URL");
    expect(input).toHaveAttribute("placeholder", "Read the story");
    fireEvent.change(destination, { target: { value: "https://watch.njpbs.org/video/report/" } });
    expect(input).toHaveAttribute("placeholder", "Watch the report");
    expect(screen.getByText(/Leave blank to use Watch the report/)).toBeVisible();
    expect(changed.mock.lastCall?.[0].items[0]).toEqual({ itemId: "manual-video", title: "Manual report", summary: "",
      href: "https://watch.njpbs.org/video/report/" });
    fireEvent.change(input, { target: { value: "Watch this story" } });
    fireEvent.change(destination, { target: { value: "https://watch.njpbs.org.example.test/video/report/" } });
    expect(input).toHaveValue("Watch this story");
    expect(input).toHaveAttribute("placeholder", "Read the story");
    expect(screen.getByText(/Leave blank to use Read the story/)).toBeVisible();
  });

  it("edits an optional short button label in editorial mode and follows the source default when cleared", () => {
    render(<Harness initial={{ mode: "manual", presentation: "editorial", items: [{
      itemId: "button-story", title: "Story", summary: "", href: "/posts/story/",
    }] }} />);
    const input = screen.getByRole("textbox", { name: "Story button text" });
    expect(input).toHaveAttribute("maxlength", "80");
    expect(input).toHaveAttribute("placeholder", "Read the story");
    fireEvent.change(input, { target: { value: "Read more about New Jersey" } });
    expect(input).toHaveValue("Read more about New Jersey");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(screen.getByText(/Leave blank to use Read the story/)).toBeVisible();
  });

  it("hides layout fields and never emits their keys when Home layouts are disabled", () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    const changed = vi.fn();
    const item = { itemId: "keep", title: "Keep this", summary: "Keep summary", href: "/watch/" };
    function GuardedHarness() {
      const [value, setValue] = useState<HomeHeroConfig>({ mode: "manual", items: [item],
        presentation: "editorial", supportingCount: 2, supportingHeading: "Latest", overflowHeading: "More" });
      return <HomeHeroEditor value={value} onChange={next => { changed(next); setValue(next); }} />;
    }
    render(<GuardedHarness />);
    for (const label of ["Hero layout", "Supporting headlines", "Supporting heading", "More-stories heading"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "category" } });
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    expect(changed).toHaveBeenLastCalledWith({ mode: "manual", items: [item] });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a slide with a URL" }));
    for (const [value] of changed.mock.calls) {
      for (const key of ["presentation", "supportingCount", "leadHeading", "supportingHeading", "overflowHeading"]) {
        expect(value).not.toHaveProperty(key);
      }
    }
    expect(changed.mock.lastCall?.[0].items[0].title).toBe("Updated title");
  });

  it("starts a hero without layout keys when Home layouts are disabled", () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    const changed = vi.fn();
    render(<HomeHeroEditor value={undefined} onChange={changed} />);
    expect(screen.queryByLabelText("Hero layout")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    expect(changed).toHaveBeenCalledWith({ mode: "manual", items: [] });
  });

  it("adds a pasted URL, reorders slides and enforces the ten-slide cap", () => {
    render(<Harness initial={{ mode: "manual", items: Array.from({ length: 9 }, (_, index) => ({ itemId: `item-${index}`, title: `Title ${index}`, summary: "", href: `/page-${index}/` })) }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a slide with a URL" }));
    expect(screen.getByRole("button", { name: "Add a slide with a URL" })).toBeDisabled();
    fireEvent.change(screen.getAllByLabelText("Title")[9], { target: { value: "New link" } });
    fireEvent.change(screen.getAllByLabelText("Destination URL")[9], { target: { value: "https://watch.njpbs.org/" } });
    fireEvent.click(screen.getByRole("button", { name: "Move slide 10 up" }));
    expect(screen.getAllByLabelText("Title")[8]).toHaveValue("New link");
  });
  it("loads only the published provider catalog and adds a selected item", async () => {
    render(<Harness initial={{ mode: "manual", items: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Load source catalog" }));
    const add = await screen.findByRole("button", { name: "Add Painting Community" });
    fireEvent.click(add);
    fireEvent.click(await screen.findByRole("button", { name: "Add Painting Community" }));
    expect(screen.getByText("This destination is already in the hero. Edit its existing slide below.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find a source item"), { target: { value: "no such source title" } });
    expect(screen.getByText(/No source items match/)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Painting Community");
    expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Painting Community");
    expect(screen.getByLabelText("Destination URL")).toHaveValue("https://watch.njpbs.org/show/painting-community/");
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Hero preview" })).toHaveTextContent("Painting Community"));
  });
  it("resolves bound hero overrides, resets each field and drops withdrawal in the same preview", async () => {
    render(<Harness initial={{ mode: "manual", items: [{ itemId: "bound", source: "cms_posts", sourceId: "post", title: "Home headline", summary: "Home summary", href: "/overridden-link/" }] }} />);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    expect(await preview.findByText("Home headline")).toBeInTheDocument();
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", `${publicSiteOrigin}/overridden-link/`);
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("target", "_blank");
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("rel", "noopener noreferrer");
    for (const field of ["title", "summary", "destination"]) fireEvent.click(screen.getByRole("button", { name: `Use story’s current ${field}` }));
    expect(preview.getByText("Current Post headline")).toBeInTheDocument();
    expect(preview.getByText("Current Post summary")).toBeInTheDocument();
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", `${publicSiteOrigin}/posts/current-post/`);
  });
  it("keeps an absent provider's saved copy and explains unavailable provider artwork", async () => {
    render(<HomeHeroEditor value={{ mode: "manual", items: [{ itemId: "saved-provider", source: "spotlight", sourceId: "rotated-story", title: "Saved provider headline", summary: "Saved provider summary", href: "https://www.njspotlightnews.org/rotated-story/" }] }} onChange={() => {}} loadSources={loadPublished} />);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    expect(await preview.findByText(/no longer in the provider feed/)).toBeVisible();
    expect(preview.getByText("Saved provider headline")).toBeVisible();
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", "https://www.njspotlightnews.org/rotated-story/");
    expect(preview.queryByText(/missing or withdrawn/)).toBeNull();
    expect(preview.getByText(/provider image is no longer available/)).toBeVisible();
  });
  it("releases catalog loading when the last source-bound story is removed", async () => {
    const load = vi.fn((signal: AbortSignal) => new Promise<HomeSourceSnapshot>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    function LoadingHero() {
      const [value, setValue] = useState<HomeHeroConfig>({ mode: "manual", items: [{ itemId: "loading", source: "cms_posts", sourceId: "post", title: "Saved headline", summary: "", href: "/posts/current-post/" }] });
      return <HomeHeroEditor value={value} onChange={setValue} loadSources={load} />;
    }
    render(<LoadingHero />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove slide 1" }));
    fireEvent.click(screen.getByText("Add from an API source"));
    expect(screen.getByRole("button", { name: "Load source catalog" })).toBeEnabled();
    expect(load.mock.calls[0][0].aborted).toBe(true);
  });
  it("resolves a newly picked older Post outside the bounded transport from settled published fields", async () => {
    const loadRecord = vi.fn().mockResolvedValue({ status: "ready", record: { version: 8, publiclyVisible: true, publicSourceVersion: 7,
      title: "Private draft headline", summary: "Private draft summary", published: { sourceVersion: 7, metadata: {
        title: "Older published headline", summary: "Older published summary", slug: "older-published-post", date: "2026-09-01", editorialDateSource: "editorial",
        credits: [{ kind: "custom", name: "Published reporter" }], heroImage: "older-image", heroImageAlt: "Published artwork", categories: [], tags: [],
      } } } });
    const loadMedia = vi.fn().mockResolvedValue({ records: [{ id: "older-image", url: "/older-image.jpg", mimeType: "image/jpeg" }], page: 1, pageCount: 1 });
    render(<ContentShelfSources.Provider value={{ loadRecord }}><HomeHeroEditor value={{ mode: "manual", items: [{ itemId: "older", source: "cms_posts", sourceId: "older-post", title: "", summary: "", href: "" }] }} onChange={() => {}} loadSources={loadPublished} loadMedia={loadMedia} /></ContentShelfSources.Provider>);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    expect(await preview.findByText("Older published headline")).toBeInTheDocument();
    expect(preview.getByText("Older published summary")).toBeInTheDocument();
    expect(preview.getByRole("link", { name: "View story" })).toHaveAttribute("href", `${publicSiteOrigin}/posts/older-published-post/`);
    expect(preview.getByRole("img", { name: "Published artwork" })).toHaveAttribute("src", expect.stringContaining("/older-image.jpg"));
    expect(screen.queryByText("Private draft headline")).not.toBeInTheDocument();
    expect(preview.queryByText(/missing or withdrawn/)).not.toBeInTheDocument();
    expect(loadRecord).toHaveBeenCalledWith("post", "older-post");
  });
  it("does not call an unverified Post withdrawn when its published read fails", async () => {
    const loadRecord = vi.fn().mockRejectedValue(new Error("Temporary read failure"));
    render(<ContentShelfSources.Provider value={{ loadRecord }}><HomeHeroEditor value={{ mode: "manual", items: [{ itemId: "older", source: "cms_posts", sourceId: "older-post", title: "", summary: "", href: "" }] }} onChange={() => {}} loadSources={loadPublished} /></ContentShelfSources.Provider>);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    await waitFor(() => expect(loadRecord).toHaveBeenCalled());
    expect(preview.queryByText(/missing or withdrawn/)).not.toBeInTheDocument();
    expect(preview.getByText(/could not be verified/)).toBeInTheDocument();
  });
  it("writes native identity when picking a Post without copying its current fields", async () => {
    const changed = vi.fn();
    const loadLibrarySelection = vi.fn().mockResolvedValue({ records: [{ id: "post", title: "Public Post", liveSourceVersion: 2 }], page: 1, pageCount: 1 });
    const loadRecord = vi.fn().mockResolvedValue({ status: "ready", record: { version: 2, publiclyVisible: true, publicSourceVersion: 2,
      published: { sourceVersion: 2, metadata: { title: "Public Post", slug: "current-post", summary: "Published summary" } } } });
    render(<ContentShelfSources.Provider value={{ loadLibrarySelection, loadRecord }}><HomeHeroEditor value={{ mode: "manual", items: [] }} onChange={changed} loadSources={loadPublished} /></ContentShelfSources.Provider>);
    fireEvent.change(screen.getByLabelText("Content type"), { target: { value: "post" } });
    fireEvent.click(screen.getByRole("button", { name: "Search posts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Public Post" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith({ mode: "manual", items: [expect.objectContaining({ source: "cms_posts", sourceId: "post", title: "", summary: "", href: "" })] }));
  });
  it("warns for a withdrawn identity even when its Home override points elsewhere", async () => {
    const loadRecord = vi.fn().mockResolvedValue({ status: "missing" });
    render(<ContentShelfSources.Provider value={{ loadRecord }}><Harness initial={{ mode: "manual", items: [{ itemId: "gone", source: "cms_posts", sourceId: "withdrawn", title: "Home headline", summary: "", href: "/other/" }] }} /></ContentShelfSources.Provider>);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    expect(await preview.findByText(/missing or withdrawn/)).toBeInTheDocument();
    expect(preview.queryByRole("link")).not.toBeInTheDocument();
  });
  it("retains manual draft values while changing selection modes", () => {
    render(<Harness initial={{ mode: "manual", items: [{ itemId: "keep", title: "Keep this", summary: "Keep summary", href: "/watch/" }] }} />);
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "category" } });
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this");
    expect(screen.getByLabelText("Summary")).toHaveValue("Keep summary");
  });
  it("preserves editorial layout details and manual choices across selection and layout changes", () => {
    render(<Harness initial={{ mode: "manual", items: [{ itemId: "keep", title: "Keep this", summary: "Keep summary", href: "/watch/" }] }} />);
    fireEvent.change(screen.getByLabelText("Hero layout"), { target: { value: "editorial" } });
    fireEvent.change(screen.getByLabelText("Supporting headlines"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Supporting heading"), { target: { value: "Latest from New Jersey" } });
    fireEvent.change(screen.getByLabelText("More-stories heading"), { target: { value: "Keep reading" } });
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "category" } });
    expect(screen.getByLabelText("Hero layout")).toHaveValue("editorial");
    expect(screen.getByLabelText("Supporting headlines")).toHaveValue("2");
    fireEvent.change(screen.getByLabelText("Hero layout"), { target: { value: "carousel" } });
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    expect(screen.getByLabelText("Hero layout")).toHaveValue("carousel");
    fireEvent.change(screen.getByLabelText("Hero layout"), { target: { value: "editorial" } });
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this");
    expect(screen.getByLabelText("Summary")).toHaveValue("Keep summary");
    expect(screen.getByLabelText("Supporting headlines")).toHaveValue("2");
    expect(screen.getByLabelText("Supporting heading")).toHaveValue("Latest from New Jersey");
    expect(screen.getByLabelText("More-stories heading")).toHaveValue("Keep reading");
  });
  it("saves editorial settings through the existing metadata owner and refuses retained read-only callbacks", async () => {
    const save = vi.fn();
    const initial = { title: "Home", homeHeroTitle: "Original heading", homeHeroSubtitle: "Original subtitle",
      homeHero: { mode: "manual", items: [{ itemId: "lead", title: "A published story", summary: "A summary", href: "/updates/a-published-story/" }] } };
    const view = render(<RecordForm canSave kind="page" pageId="home" initial={initial} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    fireEvent.change(screen.getByLabelText("Hero layout"), { target: { value: "editorial" } });
    fireEvent.change(screen.getByLabelText("Supporting headlines"), { target: { value: "1" } });
    const heading = screen.getByLabelText("Supporting heading");
    fireEvent.change(heading, { target: { value: "Latest stories from NJ" } });
    view.rerender(<RecordForm canSave kind="page" pageId="home" initial={initial} onSave={save} readOnly />);
    expect(screen.queryByRole("dialog", { name: "Home hero" })).not.toBeInTheDocument();
    expect(heading).toBeDisabled();
    fireEvent.change(heading, { target: { value: "Should not replace the draft" } });
    view.rerender(<RecordForm canSave kind="page" pageId="home" initial={initial} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({
      homeHeroTitle: "Original heading", homeHeroSubtitle: "Original subtitle",
      homeHero: { presentation: "editorial", supportingCount: 1, supportingHeading: "Latest stories from NJ",
        items: [{ itemId: "lead", title: "A published story" }] },
    });
  });
  it("offers classifications only from settled published Post metadata", async () => {
    const loadLibrarySelection = vi.fn().mockResolvedValue({ records: [{ id: "post", liveSourceVersion: 2 }], page: 1, pageCount: 1 });
    const loadRecord = vi.fn().mockResolvedValue({ status: "ready", record: { version: 3, publiclyVisible: true, publicSourceVersion: 2,
      published: { sourceVersion: 2, metadata: { title: "Public title", slug: "public-title", categories: ["Public category"], tags: ["Public tag"] } },
      categories: ["Private draft category"], tags: ["Private draft tag"] } });
    render(<ContentShelfSources.Provider value={{ loadLibrarySelection, loadRecord }}><Harness initial={{ mode: "category", source: "cms_posts", value: "" }} /></ContentShelfSources.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Load available classifications" }));
    expect(await screen.findByRole("option", { name: "Public category" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Private draft category" })).not.toBeInTheDocument();
  });
  it("keeps moved hero controls in the single metadata save and read-only boundary", async () => {
    const save = vi.fn();
    const reveal = vi.fn();
    function Workspace({ readOnly = false }: { readOnly?: boolean }) {
      const [target, setTarget] = useState<HTMLDivElement | null>(null);
      return <><section aria-label="Page content"><div ref={setTarget} /></section>
        <section aria-label="Page metadata"><RecordForm canSave kind="page" pageId="home"
          homeHeroTarget={target} onRevealField={reveal} readOnly={readOnly}
          initial={{ title: "Home", homeHeroTitle: "Original heading", homeHeroSubtitle: "Original subtitle" }} onSave={save} /></section></>;
    }
    const view = render(<Workspace />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    const main = within(screen.getByRole("region", { name: "Page content" }));
    const sidebar = within(screen.getByRole("region", { name: "Page metadata" }));
    expect(sidebar.queryByLabelText("Selection")).not.toBeInTheDocument();
    expect(main.getByLabelText("Background crop position")).toBeInTheDocument();
    fireEvent.change(main.getByLabelText("Selection"), { target: { value: "manual" } });
    fireEvent.click(main.getByRole("button", { name: "Add a slide with a URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(sidebar.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith("homeHero", expect.stringContaining("hero-selection"));
    expect(main.getByLabelText("Selection")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.change(sidebar.getByRole("textbox", { name: /^Page title/ }), { target: { value: "Home updated" } });
    expect(screen.queryByRole("dialog", { name: "Home hero" })).not.toBeInTheDocument();
    fireEvent.click(sidebar.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("dialog", { name: "Home hero" })).toBeInTheDocument();
    expect(main.getByLabelText("Selection")).toHaveFocus();
    fireEvent.change(main.getByLabelText("Title"), { target: { value: "Selected title" } });
    fireEvent.change(main.getByLabelText("Destination URL"), { target: { value: "/watch/" } });
    fireEvent.change(main.getByRole("textbox", { name: /^Hero heading/ }), { target: { value: "New fallback" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(sidebar.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ title: "Home updated", homeHeroTitle: "New fallback", homeHero: { items: [{ title: "Selected title", href: "/watch/" }] } });
    view.rerender(<Workspace readOnly />);
    expect(main.getByLabelText("Selection")).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "Home hero" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Home hero" })).toBeDisabled();
    expect(main.getByLabelText("Background crop position")).toBeDisabled();
  });
  it("persists hero-only edits through the existing metadata form while retaining fallback text", async () => {
    const save = vi.fn();
    render(<RecordForm canSave kind="page" pageId="home" initial={{ title: "Home", homeHeroTitle: "Original heading", homeHeroSubtitle: "Original subtitle" }} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Home hero" }));
    fireEvent.change(screen.getByLabelText("Selection"), { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a slide with a URL" }));
    const titles = screen.getAllByLabelText("Title");
    fireEvent.change(titles[titles.length - 1], { target: { value: "Selected title" } });
    fireEvent.change(screen.getByLabelText("Destination URL"), { target: { value: "/watch/" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ homeHeroTitle: "Original heading", homeHeroSubtitle: "Original subtitle", homeHero: { mode: "manual", items: [{ title: "Selected title", href: "/watch/" }] } });
  });
});

describe("bounded Post artwork guidance (#3613)", () => {
  it.each([
    ["generated only", { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "Current video" } }, null],
    ["explicit poster", { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "Current video" }, posterAssetId: "poster-image" }, "poster-image"],
    ["cleared", null, null],
    ["replaced image", { kind: "image", data: { assetId: "replacement-image", alt: "Replacement" } }, "replacement-image"],
  ])("resolves %s through the actual Home consumer without reviving old artwork", async (_name, leadMedia, imageId) => {
    const loadRecord = async () => ({ status: "ready" as const, record: { publiclyVisible: true, publicSourceVersion: 7,
      published: { sourceVersion: 7, metadata: { title: "Older video story", slug: "older-video-story", heroImage: "stale-image", heroImageAlt: "Stale image", leadMedia } } } });
    const loadMedia = vi.fn().mockResolvedValue({ records: [{ id: imageId, url: `/${imageId}.jpg`, mimeType: "image/jpeg" }], page: 1, pageCount: 1 });
    render(<ContentShelfSources.Provider value={{ loadRecord }}><HomeHeroEditor
      value={{ mode: "manual", items: [{ itemId: "older", source: "cms_posts", sourceId: "older-video", title: "", summary: "", href: "" }] }}
      onChange={() => {}} loadSources={loadPublished} loadMedia={loadMedia} /></ContentShelfSources.Provider>);
    const preview = within(screen.getByRole("complementary", { name: "Hero preview" }));
    await preview.findByText("Older video story");
    expect(preview.queryByRole("img", { name: "Stale image" })).not.toBeInTheDocument();
    if (imageId) {
      expect(preview.getByRole("img")).toHaveAttribute("src", expect.stringContaining(`/${imageId}.jpg`));
      expect(screen.queryByText(/The source image is unavailable in this preview/)).not.toBeInTheDocument();
    } else {
      expect(screen.getByText(/The source image is unavailable in this preview/)).toBeVisible();
      expect(loadMedia).not.toHaveBeenCalled();
    }
  });
});
