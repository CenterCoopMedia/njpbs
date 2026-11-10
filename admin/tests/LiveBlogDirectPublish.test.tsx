import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RecordForm, type RecordFormHandle } from "../src/components/RecordForm";
import { newLiveBlogVideoBlocks } from "../src/lib/publication-videos";
import { HttpError } from "../src/lib/functions";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import type { LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog";

afterEach(() => { cleanup(); localStorage.clear(); });
const body = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Polls closed at 8 p.m." }] }] };
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{
  id: "entry-a", headline: "Polls close", body, credits: [{ kind: "custom", name: "NJ PBS staff" }], keyUpdate: false,
}] });
const published = (): LiveBlogData => ({ ...draft(), updatedAt: "2026-11-03T23:00:00.000Z", updates: draft().updates.map(entry => ({
  ...entry, followUps: undefined, publishedAt: "2026-11-03T23:00:00.000Z", updatedAt: "2026-11-03T23:00:00.000Z",
})) });
const initial = () => ({ id: "post-one", type: "post", status: "published", version: 5, title: "Election night", blocks: [], tags: [],
  liveBlog: draft(), published: { metadata: { liveBlog: published() } } });
const action = () => screen.queryByRole("button", { name: /Publish live updates now|Requesting publication/ });

describe("direct live update publishing in the Post editor", () => {
  it.each(["byline", "headline"] as const)("names and reveals the fourth entry missing a %s", async field => {
    const record = initial();
    record.liveBlog.updates = Array.from({ length: 4 }, (_, index) => ({ ...draft().updates[0],
      id: `entry-${index}`, headline: `County update ${index + 1}` }));
    if (field === "byline") record.liveBlog.updates[3].credits = [];
    else record.liveBlog.updates[3].headline = "";
    const scroll = vi.fn();
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const publish = vi.fn(async () => {});
      render(<RecordForm kind="post" initial={record} initialIsClean canSave publishLiveBlogUpdate={publish} />);
      fireEvent.click(action()!);
      const message = field === "byline" ? "Entry 4 (headline “County update 4”) needs a byline." : "Entry 4 needs a headline.";
      await waitFor(() => expect(screen.getAllByText(message).length).toBeGreaterThan(0));
      const summary = screen.getAllByText(field === "byline" ? "County update 4" : "Untitled update 4")
        .map(node => node.closest("summary")).find(Boolean)!;
      const target = summary.closest("details")!;
      expect(target).toHaveAttribute("open");
      expect(scroll.mock.instances).toContain(summary);
      if (field === "headline") expect(within(target).getByRole("textbox", { name: "Update headline" })).toHaveFocus();
      else expect(summary).toHaveFocus();
      expect(publish).not.toHaveBeenCalled();
    } finally { HTMLElement.prototype.scrollIntoView = previousScroll; }
  });

  it.each(["byline", "headline"] as const)("returns and focuses the entry-specific %s refusal through ordinary Post publication validation", async field => {
    const record = initial();
    if (field === "byline") record.liveBlog.updates[0].credits = [];
    else record.liveBlog.updates[0].headline = "";
    const ref = createRef<RecordFormHandle>();
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    try {
      render(<RecordForm ref={ref} kind="post" initial={record} initialIsClean canSave />);
      await act(async () => {
        await expect(ref.current!.validateForPublication()).rejects.toThrow(field === "byline"
          ? "Entry 1 (headline “Polls close”) needs a byline." : "Entry 1 needs a headline.");
      });
      expect(screen.getByText(field === "byline"
        ? "Entry 1 (headline “Polls close”) needs a byline." : "Entry 1 needs a headline.")).toBeInTheDocument();
      if (field === "headline") expect(screen.getByRole("textbox", { name: "Update headline" })).toHaveFocus();
    } finally { HTMLElement.prototype.scrollIntoView = previousScroll; }
  });

  it("waits for the directory before warning, and leaves publishing enabled after a directory failure", async () => {
    const record = initial(), authorId = `au_${"a".repeat(32)}`;
    record.liveBlog.updates[0].credits = [{ kind: "registered", authorId }];
    const publish = vi.fn(async () => {});
    const { rerender } = render(<RecordForm kind="post" initial={record} initialIsClean canSave publishLiveBlogUpdate={publish} bylineAuthorsLoading />);
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
    expect(action()).toBeEnabled();
    rerender(<RecordForm kind="post" initial={record} initialIsClean canSave publishLiveBlogUpdate={publish} bylineAuthorsUnavailable />);
    expect(screen.getByRole("group", { name: "Reporter profiles before publishing" })).toHaveTextContent("author profile could not be checked");
    expect(action()).toBeEnabled();
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  });

  it.each([
    ["hasPhoto", "a photo"], ["hasJobTitle", "a job title"], ["hasBio", "a bio"], ["published", "not published"],
  ] as const)("keeps direct publishing available with a %s profile warning", async (field, gap) => {
    const authorId = `au_${"a".repeat(32)}`;
    const record = initial();
    record.liveBlog.updates[0].credits = [{ kind: "registered", authorId }];
    const publish = vi.fn(async () => {});
    render(<RecordForm kind="post" initial={record} initialIsClean canSave publishLiveBlogUpdate={publish} selfAuthorId={authorId}
      bylineAuthors={[{ authorId, displayName: "Ada Reporter", jobTitle: "Reporter", profileReadiness: {
        hasPhoto: true, hasJobTitle: true, hasBio: true, published: true, [field]: false,
      } }]} />);
    const notice = screen.getByRole("group", { name: "Reporter profiles before publishing" });
    expect(notice).toHaveTextContent(gap);
    if (field === "published") expect(notice).toHaveTextContent("Ask a profile manager to publish this profile.");
    expect(within(notice).getByRole("link", { name: "Edit Ada Reporter’s author profile" })).toHaveAttribute("target", "_blank");
    expect(action()).toBeEnabled();
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ updates: [expect.objectContaining({ credits: [{ kind: "registered", authorId }] })] }), 5);
  });

  it("shows a soft custom-credit note before direct publishing without blocking", async () => {
    const publish = vi.fn(async () => {});
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    const notice = screen.getByRole("group", { name: "Reporter profiles before publishing" });
    expect(notice).toHaveTextContent("Readers see the PBS logo instead of a reporter photo.");
    expect(within(notice).queryByRole("status")).toBeNull();
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  });

  it("is absent when the host does not grant it, as for a Writer", () => {
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave />);
    expect(screen.getByRole("article", { name: "Live updates" })).toBeInTheDocument();
    expect(action()).toBeNull();
  });

  it("publishes appearance changes through the same direct-update action", async () => {
    const publish = vi.fn(async () => {});
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show reporter photos" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Playful style" }));
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ presentation: { reporterPhotos: false, playful: true } }), 5);
  });

  it("shows the update note when an unsupported appearance-only request queues no publication", async () => {
    const note = "Live blog appearance settings take effect after the update. Choose them again after the update.";
    const publish = vi.fn(async () => ({ warnings: [note], publicationRequested: false }));
    render(<SuccessNoticeProvider routeKey="post"><RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} /></SuccessNoticeProvider>);
    fireEvent.click(screen.getByRole("checkbox", { name: "Playful style" }));
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect((await screen.findAllByText(note)).length).toBeGreaterThan(0);
    expect(screen.getByText("Content notice")).toBeInTheDocument();
    expect(screen.queryByText(/Publication requested/)).toBeNull();
  });

  it("sends only the live blog and its saved version", async () => {
    const publish = vi.fn(async () => {});
    const onSavingChange = vi.fn();
    render(<SuccessNoticeProvider routeKey="post"><RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} onSavingChange={onSavingChange} /></SuccessNoticeProvider>);
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier time was wrong." } });
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ coverageState: "ongoing",
      updates: [expect.objectContaining({ id: "entry-a", correction: "An earlier time was wrong." })] }), 5);
    // The host holds navigation and other Post actions while the publication runs.
    await waitFor(() => expect(onSavingChange.mock.calls).toEqual([[true], [false]]));
    // The response is a queued publication, so the editor never claims it is live.
    expect((await screen.findAllByText(/Publication requested\. The public site has not confirmed these live updates yet\./)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Live updates published/)).toBeNull();
  });

  it("waits for a running draft save, and a draft save waits for a direct update", async () => {
    let finishSave: (value: Record<string, unknown>) => void = () => {};
    const onSave = vi.fn((_record: Record<string, unknown>) => new Promise<Record<string, unknown>>(resolve => { finishSave = resolve; }));
    let finishPublish: () => void = () => {};
    const publish = vi.fn((_liveBlog: unknown, _baseVersion: number) => new Promise<void>(resolve => { finishPublish = resolve; }));
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave onSave={onSave} publishLiveBlogUpdate={publish} />);
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier time was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(action()).toBeDisabled();
    expect(screen.getByText("Wait for the current save to finish.")).toBeInTheDocument();
    finishSave({ ...initial(), status: "draft", version: 6, liveBlog: onSave.mock.calls[0][0].liveBlog });
    await waitFor(() => expect(action()).toBeEnabled());
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish.mock.calls[0][1]).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
    finishPublish();
    await waitFor(() => expect(action()).toBeEnabled());
  });

  it("asks for a newly chosen entry video to be saved before publishing", () => {
    const value = initial();
    const publish = vi.fn(async () => {});
    const { rerender } = render(<RecordForm key="clean" kind="post" initial={value} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    expect(action()).toBeEnabled();
    const withVideo = { ...value, liveBlog: { ...value.liveBlog, updates: [{ ...value.liveBlog.updates[0],
      media: { kind: "library-video" as const, data: { sourceId: "video-library" as const, assetId: "new-clip", title: "New clip" } } }] } };
    // An unsaved draft: the saved Post has no video, the editor now does.
    rerender(<RecordForm key="draft" kind="post" initial={withVideo} canSave publishLiveBlogUpdate={publish} />);
    expect(action()).toBeDisabled();
    // A saved draft with the same video can publish; the copy then reads the saved Post.
    rerender(<RecordForm key="saved" kind="post" initial={withVideo} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    expect(action()).toBeEnabled();
  });

  it("copies only entry videos that are not already public", () => {
    const video = (assetId: string) => ({ kind: "library-video" as const, data: { sourceId: "video-library" as const, assetId, title: `Video ${assetId}` } });
    const live = draft();
    live.updates = [{ ...live.updates[0], id: "entry-new", media: video("new-clip") }, { ...live.updates[0], media: video("public-clip") }];
    const publicBlog = published();
    publicBlog.updates[0].media = video("public-clip");
    expect(newLiveBlogVideoBlocks(live, publicBlog).map(block => block.data.assetId)).toEqual(["new-clip"]);
    expect(newLiveBlogVideoBlocks(live, undefined).map(block => block.data.assetId)).toEqual(["new-clip", "public-clip"]);
  });

  it("asks for other Post changes to be saved first", () => {
    const publish = vi.fn(async () => {});
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    expect(action()).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Changed title" } });
    expect(action()).toBeDisabled();
    expect(screen.getByText(/Save or discard your other Post changes first/)).toBeInTheDocument();
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps an unsaved URL edit behind a draft save", () => {
    const publish = vi.fn(async () => {});
    render(<RecordForm kind="post" initial={{ ...initial(), slug: "election-night", previousSlugs: [] }} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    expect(action()).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "URL slug" }), { target: { value: "election-results" } });
    expect(action()).toBeDisabled();
    expect(screen.getByText(/Save or discard your other Post changes first/)).toBeInTheDocument();
  });

  it("does not let template capture run during a direct update", async () => {
    let finishPublish: () => void = () => {};
    const publish = vi.fn((_liveBlog: unknown, _baseVersion: number) => new Promise<void>(resolve => { finishPublish = resolve; }));
    const capturePostTemplate = vi.fn();
    const onSavingChange = vi.fn();
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish}
      capturePostTemplate={capturePostTemplate} onSavingChange={onSavingChange} />);
    expect(screen.getByRole("button", { name: "Save as template", hidden: true })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier time was wrong." } });
    fireEvent.click(action()!);
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const template = screen.getByRole("button", { name: "Save as template", hidden: true });
    expect(template).toBeDisabled();
    fireEvent.click(template);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(capturePostTemplate).not.toHaveBeenCalled();
    expect(onSavingChange.mock.calls).toEqual([[true]]);
    finishPublish();
    await waitFor(() => expect(onSavingChange.mock.calls).toEqual([[true], [false]]));
  });

  it("offers the reload or discard recovery when another save changed the Post", async () => {
    const publish = vi.fn(async () => { throw new HttpError(409,
      "This document changed since you opened it. Reload to get the current version before saving.", { versionConflict: true }); });
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier time was wrong." } });
    fireEvent.click(action()!);
    expect(await screen.findByText("Someone else saved this record while you were editing it")).toBeInTheDocument();
    expect(action()).toBeDisabled();
    expect(screen.getByText("Reload this Post before publishing live updates.")).toBeInTheDocument();
    expect(screen.getByLabelText("Correction explanation")).toHaveValue("An earlier time was wrong.");
  });

  it("keeps other 409 refusals in Live updates without the reload recovery", async () => {
    const publish = vi.fn(async () => { throw new HttpError(409, "This Post has changes outside its live updates."); });
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier time was wrong." } });
    fireEvent.click(action()!);
    expect(await screen.findByText("This Post has changes outside its live updates.")).toHaveAttribute("role", "alert");
    expect(screen.queryByText("Someone else saved this record while you were editing it")).toBeNull();
  });

  it("shows the server refusal and keeps the work", async () => {
    const publish = vi.fn(async () => { throw new Error("This Post has changes outside its live updates."); });
    render(<RecordForm kind="post" initial={initial()} initialIsClean canSave publishLiveBlogUpdate={publish} />);
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Polls closed" } });
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "Headline tense fixed." } });
    fireEvent.click(action()!);
    expect(await screen.findByText("This Post has changes outside its live updates.")).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText("Update headline")).toHaveValue("Polls closed");
    expect(action()).toBeEnabled();
  });
});
