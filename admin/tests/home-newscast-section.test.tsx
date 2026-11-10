import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { HomeNewscastEditor } from "../src/components/HomeNewscastEditor";
import { createHomeNewscastBlock } from "../../packages/content-core/src/home-newscast-section";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import type { AdminBlock } from "../src/lib/block-factory";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";
import provider from "../../site/tests/fixtures/home-sources/newscast-documented-schema.json";
const cutoffAt = "2026-10-11T19:00:00.000Z";
const loadSources = async (): Promise<HomeSourceSnapshot> => ({ schemaVersion: 1,
  pbs: { source: "media-manager", checkedAt: cutoffAt, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: cutoffAt, cards: [] }, publication: fixture.editorial.receipt,
  editorial: readHomeEditorialSourceReceipt({ ...fixture.editorial, catalog: { ...fixture.editorial.catalog, cutoffAt,
    services: { newsletters: { status: "error" }, newscast: adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
      requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: cutoffAt, complete: true, response: provider }, cutoffAt) } } }) });
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
function SavedHome() {
  const [saved, setSaved] = useState(structuredClone(v1.blocks) as AdminBlock[]), [reopen, setReopen] = useState(0);
  return <><BlockEditor key={reopen} section="home" pageId="home" homeCompositionVersion={2} initialBlocks={saved}
    loadHomeSources={loadSources} allowIncomplete commandsInline onSave={async blocks => setSaved(blocks)} />
    <button onClick={() => setReopen(value => value + 1)}>Reopen fixture</button><output data-testid="saved">{JSON.stringify(saved)}</output></>;
}
describe("Boardwalk automatic Newscast section", () => {
  it("adds, edits finite layout/copy, moves, saves/reopens and restores the same withdrawn identity", async () => {
    render(<SavedHome />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Newscast" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Newscast" }));
    const dialog = screen.getByRole("dialog", { name: "Newscast" });
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("Current episode:"));
    expect(within(dialog).getByRole("combobox", { name: "Newscast source" })).toHaveValue("ad1f378e-9779-4ef1-a629-40a8a6f8f8d5");
    expect(within(dialog).getAllByRole("combobox")).toHaveLength(2);
    expect(within(dialog).queryByRole("textbox", { name: /URL|poster|episode ID|embed/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Layout" }).querySelectorAll("option")).toHaveLength(2);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Heading" }), { target: { value: "Our\tnewscast" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Summary" }), { target: { value: "Local\nstation\tupdates" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Watch button text" }), { target: { value: "Watch\tnow" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Layout" }), { target: { value: "compact" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const section = document.querySelector<HTMLElement>('[data-home-section="home-newscast"]')!;
    fireEvent.keyDown(within(section).getByRole("button", { name: /^Move:/ }), { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).find((block: AdminBlock) => block.section === "home-newscast").data.summary).toBe("Local station updates"));
    const saved = JSON.parse(screen.getByTestId("saved").textContent!);
    const newscast = saved.find((block: AdminBlock) => block.section === "home-newscast");
    expect(saved.findIndex((block: AdminBlock) => block.section === "home-newscast")).toBe(6);
    expect(newscast.data).toMatchObject({ heading: "Our newscast", layout: "compact", watchLabel: "Watch now" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen fixture" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Newscast" }));
    const reopened = screen.getByRole("dialog", { name: "Newscast" });
    expect(within(reopened).getByRole("combobox", { name: "Layout" })).toHaveValue("compact");
    expect(within(reopened).getByRole("textbox", { name: "Heading" })).toHaveValue("Our newscast");
    fireEvent.click(within(reopened).getByRole("button", { name: /^Remove section from page/ }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Newscast Restore hidden section" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId("saved").textContent!).filter((block: AdminBlock) => block.section === "home-newscast")).toEqual([newscast]));
  });
  it("keeps loading/failure distinct from episode unavailability and recovers without changing saved configuration", async () => {
    const block = createHomeNewscastBlock("saved-newscast") as unknown as AdminBlock;
    const pending = render(<HomeNewscastEditor block={block} readOnly={false} onChange={() => {}} loadSources={() => new Promise(() => {})} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading published newscast");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); pending.unmount();
    const changes = vi.fn(); let failed = true;
    const loader = async () => { if (failed) throw new Error("network boundary"); return loadSources(); };
    render(<HomeNewscastEditor block={block} readOnly={false} onChange={changes} loadSources={loader} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded. Your draft stays editable"));
    expect(screen.getByRole("textbox", { name: "Heading" })).toBeEnabled();
    failed = false; fireEvent.click(screen.getByRole("button", { name: "Reload published newscast" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Current episode:"));
    expect(changes).not.toHaveBeenCalled();
  });
  it("requires explicit v2 adoption and refuses read-only, disabled-layout and full-capacity insertion", () => {
    const legacy = render(<BlockEditor section="home" pageId="home" initialBlocks={[]} commandsInline />);
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Newscast", hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add block: position 1" }));
    const palette = screen.getByRole("group", { name: "Blocks to insert at position 1" });
    expect(within(palette).queryByRole("button", { name: "Newscast" })).not.toBeInTheDocument();
    expect(within(palette).getByRole("button", { name: "text" })).toBeInTheDocument(); legacy.unmount();
    const locked = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(v1.blocks) as AdminBlock[]} readOnly commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull(); locked.unmount();
    const full = [...structuredClone(v1.blocks), ...Array.from({ length: 33 }, (_, index) => ({ id: `copy-${index}`, type: "prose", order: 7 + index,
      visible: true, data: { content: { type: "doc", content: [] } } }))] as AdminBlock[];
    const capacity = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={full} allowIncomplete commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Remove a plank to make room for new content.")).toBeVisible(); capacity.unmount();
    vi.stubEnv("VITE_CMS_HOME_LAYOUTS_ENABLED", "false");
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(v1.blocks) as AdminBlock[]} commandsInline />);
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("keeps source/layout/copy read-only and reports unavailable episode without replacing the program", async () => {
    const source = await loadSources();
    const unavailable = async () => ({ ...source, editorial: readHomeEditorialSourceReceipt({ ...source.editorial!,
      catalog: { ...source.editorial!.catalog, services: { newsletters: { status: "error" }, newscast: adaptLatestHomeNewscast({ status: "error" }, cutoffAt) } } }) });
    const changes = vi.fn(); render(<HomeNewscastEditor block={createHomeNewscastBlock("saved") as unknown as AdminBlock} readOnly onChange={changes} loadSources={unavailable} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("heading, Past newscasts and Watch live links remain"));
    for (const control of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("combobox")]) expect(control).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Newscast source" }).querySelectorAll("option")).toHaveLength(1);
    expect(changes).not.toHaveBeenCalled();
  });
});
