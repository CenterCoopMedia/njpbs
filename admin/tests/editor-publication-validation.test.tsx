import { createRef } from "react";
import { MemoryRouter } from "react-router";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RecordForm, type RecordFormHandle } from "../src/components/RecordForm";
import { BlockEditor, type BlockEditorHandle } from "../src/components/BlockEditor";
import { createBlock } from "../src/lib/block-factory";
import type { TransitionContentResponse } from "../src/lib/functions";

afterEach(cleanup);

it("accepts a Multimedia Post whose only media is its explicit lead before submitting", async () => {
  const transition = vi.fn(async (): Promise<TransitionContentResponse> => ({ success: true,
    collection: "cmsPosts", id: "post-1", action: "submit", fromStatus: "draft", toStatus: "in_review",
    version: 5, document: { version: 5, status: "in_review" } }));
  render(<MemoryRouter><EditorWorkspace
    principal={{ id: "admin", grants: [{ role: "admin" }] }}
    surface={{ kind: "record", record: "post", id: "post-1" }}
    loadRecord={async () => ({ status: "ready", record: { id: "post-1", type: "post", title: "Station update", blocks: [],
      tags: ["format:multimedia"], date: "2026-09-08", version: 4, status: "draft",
      leadMedia: { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "County meeting" } } } })}
    transitionContent={transition}
  /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm submission" }));
  await waitFor(() => expect(transition).toHaveBeenCalled());
});

it("marks required Post metadata before publication without saving an incomplete draft", async () => {
  const ref = createRef<RecordFormHandle>();
  const save = vi.fn();
  render(<RecordForm ref={ref} kind="post" initial={{ title: "", tags: [], blocks: [] }} allowIncomplete canSave onSave={save} />);
  let valid: boolean | undefined;
  await act(async () => { valid = await ref.current?.validateForPublication(); });
  expect(valid).toBe(false);
  expect(screen.getByRole("textbox", { name: "Post title" })).toHaveAttribute("aria-invalid", "true");
  expect(save).not.toHaveBeenCalled();
});

it("marks incomplete block content before publication without a persistence call", async () => {
  const ref = createRef<BlockEditorHandle>();
  const save = vi.fn();
  render(<BlockEditor ref={ref} section="post" initialBlocks={[createBlock("image", "image")]} allowIncomplete canSave onSave={save} />);
  let valid: boolean | undefined;
  await act(async () => { valid = ref.current?.validateForPublication(); });
  expect(valid).toBe(false);
  expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  expect(save).not.toHaveBeenCalled();
});

it.each(["page", "post"] as const)("marks an incomplete saved %s before submitting for review", async kind => {
  const transition = vi.fn();
  const blocks = [createBlock("image", "image")];
  const { container } = render(<MemoryRouter><EditorWorkspace
    principal={{ id: "admin", grants: [{ role: "admin" }] }}
    surface={kind === "page" ? { kind: "page", pageId: "contact", section: "genericPage" }
      : { kind: "record", record: "post", id: "post-1" }}
    loadPage={async () => ({ blocks, metadata: { title: "Contact" }, version: 4, status: "draft" })}
    loadRecord={async () => ({ status: "ready", record: { id: "post-1", type: "post", title: "Station update", blocks, tags: [], date: "2026-09-08", section: "station", version: 4, status: "draft" } })}
    transitionContent={transition}
  /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "Submit for review" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm submission" }));
  await waitFor(() => expect(container.querySelector('[aria-invalid="true"]')).not.toBeNull());
  expect(transition).not.toHaveBeenCalled();
});
