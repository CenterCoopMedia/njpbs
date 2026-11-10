import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { SaveConflictReviewDialog } from "../src/components/SaveConflictReviewDialog";
import { pageMetadataSaveDocument } from "../src/lib/page-metadata";
import { recordSaveRequest } from "../src/lib/content-save-request";
import type { EditorDocumentKind } from "../../packages/content-core/src/editor-admin";

const { CONTENT_DOCUMENT_CONTRACTS } = createRequire(import.meta.url)("../../functions/lib/content-document-contract.js") as {
  CONTENT_DOCUMENT_CONTRACTS: Record<EditorDocumentKind, { fields: Record<string, string> }>;
};

afterEach(cleanup);

it("names the current saved version, starts on Keep editing, and saves only on explicit confirmation", () => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  trigger.focus();
  const view = render(<SaveConflictReviewDialog title="The newly saved title" version={7} kind="post" document={{title: "The newly saved title", blocks: []}} proposed={{title: "My title", blocks: [{type: "heading"}]}} onConfirm={onConfirm} onCancel={onCancel} />);
  expect(screen.getByRole("dialog", { name: "This content changed while you were editing" })).toBeTruthy();
  expect(screen.getByText("The newly saved title")).toBeTruthy();
  expect(screen.getByText(/latest saved version is 7/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
  expect(screen.getByText("Content planks, text and media")).toBeTruthy();
  expect(screen.getByText(/including values you did not change/)).toBeTruthy();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save my changes over this version" }));
  expect(onConfirm).toHaveBeenCalledOnce();
  view.unmount();
  expect(trigger).toHaveFocus();
  trigger.remove();
});

it.each(["page", "post"] as const)("names nested removals from empty submitted %s metadata groups", kind => {
  const groups = { seo: {}, social: {} };
  const proposed = kind === "page" ? pageMetadataSaveDocument(groups)
    : recordSaveRequest("post", { id: "post-1", version: 3, ...groups }).document;
  const confirm = vi.fn();
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind={kind} pageId="faq"
    document={{ title: "Saved title", seo: { title: "Remote search title", description: "Remote search description", noindex: true },
      social: { title: "Remote social title", imageAssetId: "remote-social-image" } }} proposed={proposed}
    onConfirm={confirm} onCancel={vi.fn()} />);
  for (const label of ["Search title", "Search description", "Hide from search engines", "Social title", "Social image"]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText("No editable field differences were found.")).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
});

it("names removed and changed children of a submitted group while ignoring omitted roots", () => {
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind="page" pageId="faq"
    document={{ title: "Saved title", seo: { title: "Remote search title" }, social: { title: "Remote social title" } }}
    proposed={pageMetadataSaveDocument({ seo: { description: "My search description" } })} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Search title")).toBeTruthy();
  expect(screen.getByText("Search description")).toBeTruthy();
  expect(screen.queryByText("Social title")).toBeNull();
  expect(screen.queryByText("Page title")).toBeNull();
});

it("ignores metadata roots omitted from JSON, including an undefined group", () => {
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind="post"
    document={{ type: "post", title: "Saved title", seo: { title: "Remote search title" }, social: { title: "Remote social title" } }}
    proposed={recordSaveRequest("post", { id: "post-1", version: 3, title: "Saved title", social: undefined }).document} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("No editable field differences were found.")).toBeTruthy();
  expect(screen.queryByText("Search title")).toBeNull();
  expect(screen.queryByText("Social title")).toBeNull();
});

it("names a lead media removal from the actual Post save document", () => {
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind="post"
    document={{ type: "post", leadMedia: { kind: "embed", data: { title: "Remote lead video", url: "https://www.youtube.com/watch?v=abc123abc12" } } }}
    proposed={recordSaveRequest("post", { id: "post-1", version: 3, leadMedia: null }).document}
    onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Lead media")).toBeTruthy();
  expect(screen.queryByText("No editable field differences were found.")).toBeNull();
});

it("names changed reporting settings from the actual Page save document", () => {
  render(<SaveConflictReviewDialog title="Data Hub" version={4} kind="page" pageId="data-hub"
    document={{ dataHubReporting: { summary: "Another editor's work" } }}
    proposed={pageMetadataSaveDocument({ dataHubReporting: {} })} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Data Hub reporting settings")).toBeTruthy();
});

it("names changes to metadata children outside the field catalog", () => {
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind="page" pageId="faq"
    document={{ seo: { vendorSetting: "another editor's value" } }}
    proposed={pageMetadataSaveDocument({ seo: {} })} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Search settings")).toBeTruthy();
  expect(screen.queryByText("No editable field differences were found.")).toBeNull();
});

it.each(Object.keys(CONTENT_DOCUMENT_CONTRACTS) as EditorDocumentKind[])("covers every writable %s root accepted by the save boundary", kind => {
  for (const pageId of kind === "page" ? ["faq", "home", "contact", "data-hub", "staff", "schedule", "watch"] : [undefined]) {
    for (const root of Object.keys(CONTENT_DOCUMENT_CONTRACTS[kind].fields)) {
      const view = render(<SaveConflictReviewDialog title="Saved title" version={4} kind={kind} pageId={pageId}
        document={{}} proposed={{ [root]: { changedSavedValue: true } }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByText("No editable field differences were found."), `${kind}.${root} (${pageId ?? "record"})`).toBeNull();
      view.unmount();
    }
  }
});

it("treats Escape as Keep editing without authorizing a save", () => {
  const onConfirm = vi.fn(), onCancel = vi.fn();
  render(<SaveConflictReviewDialog title="Saved title" version={4} kind="sponsor" document={{}} proposed={{}} onConfirm={onConfirm} onCancel={onCancel} />);
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

it.each(["page", "post", "program", "event"] as const)("includes a changed %s URL in the reviewed fields", kind => {
  render(<SaveConflictReviewDialog title="Unchanged title" version={4} kind={kind} pageId="faq"
    document={{ slug: "new-remote-address" }} proposed={{ slug: "old-local-address" }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("URL slug")).toBeTruthy();
  expect(screen.queryByText("No editable field differences were found.")).toBeNull();
});
