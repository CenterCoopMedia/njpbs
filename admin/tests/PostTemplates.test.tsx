import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ShellLayout } from "../src/routes/ShellLayout";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { RecordForm } from "../src/components/RecordForm";
import { NewPostChoice } from "../src/components/NewPostChoice";
import { PostTemplatesPage, type PostTemplatesApi } from "../src/routes/PostTemplatesRoute";
import { HttpError, type PostTemplateSummary, type CapturePostTemplateRequest } from "../src/lib/functions";
import type { Principal } from "../../packages/content-core/src/rbac";

const nativeShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const nativeClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });
});
afterAll(() => {
  for (const [name, descriptor] of [["showModal", nativeShow], ["close", nativeClose]] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
afterEach(() => { cleanup(); localStorage.clear(); });

const summary: PostTemplateSummary = {
  id: "template-one", name: "Monthly brief", description: "Two rows for a recurring station update",
  version: 1, mode: "layout", retired: false, sourceId: "post-source", sourceVersion: 7,
  section: "watch", counts: { row: 2, prose: 1, image: 1 }, canManage: true,
};
const blocks = [
  { id: "row-a", type: "row", order: 0, visible: true, data: { columns: [4, 8] } },
  { id: "text-a", type: "prose", order: 1, visible: true, layout: { rowId: "row-a", column: 0 }, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Starter instructions" }] }] } } },
  { id: "image-a", type: "image", order: 2, visible: true, layout: { rowId: "row-a", column: 1 }, data: { assetId: "", alt: "" } },
  { id: "row-b", type: "row", order: 3, visible: false, data: { columns: [3, 3, 6] } },
];
const templateDocument = { type: "post", status: "draft", title: "", categories: [], tags: [], blocks };
const source = { id: "post-source", type: "post", version: 7, status: "draft", title: "Source story", categories: [], tags: [], blocks: [] };
const captureReceipt = (request: CapturePostTemplateRequest) => ({ success: true as const, template: { ...summary, name: request.name, sourceVersion: request.sourceVersion }, removed: false, replayed: false });

function mount(element: React.ReactNode, path = "/source") {
  const router = createMemoryRouter([
    { path: "/source", element },
    { path: "/post-templates/:templateId?", element },
    { path: "/content/post/:id/edit", element: <h1>Independent draft</h1> },
    { path: "/content/post/+", element: <h1>Blank draft</h1> },
    { path: "/content/post", element: <h1>Posts</h1> },
  ], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
function openCapture() {
  fireEvent.click(screen.getByText("Post actions", { selector: "summary" }));
  const trigger = screen.getByRole("button", { name: "Save as template" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}
function apiFixture() {
  const list = vi.fn<PostTemplatesApi["list"]>(async () => ({ success: true as const, templates: [summary, { ...summary, id: "retired", name: "Old brief", retired: true }] }));
  const get = vi.fn<PostTemplatesApi["get"]>(async () => ({ success: true as const, template: summary, document: structuredClone(templateDocument), mediaWarning: null }));
  const change = vi.fn<PostTemplatesApi["change"]>(async request => ({ success: true, template: { ...summary, version: request.baseVersion + 1, name: request.name ?? summary.name, retired: request.retired ?? false }, removed: request.action === "remove", replayed: false }));
  const create = vi.fn<PostTemplatesApi["create"]>(async () => ({ success: true, collection: "cmsPosts", id: "new-post", created: true, mintedIds: {}, document: { ...templateDocument, id: "new-post", version: 1 } }));
  return { list, get, change, create };
}

describe("Save a Post template", () => {
  it.each([true, false])("captures the clean source without a Post save when canSave is %s", async canSave => {
    const save = vi.fn();
    const capture = vi.fn(async (request: CapturePostTemplateRequest) => captureReceipt(request));
    mount(<RecordForm kind="post" initial={{ ...source, status: "published" }} initialIsClean canSave={canSave} readOnly={!canSave} onSave={save} capturePostTemplate={capture} />);
    const trigger = openCapture();
    const dialog = screen.getByRole("dialog", { name: "Save as template" });
    expect(within(dialog).getByText(/Capture saved Post version 7/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Template name" }), { target: { value: "Reusable report" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save template" }));
    await screen.findByRole("heading", { name: "Template saved" });
    expect(save).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "post-source", sourceVersion: 7, name: "Reusable report", mode: "layout" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(trigger).toHaveFocus();
  });

  it("saves unsaved work and captures the canonical returned version", async () => {
    const saving = vi.fn();
    const save = vi.fn(async (record: Record<string, unknown>) => ({ kind: "record-save-receipt" as const, document: { ...record, version: 8 }, mintedIds: {} }));
    const capture = vi.fn(async (request: CapturePostTemplateRequest) => captureReceipt(request));
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave allowIncomplete onSave={save} onSavingChange={saving} capturePostTemplate={capture} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Edited source story" } });
    openCapture();
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Updated template" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Include" }), { target: { value: "content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Post and capture" }));
    await screen.findByRole("heading", { name: "Template saved" });
    expect(save).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ sourceVersion: 8, mode: "content" }));
    const calls = saving.mock.calls.map(([value]) => value);
    expect(calls.slice(0, -1)).not.toContain(false);
    expect(calls.at(-1)).toBe(false);
  });

  it("cancels without a write and keeps the source edits", () => {
    const save = vi.fn(); const capture = vi.fn();
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave allowIncomplete onSave={save} capturePostTemplate={capture} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Work to keep" } });
    openCapture();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("Work to keep");
  });

  it("does not capture an older version when the source save conflicts", async () => {
    const capture = vi.fn();
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave allowIncomplete onSave={async () => { throw new HttpError(409, "Source changed"); }} capturePostTemplate={capture} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Work to keep" } });
    openCapture();
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "New template" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Post and capture" }));
    await screen.findByText(/The Post save did not finish/);
    expect(capture).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("Work to keep");
  });
});

describe("Duplicate a Post", () => {
  it("duplicates the exact clean saved version and reports progress", async () => {
    let finish: (() => void) | undefined;
    const duplicatePost = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const saving = vi.fn();
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave duplicatePost={duplicatePost} onSavingChange={saving} />);

    fireEvent.click(screen.getByText("Post actions", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));

    expect(duplicatePost).toHaveBeenCalledWith("post-source", 7);
    expect(screen.getByRole("button", { name: /^.+: Duplicating…$/ })).toHaveAttribute("aria-busy", "true");
    expect(saving).toHaveBeenLastCalledWith(true);
    const title = screen.getByRole("textbox", { name: "Post title" });
    expect(title).toBeDisabled();
    fireEvent.change(title, { target: { value: "Edit during duplicate" } });

    finish?.();
    await waitFor(() => expect(saving).toHaveBeenLastCalledWith(false));
    expect(title).toBeEnabled();
    expect(title).toHaveValue("Source story");
  });

  it("keeps unsaved source work in place and shows a retryable failure", async () => {
    const duplicatePost = vi.fn().mockRejectedValueOnce(new Error("The saved Post changed. Reload it, then duplicate it again."));
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave duplicatePost={duplicatePost} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Work to keep" } });
    fireEvent.click(screen.getByText("Post actions", { selector: "summary" }));
    expect(screen.getByRole("button", { name: "Duplicate post" })).toBeDisabled();
    expect(screen.getByText("Save or revert your changes before duplicating this Post.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("Work to keep");

    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Source story" } });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The saved Post changed. Reload it, then duplicate it again.");
    expect(screen.getByRole("textbox", { name: "Post title" })).toHaveValue("Source story");
  });

  it("shows the duplicate failure instead of an older save failure", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Network error"));
    const duplicatePost = vi.fn().mockRejectedValueOnce(new Error("Duplicate refused"));
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave onSave={onSave} duplicatePost={duplicatePost} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Network error")).toBeVisible();
    fireEvent.click(screen.getByText("Post actions", { selector: "summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Duplicate refused");
    expect(screen.queryByText("Network error")).toBeNull();
  });

  it("waits for unsaved media work without discarding it", () => {
    const duplicatePost = vi.fn();
    mount(<RecordForm kind="post" initial={source} initialIsClean canSave duplicatePost={duplicatePost}
      duplicateDisabledReason="Finish or cancel the media changes before duplicating this Post." />);

    fireEvent.click(screen.getByText("Post actions", { selector: "summary" }));
    expect(screen.getByRole("button", { name: "Duplicate post" })).toBeDisabled();
    expect(screen.getByText("Finish or cancel the media changes before duplicating this Post.")).toBeVisible();
    expect(duplicatePost).not.toHaveBeenCalled();
  });
});

describe("Post template selection and management", () => {
  it.each([
    ["contributor", [{ role: "contributor", sections: ["watch"] }], false],
    ["publisher in another area", [{ role: "contributor", sections: ["watch"] }, { role: "editor", sections: ["support"] }], false],
    ["publisher in this area", [{ role: "editor", sections: ["watch"] }], true],
    ["admin", [{ role: "admin" }], true],
  ] as const)("enforces HTML controls for a %s without blocking template metadata", async (_name, grants, allowed) => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: summary, mediaWarning: null, document: {
      ...templateDocument, blocks: [{ id: "html-one", type: "html", order: 0, visible: true, data: { html: "<p>Results</p>", title: "Results" } }],
    } });
    const data = { principal: { id: "author", grants } as unknown as Principal,
      user: { uid: "author" }, userDoc: null, signOut: () => {} } as ShellData;
    mount(<ShellProvider value={data}><PostTemplatesPage api={api} /></ShellProvider>, "/post-templates/template-one");
    expect(await screen.findByRole("textbox", { name: "Template name" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    const palette = screen.getByRole("radiogroup", { name: "Content types at position 1" });
    expect(within(palette).queryByRole("radio", { name: "custom HTML" }) !== null).toBe(allowed);
    fireEvent.click(screen.getByRole("button", { name: "Edit custom HTML 1" }));
    expect(screen.queryByRole("textbox", { name: /^HTML/ }) !== null).toBe(allowed);
    const duplicate = screen.getByRole("button", { name: "Duplicate custom HTML 1" });
    if (allowed) expect(duplicate).toBeEnabled();
    else expect(duplicate).toBeDisabled();
    if (!allowed) expect(screen.getByText(/Only Editors, Managers and Site owners can change custom HTML/)).toBeInTheDocument();
  });

  it("keeps the blank start and exposes a keyboard-dismissible template choice", () => {
    mount(<NewPostChoice />);
    expect(screen.getByRole("link", { name: "New post" })).toHaveAttribute("href", "/content/post/+");
    const trigger = screen.getByRole("button", { name: "Choose a post starting point" });
    fireEvent.click(trigger);
    expect(screen.getByRole("link", { name: "From template" })).toHaveAttribute("href", "/post-templates");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("link", { name: "From template" })).not.toBeInTheDocument();
  });

  it("searches names and descriptions and requires confirmation before retiring or removing", async () => {
    const api = apiFixture();
    mount(<PostTemplatesPage api={api} />, "/post-templates");
    await screen.findByRole("heading", { name: "Monthly brief" });
    expect(screen.queryByRole("heading", { name: "Old brief" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "station update" } });
    expect(screen.getByRole("heading", { name: "Monthly brief" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
    expect(api.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.change).not.toHaveBeenCalled();
    screen.getByRole("button", { name: "Remove" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove template" }));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", id: summary.id, baseVersion: 1 })));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Monthly brief" })).not.toBeInTheDocument());
    expect(screen.getByRole("searchbox", { name: "Search templates" })).toHaveFocus();
  });

  it("loads every available template page", async () => {
    const api = apiFixture();
    api.list.mockReset();
    api.list
      .mockResolvedValueOnce({ success: true, templates: [summary], hasMore: true, nextCursor: "page-two" })
      .mockResolvedValueOnce({ success: true, templates: [{ ...summary, id: "template-two", name: "Aardvark brief" }], hasMore: false });

    mount(<PostTemplatesPage api={api} />, "/post-templates");

    await screen.findByRole("heading", { name: "Aardvark brief" });
    expect(screen.getByRole("heading", { name: "Monthly brief" })).toBeInTheDocument();
    const headings = screen.getAllByRole("heading").map(heading => heading.textContent);
    expect(headings.indexOf("Aardvark brief")).toBeLessThan(headings.indexOf("Monthly brief"));
    expect(api.list).toHaveBeenNthCalledWith(1, undefined);
    expect(api.list).toHaveBeenNthCalledWith(2, "page-two");
  });

  it("reuses the draft create key after an uncertain failure and opens its returned address", async () => {
    const api = apiFixture();
    api.create.mockRejectedValueOnce(new Error("Connection lost. Retry this template."));
    const router = mount(<PostTemplatesPage api={api} />, "/post-templates");
    fireEvent.click(await screen.findByRole("button", { name: "Use template: Monthly brief" }));
    await screen.findByText("Connection lost. Retry this template.");
    fireEvent.click(screen.getByRole("button", { name: "Use template: Monthly brief" }));
    await screen.findByRole("heading", { name: "Independent draft" });
    expect(api.create.mock.calls[0][1]).toBe(api.create.mock.calls[1][1]);
    expect(router.state.location.pathname).toBe("/content/post/new-post/edit");
  });

  it("keeps the layout editable and guards unsaved preset changes", async () => {
    const api = apiFixture();
    const router = mount(<PostTemplatesPage api={api} />, "/post-templates/template-one");
    const name = await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "Renamed preset" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Post presentation" }), { target: { value: "multimedia" } });
    fireEvent.click(screen.getByRole("link", { name: "Back to post templates" }));
    await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/post-templates/template-one");
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await screen.findByText("Template saved. Future Posts will use this version.");
    const request = api.change.mock.calls[0][0];
    expect(request).toMatchObject({ id: summary.id, baseVersion: 1, name: "Renamed preset", document: { tags: ["format:multimedia"], blocks } });
    fireEvent.change(name, { target: { value: "Save on exit" } });
    fireEvent.click(screen.getByRole("link", { name: "Back to post templates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/post-templates"));
  });

  it("edits a content template lead image caption and clears it when removing the image", async () => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: { ...summary, mode: "content" },
      document: { ...templateDocument, heroImage: "asset-garden", heroImageAlt: "The newsroom desk", heroImageCaption: "Photo: NJ PBS" }, mediaWarning: null });
    mount(<PostTemplatesPage api={api} media={{ loadMedia: async () => ({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 0, document: 0 } }) }} />, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    const caption = screen.getByRole("textbox", { name: "Lead image caption" });
    expect(caption).toHaveValue("Photo: NJ PBS");
    fireEvent.change(caption, { target: { value: "Inside the newsroom. Photo: NJ PBS" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await screen.findByText("Template saved. Future Posts will use this version.");
    expect(api.change.mock.calls[0][0].document).toMatchObject({ leadMedia: { kind: "image", data: { caption: "Inside the newsroom. Photo: NJ PBS", alt: "The newsroom desk" } } });
    fireEvent.click(screen.getByRole("button", { name: "Remove lead image" }));
    expect(screen.queryByRole("textbox", { name: "Lead image caption" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(2));
    expect(api.change.mock.calls[1][0].document).toMatchObject({ leadMedia: null });
  });

  it("keeps template edits when another editor has saved and requires a reload", async () => {
    const api = apiFixture();
    api.change.mockRejectedValueOnce(new HttpError(409, "Template changed. Reload.", { code: "post_template_conflict" }));
    mount(<PostTemplatesPage api={api} />, "/post-templates/template-one");
    const name = await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "My preset edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.change).toHaveBeenCalledOnce());
    await screen.findByText("This template changed while you were editing it");
    expect(name).toHaveValue("My preset edit");
    expect(screen.queryByRole("button", { name: /Save anyway/ })).not.toBeInTheDocument();
  });

  it("keeps validation failures editable and allows a corrected save", async () => {
    const api = apiFixture();
    api.change.mockRejectedValueOnce(new HttpError(409, "Replace unavailable media: photo."));
    mount(<PostTemplatesPage api={api} />, "/post-templates/template-one");
    const name = await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "Work to keep" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await screen.findByText("Replace unavailable media: photo.");
    expect(name).toHaveValue("Work to keep");
    expect(screen.queryByText("This template changed while you were editing it")).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: "Corrected preset" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await screen.findByText("Template saved. Future Posts will use this version.");
    expect(api.change).toHaveBeenCalledTimes(2);
  });

  it.each(["Retire", "Restore", "Remove"])("reloads the library after a %s version conflict", async action => {
    const api = apiFixture();
    const retired = action === "Restore";
    api.list.mockResolvedValueOnce({ success: true, templates: [{ ...summary, retired }] });
    api.list.mockResolvedValue({ success: true, templates: [{ ...summary, retired, version: 2 }] });
    api.change.mockRejectedValueOnce(new HttpError(409, "Template changed. Reload.", { code: "post_template_conflict" }));
    mount(<PostTemplatesPage api={api} />, "/post-templates?retired=1");
    fireEvent.click(await screen.findByRole("button", { name: action }));
    fireEvent.click(screen.getByRole("button", { name: `${action} template` }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload templates" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: action }));
    fireEvent.click(screen.getByRole("button", { name: `${action} template` }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(2));
    expect(api.change.mock.calls[1][0].baseVersion).toBe(2);
    expect(api.change.mock.calls[1][0].idempotencyKey).not.toBe(api.change.mock.calls[0][0].idempotencyKey);
  });

  const explicitTemplateLeads = [
    ["cleared", null, "image"],
    ["image", { kind: "image", data: { assetId: "selected-photo", alt: "Actual selected image" } }, "image"],
    ["library-video", { kind: "library-video", data: { sourceId: "video-library", assetId: "selected-video", title: "Actual library video" } }, "library-video"],
    ["linked-video", { kind: "linked-video", data: { url: "https://example.org/selected-video", title: "Actual linked video" } }, "linked-video"],
    ["embed", { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Actual embedded video" } }, "embed"],
    ["invalid", { kind: "unsupported" }, "image"],
  ] as const;

  it.each(explicitTemplateLeads)("preserves the explicit %s lead when saving unrelated template edits", async (_kind, leadMedia) => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: summary, mediaWarning: null, document: {
      ...templateDocument, leadMedia: structuredClone(leadMedia), heroImage: "inactive-photo", heroImageAlt: "Inactive legacy alt", heroImageCaption: "Inactive credit",
    } });
    mount(<PostTemplatesPage api={api} media={{ mediaPickerUnavailable: true }} />, "/post-templates/template-one");
    const name = await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.change(name, { target: { value: "Renamed preset" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Post presentation" }), { target: { value: "multimedia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await screen.findByText("Template saved. Future Posts will use this version.");
    expect(api.change).toHaveBeenCalledOnce();
    const request = api.change.mock.calls[0][0];
    expect(request).toMatchObject({ action: "update", id: summary.id, baseVersion: 1, name: "Renamed preset",
      document: { tags: ["format:multimedia"] } });
    expect(request.document?.leadMedia).toStrictEqual(leadMedia);
  });

  it.each(explicitTemplateLeads)("edits the explicit %s template lead without reviving legacy data", async (_kind, leadMedia, expectedKind) => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: summary, mediaWarning: null, document: {
      ...templateDocument, leadMedia, heroImage: "inactive-photo", heroImageAlt: "Inactive legacy alt", heroImageCaption: "Inactive credit",
    } });
    mount(<PostTemplatesPage api={api} media={{ mediaPickerUnavailable: true }} />, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    expect(screen.getByRole("combobox", { name: "Lead media type" })).toHaveValue(expectedKind);
    expect(screen.queryByDisplayValue("inactive-photo")).toBeNull();
    expect(screen.queryByDisplayValue("Inactive legacy alt")).toBeNull();
    expect(screen.queryByDisplayValue("Inactive credit")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Hero background image" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Lead media type" }), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(api.change).toHaveBeenCalledOnce());
    // A previously explicit null remains null without a document write; every
    // other selection is explicitly cleared in the saved template document.
    if (leadMedia !== null) expect(api.change.mock.calls[0][0].document?.leadMedia).toBeNull();
    else expect(api.change.mock.calls[0][0].document).toBeUndefined();
  });

  it("uses template context for editable lead help without writing (#3666)", async () => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: { ...summary, mode: "content" }, mediaWarning: null,
      document: { ...templateDocument, leadMedia: { kind: "image", data: { assetId: "selected-photo", alt: "A reporter at the desk" } } } });
    mount(<PostTemplatesPage api={api} />, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    expect(screen.getByText("Shown at the top of Posts made from this template. Videos play only after a reader chooses Play.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Lead image alt text" })).toHaveAccessibleDescription(expect.stringContaining(
      "Describe what this image adds to Posts made from this template, or mark it decorative."));
    expect(screen.getByRole("textbox", { name: "Lead image alt text" })).toHaveValue("A reporter at the desk");
    expect(api.change).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it.each([
    ["linked-video", { kind: "linked-video", data: { url: "https://example.org/video", title: "Review video" } }],
    ["embed", { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "Review embed" } }],
    ["library-video", { kind: "library-video", data: { sourceId: "video-library", assetId: "selected-video", title: "Review library" } }],
    ["cleared", null],
  ])("preserves inspectable %s review while template editing stays locked", async (_kind, leadMedia) => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: { ...summary, canManage: false }, mediaWarning: null, document: {
      ...templateDocument, leadMedia,
    } });
    const shell: ShellData = { principal: { id: "reviewer", grants: [{ role: "contributor" }] },
      user: { uid: "reviewer", email: null }, userDoc: null, signOut() {},
      getIdToken: async () => { throw new Error("No API in this unit fixture"); } };
    mount(<ShellProvider value={shell}><PostTemplatesPage api={api} /></ShellProvider>, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    const review = screen.getByRole("group", { name: "Lead media review" });
    expect(review.closest("fieldset[disabled], [inert]")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Lead media type" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Hero background image" })).toBeDisabled();
    if (_kind === "linked-video" || _kind === "embed") {
      const link = within(review).getByRole("link"); link.focus(); expect(link).toHaveFocus();
    }
    if (_kind === "library-video") expect(within(review).getByRole("button", { name: "Preview video" })).toBeEnabled();
    if (_kind === "cleared") expect(within(review).getByText("No lead media selected.")).toBeVisible();
  });

  it.each([
    ["layout", {}], ["content", { heroImage: "", heroImageAlt: "" }],
  ] as const)("shows no lead selection in a locked empty %s template without writing", async (mode, legacy) => {
    const api = apiFixture();
    api.get.mockResolvedValueOnce({ success: true, template: { ...summary, mode, canManage: false }, mediaWarning: null,
      document: { ...templateDocument, ...legacy } });
    mount(<PostTemplatesPage api={api} />, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    const review = screen.getByRole("group", { name: "Lead media review" });
    expect(within(review).getByText("No lead media selected.")).toBeVisible();
    expect(within(review).getByText(/Posts made from this template/)).toBeVisible();
    expect(screen.queryByText(/incomplete or unavailable/)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Template name" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Hero background image" })).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: "Lead media type" })).toBeNull();
    expect(api.change).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("keeps hero and block image controls read-only without media access", async () => {
    mount(<PostTemplatesPage api={apiFixture()} media={{ mediaPickerUnavailable: true }} />, "/post-templates/template-one");
    await screen.findByRole("textbox", { name: "Template name" });
    fireEvent.click(screen.getByText("Lead media and background", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    const imageValues = screen.getAllByDisplayValue("No image selected");
    expect(imageValues.length).toBeGreaterThanOrEqual(3);
    for (const input of imageValues) expect(input).toHaveAttribute("readonly");
    expect(screen.getAllByText("Media access is required to change this image.").length).toBeGreaterThanOrEqual(3);
  });


  it.each(["/post-templates", "/post-templates/template-one"])("renders one page heading inside the shell at %s", async path => {
    const data = { principal: { id: "editor", grants: [{ role: "editor" }] },
      user: { uid: "editor", email: "editor@example.org", displayName: "Editor" }, userDoc: { role: null }, signOut: vi.fn() } as unknown as ShellData;
    const router = createMemoryRouter([{ path: "/", element: <ShellLayout />, children: [
      { path: "post-templates/:templateId?", element: <PostTemplatesPage api={apiFixture()} />,
        handle: { title: "Post templates", description: "" } },
    ] }], { initialEntries: [path] });
    render(<ShellProvider value={data}><RouterProvider router={router} /></ShellProvider>);
    const title = path.endsWith("template-one") ? "Edit post template" : "Post templates";
    await screen.findByRole("heading", { level: 1, name: title });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.querySelectorAll("#page-title")).toHaveLength(1);
    expect(screen.getByRole("main")).toHaveAccessibleName(title);
  });

});
