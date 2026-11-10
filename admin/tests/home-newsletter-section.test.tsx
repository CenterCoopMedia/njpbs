import { HomeNewsletterEditor, HomeNewsletterPreview } from "../src/components/HomeNewsletterEditor";
import { renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { EditorWorkspace, type PageContent } from "../src/components/EditorWorkspace";
import { createHomeNewsletterBlock } from "../../packages/content-core/src/home-newsletter-section";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { BlockPreview } from "../src/components/BlockPreview";
import type { AdminBlock } from "../src/lib/block-factory";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";
import copy from "../../site/tests/fixtures/home-sources/newsletter-public-copy.json";
const loadSources = async (): Promise<HomeSourceSnapshot> => ({ schemaVersion: 1, pbs: { source: "manual", checkedAt: fixture.editorial.catalog.cutoffAt, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: fixture.editorial.catalog.cutoffAt, cards: [] },
  publication: fixture.editorial.receipt, editorial: readHomeEditorialSourceReceipt({ ...fixture.editorial,
  catalog: { ...fixture.editorial.catalog, services: { newsletters: createHomeNewsletterSnapshot([{
    id: "published-newsletter", kind: "newsletter", href: null, sourceVersion: 1,
    newsletter: { card: { title: copy.title, summary: copy.summary, signupUrl: copy.signupUrl } },
  }], fixture.editorial.catalog.cutoffAt, fixture.editorial.catalog.cutoffAt) } } }) });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
function SavedHome() {
  const [saved, setSaved] = useState(structuredClone(v1.blocks) as AdminBlock[]), [reopen, setReopen] = useState(0);
  return <><BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2} initialBlocks={saved} loadHomeSources={loadSources}
    allowIncomplete commandsInline onSave={async blocks => { setSaved(blocks); }} />
    <button onClick={() => setReopen(value => value + 1)}>Reopen fixture</button><output data-testid="saved">{JSON.stringify(saved)}</output></>;
}
describe("Boardwalk single published Newsletter bar", () => {
  it("describes the standard band only for a visible empty section in the settings and canvas", () => {
    const block = createHomeNewsletterBlock("empty-editor-newsletter") as unknown as AdminBlock;
    const settingsAndCanvas = (visible: boolean) => <>
      <HomeNewsletterEditor block={{ ...block, visible }} readOnly={false} onChange={() => {}} loadSources={loadSources} />
      <BlockPreview block={{ ...block, visible }} />
    </>;
    const view = render(settingsAndCanvas(true));
    expect(screen.getAllByText("The standard newsletter band appears until a newsletter is chosen.")).toHaveLength(2);
    view.rerender(settingsAndCanvas(false));
    expect(screen.queryByText("The standard newsletter band appears until a newsletter is chosen.")).not.toBeInTheDocument();
    expect(screen.getByText("This section is hidden.")).toBeVisible();
  });
  it("shows the public standard band in the phone preview without loading a catalog, with guidance outside its HTML", () => {
    const block = createHomeNewsletterBlock("empty-phone-newsletter");
    const load = vi.fn(loadSources), renderBand = vi.fn((html: string) => <div data-testid="phone-band" dangerouslySetInnerHTML={{ __html: html }} />);
    const view = render(<HomeNewsletterPreview block={block as unknown as AdminBlock} loadSources={load} render={renderBand} />);
    expect(renderBand).toHaveBeenCalledWith(renderHomeNewsletter(block, undefined));
    const band = screen.getByTestId("phone-band");
    expect(within(band).getByRole("heading", { name: "Get the NJ PBS email newsletter" })).toBeVisible();
    expect(within(band).getByRole("link", { name: "Sign up by email" })).toHaveAttribute("href", "https://njpbs.bluelena.io/f/1");
    expect(within(band).queryByText("The standard newsletter band appears until a newsletter is chosen.")).not.toBeInTheDocument();
    expect(screen.getByText("The standard newsletter band appears until a newsletter is chosen.")).toBeVisible();
    expect(load).not.toHaveBeenCalled();
    view.rerender(<HomeNewsletterPreview block={{ ...block, visible: false } as unknown as AdminBlock} loadSources={load} render={renderBand} />);
    expect(screen.queryByTestId("phone-band")).not.toBeInTheDocument();
    expect(screen.queryByText("The standard newsletter band appears until a newsletter is chosen.")).not.toBeInTheDocument();
  });
  it.each([{ newsletterIds: [] }, { newsletterIds: ["published-newsletter"] }])("names the hidden Newsletter phone state without loading sources for $newsletterIds", ({ newsletterIds }) => {
    const block = createHomeNewsletterBlock("hidden-phone-newsletter");
    const load = vi.fn(loadSources), renderBand = vi.fn(() => null);
    render(<HomeNewsletterPreview block={{ ...block, visible: false,
      data: { ...block.data, newsletterIds, ...(newsletterIds.length ? { selectionReceipt: fixture.editorial.receipt } : {}) },
    } as unknown as AdminBlock} loadSources={load} render={renderBand} />);
    expect(screen.getByRole("status")).toHaveTextContent("Newsletter signup is hidden from the page.");
    expect(renderBand).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("names an incomplete empty Newsletter phone state when its draft cannot render", () => {
    const block = createHomeNewsletterBlock("incomplete-phone-newsletter");
    render(<HomeNewsletterPreview block={{ ...block, data: { ...block.data, actionLabel: "\t" } } as unknown as AdminBlock}
      loadSources={loadSources} render={() => null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Complete the Newsletter signup fields to preview this section.");
  });
  it("updates the publication warning after selecting, saving, clearing and saving the Newsletter", async () => {
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "true");
    let saved: PageContent = { blocks: [...structuredClone(v1.blocks), createHomeNewsletterBlock("empty-newsletter")] as AdminBlock[],
      version: 7, status: "draft", homeCompositionVersion: 2, metadata: { title: "Home" } };
    const savePage = vi.fn(async (_pageId, _section, blocks): Promise<PageContent> => {
      saved = { ...saved, blocks, version: saved.version! + 1 };
      return saved;
    });
    render(<EditorWorkspace principal={{ id: "editor", grants: [{ role: "admin" }] }}
      surface={{ kind: "page", pageId: "home", section: "home" }} loadPage={async () => saved}
      loadHomeSources={loadSources} savePage={savePage} />);
    const warning = "Publishing shows the standard newsletter band until a newsletter is chosen.";
    expect(await screen.findByText(warning)).toBeInTheDocument();
    for (const [selection, saveCount] of [["published-newsletter", 1], ["", 2]] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Edit Newsletter signup" }));
      const dialog = screen.getByRole("dialog", { name: "Newsletter signup" });
      const picker = within(dialog).getByRole("combobox", { name: "Published Newsletter" });
      await waitFor(() => expect(picker).toBeEnabled());
      fireEvent.change(picker, { target: { value: selection } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
      fireEvent.click(screen.getByRole("button", { name: "Save page" }));
      await waitFor(() => expect(savePage).toHaveBeenCalledTimes(saveCount));
      await waitFor(() => selection ? expect(screen.queryByText(warning)).not.toBeInTheDocument()
        : expect(screen.getByText(warning)).toBeInTheDocument());
    }
  });
  it("keeps generic multi-card Newsletter insertion out of unversioned Home", () => {
    render(<BlockEditor section="home" pageId="home" initialBlocks={[]} commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: "Add block: position 1" }));
    const picker = screen.getByRole("group", { name: "Blocks to insert at position 1" });
    expect(within(picker).queryByRole("button", { name: "newsletter signup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Newsletter signup", hidden: true })).not.toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "text" })).toBeInTheDocument();
  });
  it("adds, selects one published record, edits copy, moves, saves/reopens and restores the same withdrawn identity", async () => {
    render(<SavedHome />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Newsletter signup" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Newsletter signup" }));
    const dialog = screen.getByRole("dialog", { name: "Newsletter signup" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Published Newsletter" })).toBeEnabled());
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Published Newsletter" }), { target: { value: "published-newsletter" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Heading" }), { target: { value: "Our\temail updates" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Summary" }), { target: { value: "Local\nstation\tupdates" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Button text" }), { target: { value: "Get\tupdates" } });
    expect(within(dialog).getAllByRole("combobox")).toHaveLength(1);
    expect(within(dialog).queryByRole("textbox", { name: /URL|signup link|artwork/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const plank = document.querySelector<HTMLElement>('[data-home-section="home-newsletter"]')!;
    fireEvent.keyDown(within(plank).getByRole("button", { name: /^Move:/ }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).find((block: AdminBlock) => block.section === "home-newsletter").data.intro).toBe("Local station updates"));
    const saved = JSON.parse(screen.getByTestId("saved").textContent!);
    expect(saved.findIndex((block: AdminBlock) => block.section === "home-newsletter")).toBe(3);
    const newsletter = saved.find((block: AdminBlock) => block.section === "home-newsletter");
    expect(newsletter.data).toMatchObject({ newsletterIds: ["published-newsletter"], heading: "Our email updates", actionLabel: "Get updates", selectionReceipt: fixture.editorial.receipt });
    fireEvent.click(screen.getByRole("button", { name: "Reopen fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Newsletter signup" }));
    const reopened = screen.getByRole("dialog", { name: "Newsletter signup" });
    expect(within(reopened).getByRole("textbox", { name: "Heading" })).toHaveValue("Our email updates");
    expect(within(reopened).getByRole("textbox", { name: "Button text" })).toHaveValue("Get updates");
    fireEvent.click(within(reopened).getByRole("button", { name: /^Remove section from page/ }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Newsletter signup Restore hidden section" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).filter((block: AdminBlock) => block.section === "home-newsletter")).toEqual([newsletter]));
  });
  it("keeps a saved selection's availability unknown during loading/failure and a pasted heading cannot crash the picker", async () => {
    const block = { ...createHomeNewsletterBlock("saved-bar"), data: { newsletterIds: ["published-newsletter"],
      actionLabel: "Sign up by email", heading: "Pasted\theading", selectionReceipt: fixture.editorial.receipt } } as AdminBlock;
    const pending = render(<HomeNewsletterEditor block={block} readOnly={false} onChange={() => {}} loadSources={() => new Promise(() => {})} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading published Newsletters");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Saved Newsletter: published-newsletter" })).toBeInTheDocument();
    pending.unmount();
    const failed = render(<HomeNewsletterEditor block={block} readOnly={false} onChange={() => {}} loadSources={async () => { throw new Error("network boundary"); }} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
    expect(screen.queryByText(/will not appear on Home/)).not.toBeInTheDocument();
    failed.unmount();
    render(<HomeNewsletterEditor block={block} readOnly={false} onChange={() => {}} loadSources={loadSources} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Published Newsletter" })).toBeEnabled());
    expect(screen.getByRole("option", { name: copy.title })).toBeInTheDocument();
  });
  it("refuses read-only insertion and source errors retain a recoverable draft", async () => {
    const first = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(v1.blocks) as AdminBlock[]} readOnly commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull(); first.unmount();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(v1.blocks) as AdminBlock[]} allowIncomplete commandsInline loadHomeSources={async () => { throw new Error("network boundary"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Newsletter signup" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Newsletter signup" }));
    await waitFor(() => expect(screen.getByText(/Your draft stays editable/)).toBeVisible());
    expect(screen.getByRole("combobox", { name: "Published Newsletter" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Heading" })).toBeEnabled();
  });
  it("offers reload for a sealed source error and recovers the same saved selection", async () => {
    const block = { ...createHomeNewsletterBlock("saved-bar"), data: { newsletterIds: ["published-newsletter"],
      actionLabel: "Sign up by email", selectionReceipt: fixture.editorial.receipt } } as AdminBlock;
    const changes = vi.fn();
    const loader = vi.fn().mockImplementationOnce(async () => {
      const sources = await loadSources();
      return { ...sources, editorial: readHomeEditorialSourceReceipt({ ...sources.editorial!,
        catalog: { ...sources.editorial!.catalog, services: { newsletters: { status: "error" } } } }) };
    }).mockImplementation(loadSources);
    render(<HomeNewsletterEditor block={block} readOnly={false} onChange={changes} loadSources={loader} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("will not appear on Home"));
    expect(screen.getByRole("combobox", { name: "Published Newsletter" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Reload published Newsletters" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Published Newsletter" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Published Newsletter" })).toHaveValue("published-newsletter");
    expect(changes).not.toHaveBeenCalled();
  });
  it("does not invent a saved selection during source error and explains total-capacity refusal", async () => {
    const empty = render(<HomeNewsletterEditor block={createHomeNewsletterBlock("empty") as unknown as AdminBlock} readOnly={false} onChange={() => {}}
      loadSources={async () => { const sources = await loadSources(); return { ...sources, editorial: readHomeEditorialSourceReceipt({
        ...sources.editorial!, catalog: { ...sources.editorial!.catalog, services: { newsletters: { status: "error" } } },
      }) }; }} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Published Newsletters are unavailable"));
    expect(screen.queryByText(/Its ID stays saved/)).not.toBeInTheDocument(); empty.unmount();
    const crowded = [...structuredClone(v1.blocks), ...Array.from({ length: 33 }, (_, index) => ({ id: `extra-${index}`,
      type: "headline", order: index + 7, visible: true, data: { text: "Extra content", level: 2 } }))] as AdminBlock[];
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={crowded} commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Remove a plank to make room for new content.")).toBeVisible();
  });
});
