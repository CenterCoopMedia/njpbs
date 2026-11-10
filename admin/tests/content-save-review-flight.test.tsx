import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContentTab } from "../src/components/ContentTab";
import { createBlock } from "../src/lib/block-factory";

const fixture = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), callbacks: null as any }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => ({ getIdToken: async () => "fixture-token", state: { status: "signed-out" } }) }));
vi.mock("../src/lib/firebase", () => ({ db: {}, firebaseConfig: { projectId: "demo-njpbs" } }));
vi.mock("../src/lib/use-content-sections", () => ({ useContentSections: () => [], useContentSectionRegistry: () => ({ sections: [], ready: true }) }));
vi.mock("../src/lib/use-media-categories", () => ({ useMediaCategories: () => ({ state: { status: "ready", categories: [] } }) }));
vi.mock("../src/lib/editor-lock-store", () => ({ editorLockClient: {} }));
vi.mock("../src/lib/functions", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/functions")>(), cmsGetContent: fixture.get, cmsSaveContent: fixture.save,
}));
vi.mock("../src/components/EditorLayoutMode", () => ({ EditorLayoutMode: () => null }));
// Exercise the real authenticated save owners directly. The separate workspace tests
// cover each panel's conflict UI; this test controls their overlapping async calls.
vi.mock("../src/components/EditorWorkspace", async () => {
  const { useEffect, useState } = await import("react");
  return { EditorWorkspace: (props: any) => {
    const [ready, setReady] = useState(false);
    fixture.callbacks = props;
    useEffect(() => { void props.loadPage(props.surface?.pageId ?? "faq", props.surface?.section ?? "genericPage").then(() => setReady(true)); }, []);
    return ready ? <p>Save owners ready</p> : <p>Loading save owners</p>;
  } };
});
afterEach(cleanup);
beforeEach(() => { fixture.get.mockReset(); fixture.save.mockReset(); fixture.callbacks = null; });

it("settles both Page owners when their recovery reads overlap, then admits the next explicit review", async () => {
  const original = { id: "faq", template: "genericPage", title: "Original Page", blocks: [], version: 3, slug: "old-url" };
  const latest = { ...original, title: "Latest Page", version: 4, slug: "remote-url" };
  fixture.get.mockResolvedValue({ success: true, found: true, document: original });
  fixture.save.mockResolvedValue({ success: true, document: { ...latest, title: "Local metadata", version: 5 } });
  render(<ContentTab principal={{ id: "editor", grants: [{ role: "editor" }] }} surface={{ kind: "page", pageId: "faq", section: "genericPage" }} />);
  await screen.findByText("Save owners ready");
  let resolveRead!: (value: unknown) => void;
  fixture.get.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  // An undefined Page claim is the existing panel contract for explicit recovery.
  const first = fixture.callbacks.savePage("faq", "genericPage", [], undefined).catch((error: Error) => error);
  await waitFor(() => expect(resolveRead).toBeTypeOf("function"));
  const second = fixture.callbacks.savePageMetadata("faq", "genericPage", { title: "Local metadata" }, undefined);
  await expect(second).rejects.toThrow("Finish reviewing the other save before retrying");
  expect(fixture.get).toHaveBeenCalledTimes(2);
  await act(async () => { resolveRead({ success: true, found: true, document: latest }); });
  const review = await screen.findByRole("dialog");
  fireEvent.click(within(review).getByRole("button", { name: "Keep editing" }));
  await expect(first).resolves.toMatchObject({ message: "Your edits are still here and have not been saved." });
  expect(fixture.save).not.toHaveBeenCalled();

  fixture.get.mockResolvedValue({ success: true, found: true, document: latest });
  const next = fixture.callbacks.savePageMetadata("faq", "genericPage", { title: "Local metadata", slug: "old-url" }, undefined);
  const nextReview = await screen.findByRole("dialog");
  expect(within(nextReview).getByText("URL slug")).toBeTruthy();
  fireEvent.click(within(nextReview).getByRole("button", { name: "Save my changes over this version" }));
  await expect(next).resolves.toMatchObject({ version: 5 });
  expect(fixture.save).toHaveBeenCalledWith("fixture-token", expect.objectContaining({ baseVersion: 4, slug: "old-url", document: expect.objectContaining({ title: "Local metadata" }) }));
  expect(fixture.save.mock.calls[0]![1].document).not.toHaveProperty("slug");
});

