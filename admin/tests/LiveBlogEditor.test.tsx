import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LiveBlogEditor } from "../src/components/LiveBlogEditor";
import { RecordForm } from "../src/components/RecordForm";
import { imageAsset } from "./media-tile-fixtures";
import { HttpError, type BylineAuthorOption } from "../src/lib/functions";
import type { LiveBlogDraft } from "../../packages/content-core/src/live-blog-draft";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog";

afterEach(() => { cleanup(); localStorage.clear(); });
const body = { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Synthetic reporting." }] }] };
const draft = (): LiveBlogDraft => ({ schemaVersion: 1, coverageState: "ongoing", updates: [{
  id: "entry-a", headline: "First report", body, credits: [{ kind: "custom", name: "NJ PBS staff" }], keyUpdate: false,
}] });
const published = (): LiveBlogData => ({ ...draft(), updatedAt: "2026-10-25T15:00:00.000Z", updates: draft().updates.map(entry => ({
  ...entry, followUps: undefined, publishedAt: "2026-10-25T15:00:00.000Z", updatedAt: "2026-10-25T15:00:00.000Z",
})) });
function Harness({ initial = draft(), publicBlog, readOnly = false, onValue = () => {} }: {
  initial?: LiveBlogDraft; publicBlog?: LiveBlogData; readOnly?: boolean; onValue?: (value: LiveBlogDraft) => void;
}) {
  const [value, setValue] = useState(initial);
  return <LiveBlogEditor value={value} published={publicBlog} controlId="live-editor" readOnly={readOnly}
    defaultCredits={[{ kind: "custom", name: "Default newsroom" }]} onChange={next => { setValue(next); onValue(next); }} />;
}

describe("live updates within the Post editor", () => {
  it.each([
    ["hasPhoto", "a photo", "Readers will see a placeholder."],
    ["hasJobTitle", "a job title", "The reporter card will be incomplete."],
    ["hasBio", "a bio", "The reporter card will be incomplete."],
    ["published", "not published", "Readers will see a placeholder."],
  ] as const)("warns at the credit and before publishing when %s is missing", (field, gap, consequence) => {
    const author: BylineAuthorOption = { authorId: `au_${"a".repeat(32)}`, displayName: "Ada Reporter", jobTitle: "Reporter",
      profileReadiness: { hasPhoto: true, hasJobTitle: true, hasBio: true, published: true, [field]: false } };
    const value = draft(); value.updates[0].credits = [{ kind: "registered", authorId: author.authorId }];
    const onChange = vi.fn();
    render(<LiveBlogEditor controlId="profile-warning-editor" value={value} authors={[author]} canManageAuthorProfiles onChange={onChange} />);
    for (const label of ["Reporter profiles for First report", "Reporter profiles before publishing"]) {
      const notice = screen.getByRole("group", { name: label });
      expect(notice).toHaveTextContent(gap);
      expect(notice).toHaveTextContent(consequence);
      expect(within(notice).getByRole("link", { name: "Edit Ada Reporter’s author profile" }))
        .toHaveAttribute("href", `/staff-profiles?authorId=${author.authorId}`);
      expect(notice).toHaveTextContent("These notices do not prevent publication.");
      expect(notice).toHaveTextContent("Profile details update when you reload Boardwalk. Save this draft before reloading after a profile edit.");
    }
    expect(screen.getByRole("button", { name: "Add live update" })).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses a softer PBS-logo note for custom credits", () => {
    render(<Harness />);
    const notice = screen.getByRole("group", { name: "Reporter profiles for First report" });
    expect(notice).toHaveTextContent("NJ PBS staff: Readers see the PBS logo instead of a reporter photo.");
    expect(within(notice).queryByRole("status")).toBeNull();
    expect(within(notice).queryByRole("link")).toBeNull();
  });

  it("tells ordinary staff to ask a profile manager for another reporter", () => {
    const authorId = `au_${"a".repeat(32)}`;
    const value = draft(); value.updates[0].credits = [{ kind: "registered", authorId, displayName: "Ada Reporter" }];
    render(<LiveBlogEditor controlId="profile-warning-editor" value={value} onChange={vi.fn()} />);
    const notice = screen.getByRole("group", { name: "Reporter profiles for First report" });
    expect(notice).toHaveTextContent("Ask a profile manager to update this profile.");
    expect(within(notice).queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "Add live update" })).toBeEnabled();
  });

  it("does not warn for a complete published profile and warns conservatively on an older feed", () => {
    const author: BylineAuthorOption = { authorId: `au_${"a".repeat(32)}`, displayName: "Ada Reporter", jobTitle: "Reporter",
      profileReadiness: { hasPhoto: true, hasJobTitle: true, hasBio: true, published: true } };
    const value = draft(); value.updates[0].credits = [{ kind: "registered", authorId: author.authorId }];
    const { rerender } = render(<LiveBlogEditor controlId="profile-warning-editor" value={value} authors={[author]} onChange={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Reporter profiles before publishing" })).toBeNull();
    rerender(<LiveBlogEditor controlId="profile-warning-editor" value={value} authors={[{ ...author, profileReadiness: undefined }]} selfAuthorId={author.authorId} onChange={vi.fn()} />);
    const notice = screen.getByRole("group", { name: "Reporter profiles for First report" });
    expect(notice).toHaveTextContent("Ada Reporter’s author profile could not be checked.");
    expect(notice).not.toHaveTextContent("is missing");
    const link = within(notice).getByRole("link");
    expect(link).toHaveAttribute("href", "/account/profile");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("defaults appearance without mutating a legacy draft and retains each explicit choice", () => {
    const onValue = vi.fn();
    const { rerender } = render(<Harness onValue={onValue} />);
    const photos = screen.getByRole("checkbox", { name: "Show reporter photos" });
    const cards = screen.getByRole("checkbox", { name: "Show reporter cards" });
    expect(cards).toHaveAccessibleDescription("Readers can open reporter details from the photo.");
    const playful = screen.getByRole("checkbox", { name: "Playful style" });
    expect(photos).toBeChecked(); expect(cards).toBeChecked(); expect(playful).not.toBeChecked();
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.click(photos); fireEvent.click(cards); fireEvent.click(playful);
    expect(onValue.mock.calls.at(-1)?.[0].presentation).toEqual({ reporterPhotos: false, reporterCards: false, playful: true });
    rerender(<Harness readOnly onValue={onValue} />);
    expect(photos).toBeDisabled(); expect(cards).toBeDisabled(); expect(playful).toBeDisabled();
  });

  it("adds a short follow-up with a byline, then corrects or withdraws it in the draft", () => {
    const onValue = vi.fn(); const initial = draft();
    initial.updates[0].followUps = [{ id: "follow-a", body, credits: [{ kind: "custom", name: "Reporter" }] }];
    const publicBlog = published(); publicBlog.updates[0].followUps = [{ ...initial.updates[0].followUps[0], publishedAt: publicBlog.updatedAt, updatedAt: publicBlog.updatedAt }];
    render(<Harness initial={initial} publicBlog={publicBlog} onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Follow-up correction explanation"), { target: { value: "Corrected detail." } });
    expect(onValue.mock.calls.at(-1)?.[0].updates[0].followUps[0].correction).toBe("Corrected detail.");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw follow-up in this draft" }));
    fireEvent.change(screen.getByLabelText("Withdrawal explanation"), { target: { value: "Could not verify." } });
    expect(onValue.mock.calls.at(-1)?.[0].updates[0].followUps[0].withdrawal).toBe("Could not verify.");
    fireEvent.click(screen.getByRole("button", { name: "Add follow-up" }));
    const added = onValue.mock.calls.at(-1)?.[0].updates[0].followUps[1];
    expect(added).toMatchObject({ id: expect.stringMatching(/^tmp-/), credits: [{ kind: "custom", name: "Default newsroom" }] });
    expect(screen.getByRole("textbox", { name: "Body for follow-up 2" })).toHaveFocus();
  });
  it("hides a withdrawing parent’s audit thread and disables adding follow-ups", () => {
    const value = draft(); value.updates[0].withdrawal = "Unverified reporting.";
    value.updates[0].followUps = [{ id: "follow", body, credits: [{ kind: "custom", name: "Reporter" }] }];
    render(<Harness initial={value} />);
    expect(screen.getByRole("button", { name: "Add follow-up" })).toBeDisabled();
    expect(screen.getByText("Follow-ups are hidden with this withdrawn update.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Body for follow-up 1" })).toBeNull();
    expect(screen.queryByText("Synthetic reporting.")).toBeNull();
  });

  it("keeps an unsaved follow-up visible and asks for Save before withdrawing its parent", () => {
    const value = draft(); value.updates[0].followUps = [{ id: "tmp-follow", body, credits: [] }];
    render(<Harness initial={value} publicBlog={published()} />);
    expect(screen.getByRole("button", { name: "Withdraw update in this draft" })).toBeDisabled();
    expect(screen.getByText("Save this Post before withdrawing the update.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Body for follow-up 1" })).toBeInTheDocument();
  });

  it("requires saving edits and removals of saved follow-ups before hiding a parent thread", () => {
    const source = draft(); source.updates[0].followUps = [{ id: "saved-follow", body, credits: [{ kind: "custom", name: "Reporter" }] }];
    function SavedHarness() {
      const [value, setValue] = useState(source);
      return <LiveBlogEditor value={value} saved={source} published={published()} controlId="guarded" onChange={setValue} />;
    }
    render(<SavedHarness />);
    expect(screen.getByRole("button", { name: "Withdraw update in this draft" })).toBeEnabled();
    const byline = screen.getByRole("group", { name: "Follow-up byline" });
    fireEvent.change(within(byline).getByLabelText("Add a custom credit"), { target: { value: "Another reporter" } });
    fireEvent.click(within(byline).getByRole("button", { name: "Add custom credit" }));
    expect(screen.getByRole("button", { name: "Withdraw update in this draft" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Body for follow-up 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove draft follow-up 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove draft follow-up" }));
    expect(screen.getByRole("button", { name: "Withdraw update in this draft" })).toBeDisabled();
  });

  it("adds a draft, credits it and focuses its headline", () => {
    const onValue = vi.fn();
    render(<Harness initial={{ ...draft(), updates: [] }} onValue={onValue} />);
    expect(screen.getByText(/No updates yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add live update" }));
    expect(screen.getByLabelText("Update headline")).toHaveFocus();
    expect(onValue.mock.calls.at(-1)?.[0].updates[0]).toMatchObject({ id: expect.stringMatching(/^tmp-/),
      headline: "", credits: [{ kind: "custom", name: "Default newsroom" }] });
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "New report" } });
    expect(onValue.mock.calls.at(-1)?.[0].updates[0].headline).toBe("New report");
    const byline = screen.getByRole("group", { name: "Update byline" });
    fireEvent.change(within(byline).getByLabelText("Add a custom credit"), { target: { value: "Guest reporter" } });
    fireEvent.click(within(byline).getByRole("button", { name: "Add custom credit" }));
    expect(onValue.mock.calls.at(-1)?.[0].updates[0].credits).toContainEqual({ kind: "custom", name: "Guest reporter" });
  });

  it("confirms draft removal and returns focus after cancel and remove", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove draft update: First report" }));
    expect(screen.getByRole("button", { name: "Keep update" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep update" }));
    expect(screen.getByRole("button", { name: "Remove draft update: First report" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove draft update: First report" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove draft update" }));
    expect(screen.getByRole("button", { name: "Add live update" })).toHaveFocus();
    expect(screen.queryByRole("list", { name: "Live updates" })).toBeNull();
  });

  it("keeps a published entry id and drafts a correction or explained withdrawal", () => {
    const onValue = vi.fn(); render(<Harness publicBlog={published()} onValue={onValue} />);
    expect(screen.queryByRole("button", { name: /Remove draft update/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Correction explanation"), { target: { value: "An earlier count was wrong." } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw update in this draft" }));
    expect(screen.getByLabelText("Withdrawal explanation")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Withdrawal explanation"), { target: { value: "The report could not be verified." } });
    expect(onValue.mock.calls.at(-1)?.[0].updates[0]).toMatchObject({ id: "entry-a", withdrawal: "The report could not be verified.", body });
    fireEvent.click(screen.getByRole("button", { name: "Cancel withdrawal" }));
    expect(screen.getByLabelText("Update headline")).toHaveFocus();
    expect(onValue.mock.calls.at(-1)?.[0].updates[0]).not.toHaveProperty("withdrawal");
  });

  it("keeps read-only rich text inspectable without an editing surface", () => {
    const onValue = vi.fn(); render(<Harness readOnly onValue={onValue} />);
    expect(screen.getByText("Synthetic reporting.")).toBeInTheDocument();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Add live update" })).toBeDisabled();
    expect(screen.getByLabelText("Update headline")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Discarded" } });
    expect(onValue).not.toHaveBeenCalled();
  });

  it("uses the existing image picker and saves entry media, alt text and election branding with the Post", async () => {
    const photo = imageAsset({ id: "entry-photo", name: "Polling place", url: "https://media.njpbs.org/cms-media/entry-photo/image.jpg", thumbnails: undefined });
    const loadMedia = vi.fn(async () => ({ success: true as const, records: [photo], total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: { news: 1 }, kindCounts: { image: 1, document: 0 } }));
    const onSave = vi.fn(async record => ({ ...record, version: 4 }));
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: draft() }} canSave allowIncomplete loadMedia={loadMedia} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose update image" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Polling place/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Update image alt text" }), { target: { value: "People entering the polling place" } });
    fireEvent.change(screen.getByLabelText("Coverage branding"), { target: { value: "nj-decides-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].liveBlog).toMatchObject({ branding: "nj-decides-2026", updates: [{ media: { kind: "image", data: { assetId: "entry-photo", alt: "People entering the polling place" } } }] });
    expect(loadMedia).toHaveBeenCalled();
  });

  it("edits an entry video title and distinct caption through the shared Post controls", () => {
    const onValue = vi.fn(); render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Update media type"), { target: { value: "embed" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Video link or iframe code" }), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Video title" }), { target: { value: "Results briefing" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Video caption" }), { target: { value: "Produced by the newsroom" } });
    expect(onValue.mock.calls.at(-1)?.[0].updates[0].media).toMatchObject({ kind: "embed", data: { title: "Results briefing", caption: "Produced by the newsroom" } });
  });

  it("keeps lead and entry library-video labels unique in a read-only Post", () => {
    const media = { kind: "library-video" as const, data: { sourceId: "video-library" as const, assetId: "entry-video", title: "Briefing" } };
    const value = draft(); value.updates[0].media = media;
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], leadMedia: media, liveBlog: value }} readOnly canSave={false} />);
    expect(screen.getByRole("group", { name: "Update media review" })).toBeInTheDocument();
    const ids = Array.from(document.querySelectorAll("[id]")).map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of document.querySelectorAll<HTMLLabelElement>("label[for]")) expect(document.getElementById(label.htmlFor)).toBeTruthy();
  });

  it("starts a live blog in an ordinary editable Post", () => {
    render(<RecordForm kind="post" initial={{ title: "Ordinary Post", blocks: [], tags: [] }} canSave />);
    fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    expect(screen.getByRole("article", { name: "Live updates" })).toBeInTheDocument();
    expect(screen.getByLabelText("Coverage status")).toHaveValue("ongoing");
    expect(screen.getByRole("button", { name: "Add live update" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add live update" })).toHaveFocus();
  });

  it.each([{ canSave: false }, { canSave: true, readOnly: true }])("keeps creation behind Post editing permissions: %o", props => {
    render(<RecordForm kind="post" initial={{ title: "Ordinary Post", blocks: [], tags: [] }} {...props} />);
    expect(screen.getByRole("button", { name: "Start live blog draft" })).toBeDisabled();
  });

  it("confirms draft-only removal, saves null and can start again", async () => {
    const onSave = vi.fn(async record => ({ ...record, version: 4 }));
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: draft() }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    expect(screen.getByText("Remove the live blog from this Post? Draft updates are deleted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Remove live blog" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    expect(screen.getByRole("button", { name: "Start live blog draft" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].liveBlog).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    expect(screen.getByRole("button", { name: "Add live update" })).toBeEnabled();
  });

  it("retains removal while the first live blog save is still in flight", async () => {
    let resolveSave!: (record: Record<string, unknown>) => void;
    const onSave = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; })).mockResolvedValue(undefined);
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [] }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const sent = onSave.mock.calls[0][0];
    expect(sent.liveBlog).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    await act(async () => resolveSave({ ...sent, id: "post-live", version: 1 }));
    expect(screen.getByRole("button", { name: "Start live blog draft" })).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ id: "post-live", liveBlog: null });
  });

  it("does not offer removal after an entry has been public", () => {
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: draft(), published: { metadata: { liveBlog: published() } } }} canSave />);
    expect(screen.queryByRole("button", { name: "Remove live blog" })).toBeNull();
  });

  it("returns an ordinary Post to clean state after starting and removing an unsaved blog", async () => {
    const onDraftChange = vi.fn();
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [] }} canSave initialIsClean onDraftChange={onDraftChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove live blog" }));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(null));
  });

  it("clears a live-blog validation alert when the explanation is edited", async () => {
    const onSave = vi.fn(async record => ({ ...record, version: 4 }));
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: draft(), published: { metadata: { liveBlog: published() } } }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw update in this draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    const updates = within(screen.getByRole("article", { name: "Live updates" }));
    expect(updates.getByRole("alert")).toHaveTextContent(/withdrawal/i);
    fireEvent.change(screen.getByLabelText("Withdrawal explanation"), { target: { value: "The report could not be verified." } });
    expect(updates.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  });

  it("uses normal Save and adopts the server's canonical entry ids", async () => {
    const onSave = vi.fn(async record => ({ ...record, id: "post-a", version: 4,
      liveBlog: { ...record.liveBlog, updates: record.liveBlog.updates.map((entry: LiveBlogDraft["updates"][number]) => ({ ...entry, id: "canonical-entry" })) } }));
    const value = draft(); value.updates[0].id = "tmp-entry";
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: value }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Saved report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].liveBlog.updates[0].headline).toBe("Saved report");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Another saved report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0].liveBlog.updates[0].id).toBe("canonical-entry");
  });

  it("preserves newer reporting, disclosure and focus while a save adopts canonical ids", async () => {
    let acknowledge!: (value: Record<string, unknown>) => void;
    let sent!: Record<string, unknown>;
    const onSave = vi.fn((record: Record<string, unknown>) => {
      sent = record;
      return new Promise<Record<string, unknown>>(resolve => { acknowledge = resolve; });
    });
    const value = draft(); value.updates[0].id = "tmp-entry";
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: value }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const headline = screen.getByLabelText("Update headline");
    headline.focus();
    fireEvent.change(headline, { target: { value: "Reporting added during save" } });
    await act(async () => acknowledge({ ...sent, id: "post-a", version: 4,
      liveBlog: { ...value, updates: [{ ...value.updates[0], id: "canonical-entry" }] },
    }));
    expect(screen.getByLabelText("Update headline")).toBe(headline);
    expect(headline).toHaveValue("Reporting added during save");
    expect(headline).toHaveFocus();
    expect(headline.closest("details")).toHaveAttribute("open");
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it.each(["live_blog_presentation_unavailable", "live_blog_follow_ups_unavailable"])("shows temporary live blog readiness as a save error while keeping unsaved edits (%s)", async code => {
    const message = "Live blog appearance settings are temporarily unavailable. Your saved choices have not changed. Try again after the update.";
    const onSave = vi.fn(async () => { throw new HttpError(409, message, { code }); });
    const onReload = vi.fn();
    render(<RecordForm kind="post" initial={{ id: "post-a", title: "Coverage", blocks: [], tags: [], liveBlog: { ...draft(), presentation: { playful: true } }, version: 3 }} canSave allowIncomplete onSave={onSave} onReload={onReload} />);
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Unsaved reporting" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText("Update headline")).toHaveValue("Unsaved reporting");
    expect(screen.queryByText(/Someone else saved this record/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload record, discarding your changes" })).toBeNull();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("preserves a follow-up editor and focus when its server id arrives during further editing", async () => {
    let acknowledge!: (value: Record<string, unknown>) => void;
    let sent!: Record<string, unknown>;
    const onSave = vi.fn((record: Record<string, unknown>) => { sent = record; return new Promise<Record<string, unknown>>(resolve => { acknowledge = resolve; }); });
    const value = draft(); value.updates[0].id = "tmp-entry";
    value.updates[0].followUps = [{ id: "tmp-follow", body, credits: [{ kind: "custom", name: "Reporter" }] }];
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: value }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const editor = screen.getByRole("textbox", { name: "Body for follow-up 1" }); editor.focus();
    await act(async () => acknowledge({ ...sent, id: "post-a", version: 4,
      liveBlog: { ...value, updates: [{ ...value.updates[0], id: "canonical-entry", followUps: [{ ...value.updates[0].followUps![0], id: "canonical-follow" }] }] },
    }));
    expect(screen.getByRole("textbox", { name: "Body for follow-up 1" })).toBe(editor);
    expect(editor).toHaveFocus();
  });

  it("keeps the draft on a version conflict and offers reload recovery", async () => {
    const onSave = vi.fn(async () => { throw new HttpError(409, "The Post changed. Reload before saving."); });
    const onReload = vi.fn();
    render(<RecordForm kind="post" initial={{ id: "post-a", title: "Coverage", blocks: [], tags: [], liveBlog: draft(), version: 3 }} canSave allowIncomplete onSave={onSave} onReload={onReload} />);
    fireEvent.change(screen.getByLabelText("Update headline"), { target: { value: "Unsaved reporting" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Someone else saved this record/);
    expect(screen.getByLabelText("Update headline")).toHaveValue("Unsaved reporting");
    expect(screen.queryByRole("button", { name: /Save anyway/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload record, discarding your changes" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("keeps an update added while the previous draft is saving", async () => {
    let acknowledge!: (value: Record<string, unknown>) => void;
    let sent!: Record<string, unknown>;
    const onSave = vi.fn((record: Record<string, unknown>) => {
      sent = record;
      return new Promise<Record<string, unknown>>(resolve => { acknowledge = resolve; });
    });
    const value = draft(); value.updates[0].id = "tmp-entry";
    render(<RecordForm kind="post" initial={{ title: "Coverage", blocks: [], tags: [], liveBlog: value }} canSave allowIncomplete onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Add live update" }));
    const headline = screen.getByLabelText("Update headline");
    fireEvent.change(headline, { target: { value: "New update during save" } });
    await act(async () => acknowledge({ ...sent, id: "post-a", version: 4,
      liveBlog: { ...value, updates: [{ ...value.updates[0], id: "canonical-entry" }] },
    }));
    expect(headline).toHaveValue("New update during save");
    expect(headline).toHaveFocus();
    expect(screen.queryByText("Saved.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    const outgoing = onSave.mock.calls[1][0].liveBlog as LiveBlogDraft;
    expect(outgoing.updates).toHaveLength(2);
    expect(outgoing.updates[0]).toMatchObject({ id: expect.stringMatching(/^tmp-/), headline: "New update during save" });
    expect(outgoing.updates[1].id).toBe("canonical-entry");
    await act(async () => acknowledge({ ...sent, version: 5 }));
  });
});
