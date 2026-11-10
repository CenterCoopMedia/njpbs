import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorWorkspace, type PageContent } from "../src/components/EditorWorkspace";
import { cmsGetContent, cmsSaveContent, type SaveContentRequest } from "../src/lib/functions";
import type { ExitSaveOutcome } from "../src/lib/exit-save";
import type { AdminBlock } from "../src/lib/block-factory";

const heading = (text: string): AdminBlock => ({
  id: "heading", type: "headline", order: 0, visible: true, data: { text, level: 2 },
});

function pageContent(document: Record<string, unknown>): PageContent {
  return {
    blocks: document.blocks as AdminBlock[],
    metadata: { title: document.title },
    version: document.version as number | undefined,
    status: "draft",
    createdBy: "editor",
  };
}

function closeBlockEditor() {
  const dialog = screen.queryAllByRole("dialog").find(element =>
    element.classList.contains("component-editor-dialog"));
  if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
}

function editBlocks(text: string) {
  fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: text } });
  closeBlockEditor();
}

function savePanel(panel: "blocks" | "metadata") {
  fireEvent.click(screen.getByRole("button", { name: panel === "blocks" ? "Save page" : "Save metadata" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("page sibling save conflicts at the HTTP boundary", () => {
  it.each([
    { sibling: "metadata", mode: "combined" },
    { sibling: "blocks", mode: "independent" },
    { sibling: "metadata", mode: "independent" },
    { sibling: "blocks", mode: "restored" },
    { sibling: "metadata", mode: "restored" },
    { sibling: "blocks", mode: "clean-restored" },
    { sibling: "metadata", mode: "clean-restored" },
  ] as const)(
    "protects unclaimed $sibling during a $mode save",
    async ({ sibling, mode }) => {
      const restore = mode === "restored";
      const combined = mode === "combined";
      let stored: Record<string, unknown> = {
        title: "Home", blocks: [heading("Original heading")], status: "draft", createdBy: "editor",
      };
      const writes: SaveContentRequest[] = [];
      const reads: string[] = [];
      // Deliberately use the permissive legacy backend here to test workspace claim
      // isolation even against an unclaimed receipt. The real save server now requires
      // a claim; ContentTab's zero serialization and reviewed recovery have separate tests.
      vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
        const endpoint = String(input).split("/").at(-1);
        if (endpoint === "cmsGetContent") {
          reads.push(endpoint);
          return Response.json({ success: true, found: true, document: structuredClone(stored) });
        }
        if (endpoint !== "cmsSaveContent") throw new Error(`Unexpected endpoint: ${endpoint}`);
        const body = JSON.parse(String(init.body)) as SaveContentRequest;
        writes.push(body);
        if (body.baseVersion !== undefined && body.baseVersion !== stored.version) {
          return Response.json({ error: "This document changed since you opened it." }, { status: 409 });
        }
        stored = { ...stored, ...body.document, version: Number(stored.version ?? 0) + 1 };
        return Response.json({ success: true, collection: "cmsPages", id: "home", created: false,
          document: structuredClone(stored), mintedIds: {} });
      });
      async function save(document: Record<string, unknown>, baseVersion?: number, createOnly?: boolean) {
        return pageContent((await cmsSaveContent("test-token", {
          collection: "cmsPages", id: "home", document, baseVersion, createOnly,
        })).document);
      }
      const saveRequestRef = { current: null as null | (() => Promise<ExitSaveOutcome>) };
      render(<EditorWorkspace saveRequestRef={saveRequestRef} principal={{ id: "editor", grants: [{ role: "editor" }] }}
        loadPage={async () => {
          const response = await cmsGetContent("test-token", { collection: "cmsPages", id: "home" });
          if (!response.found) throw new Error("Missing fixture");
          return pageContent(response.document);
        }}
        savePage={async (_id, _section, blocks, version, createOnly) => save({ blocks }, version, createOnly)}
        savePageMetadata={async (_id, _section, metadata, version, createOnly) => save(metadata, version, createOnly)}
      />);
      await screen.findByLabelText(/^Page title/);
      editBlocks("Local heading");
      fireEvent.change(screen.getByLabelText(/^Page title/), { target: { value: "Local title" } });
      stored = { ...stored, version: 4,
        ...(sibling === "blocks" ? { blocks: [heading("Remote heading")] } : { title: "Remote title" }) };
      const first = sibling === "blocks" ? "metadata" : "blocks";
      savePanel(first);
      await waitFor(() => expect(stored.version).toBe(5));
      await screen.findByText("Saved.");
      if (restore) {
        if (first === "blocks") editBlocks("Second local heading");
        else fireEvent.change(screen.getByLabelText(/^Page title/), { target: { value: "Second local title" } });
        savePanel(first);
        await waitFor(() => expect(stored.version).toBe(6));
        await screen.findByText("Saved.");
        // Retain both panels so hydration must preserve each panel's own claim.
        if (first === "blocks") editBlocks("Unsaved next heading");
        else fireEvent.change(screen.getByLabelText(/^Page title/), { target: { value: "Unsaved next title" } });
      }
      if (restore || mode === "clean-restored") {
        fireEvent.click(screen.getByRole("button", { name: "Event" }));
        fireEvent.click(screen.getByRole("button", { name: "Home page" }));
        await screen.findByLabelText(/^Page title/);
      }
      const acceptedWrites = restore || combined ? 2 : 1;
      const version = restore || combined ? 6 : 5;
      if (combined) {
        editBlocks("Next saved heading");
        await act(async () => { await saveRequestRef.current!(); });
      } else savePanel(sibling);
      await screen.findByText(/Someone else saved this page/);
      expect(writes).toHaveLength(acceptedWrites);
      expect(reads).toHaveLength(1);
      expect(stored).toMatchObject(sibling === "blocks"
        ? { version, blocks: [heading("Remote heading")] }
        : { version, title: "Remote title" });
      // The existing explicit confirmation still permits a deliberate overwrite.
      fireEvent.click(screen.getByRole("button", { name: "Save anyway, overwriting their changes" }));
      await waitFor(() => expect(stored.version).toBe(version + 1));
      expect(writes).toHaveLength(acceptedWrites + 1);
      expect(stored).toMatchObject(sibling === "blocks"
        ? { blocks: [heading("Local heading")] } : { title: "Local title" });
    },
  );
});