it.each(["blocks", "metadata"] as const)("refuses %s recovery after the saved Page changes its editing format", async panel => {
  for (const marker of [{ homeCompositionVersion: 1 }, { homeCompositionVersion: 2 }, { serviceCompositionVersion: 1 }]) {
    const pageId = "serviceCompositionVersion" in marker ? "watch" : "home";
    const section = pageId === "watch" ? "programLanding" : "home";
    fixture.get.mockResolvedValue({ success: true, found: true, document: { id: pageId, blocks: [], status: "draft", version: 3 } });
    render(<ContentTab principal={{ id: "editor", grants: [{ role: "editor" }] }} surface={{ kind: "page", pageId, section }} />);
    await screen.findByText("Save owners ready");
    fixture.get.mockResolvedValue({ success: true, found: true, document: { id: pageId, blocks: [], status: "draft", version: 4, ...marker } });
    const save = panel === "blocks" ? fixture.callbacks.savePage(pageId, section, [], undefined)
      : fixture.callbacks.savePageMetadata(pageId, section, { title: "Keep my local title" }, undefined);
    await expect(save).rejects.toThrow("Keep a copy, then reload before saving");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.save).not.toHaveBeenCalled();
    cleanup();
  }
});

it.each(["blocks", "metadata"] as const)("still reviews %s on an unchanged service composition", async panel => {
  const document = { id: "watch", template: "programLanding", blocks: [], status: "draft", serviceCompositionVersion: 1, version: 3 };
  fixture.get.mockResolvedValue({ success: true, found: true, document });
  render(<ContentTab principal={{ id: "editor", grants: [{ role: "editor" }] }} surface={{ kind: "page", pageId: "watch", section: "programLanding" }} />);
  await screen.findByText("Save owners ready");
  fixture.get.mockResolvedValue({ success: true, found: true, document: { ...document, version: 4 } });
  fixture.save.mockResolvedValue({ success: true, document: { ...document, version: 5 } });
  const pending = panel === "blocks" ? fixture.callbacks.savePage("watch", "programLanding", [], undefined)
    : fixture.callbacks.savePageMetadata("watch", "programLanding", { title: "Local title" }, undefined);
  const review = await screen.findByRole("dialog");
  fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
  await expect(pending).resolves.toMatchObject({ version: 5 });
  expect(fixture.save).toHaveBeenCalledWith("fixture-token", expect.objectContaining({ baseVersion: 4 }));
});

it("compares the complete outgoing Home shelf request, preserving locked blocks and their order", async () => {
  const locked = { ...createBlock("headline", "locked"), data: { text: "Locked recovery text", level: 2 } };
  const shelf = { ...createBlock("promotion_playlist", "shelf"), order: 11 };
  const document = { id: "home", template: "home", status: "draft", blocks: [locked, shelf], version: 3 };
  fixture.get.mockResolvedValue({ success: true, found: true, document });
  render(<ContentTab principal={{ id: "editor", grants: [{ role: "editor" }] }} surface={{ kind: "page", pageId: "home", section: "home" }} />);
  await screen.findByText("Save owners ready");
  fixture.get.mockResolvedValue({ success: true, found: true, document: { ...document, version: 4 } });
  fixture.save.mockResolvedValue({ success: true, document: { ...document, version: 5 } });
  const pending = fixture.callbacks.savePage("home", "home", [{ ...shelf, order: 0 }], undefined);
  const review = await screen.findByRole("dialog");
  expect(within(review).getByText("No editable field differences were found.")).toBeTruthy();
  expect(within(review).queryByText("Content planks, text and media")).toBeNull();
  fireEvent.click(within(review).getByRole("button", { name: "Save my changes over this version" }));
  await expect(pending).resolves.toMatchObject({ version: 5 });
  expect(fixture.save).toHaveBeenCalledWith("fixture-token", expect.objectContaining({ baseVersion: 4, document: expect.objectContaining({ blocks: document.blocks }) }));
});
