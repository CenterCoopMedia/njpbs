import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFeedbackSections } from "../src/components/media/MediaFeedbackSections";
import {
  commentThreads,
  filteredTimelineComments,
  mentionQuery,
  mentionsInText,
  namesMention,
  threadMatches,
} from "../src/lib/media-comment-threads";
import type { MediaComment } from "../src/lib/media-feedback";
import { useMediaFeedback } from "../src/lib/use-media-feedback";

const ref = { backend: "s3" as const, sourceId: "video-library", id: "video-1" };
const getIdToken = async () => "staff-token";
const STAFF = [
  { uid: "jody-e", name: "Jody Example" },
  { uid: "walter-c", name: "Walter Casey" },
  { uid: "jordan-e", name: "Jordan Example" },
];
const id = (n: number) => n.toString(16).padStart(64, "0");
const base = {
  version: 1,
  canEdit: false,
  parentId: null,
  mentions: [],
  mentionsYou: false,
  resolvedAt: null,
  resolvedBy: null,
  canResolve: true,
};
const lowerThird: MediaComment = {
  ...base,
  id: id(1),
  authorUid: "jody-e",
  authorName: "Jody Example",
  text: "Lower third covers the name. @Walter Casey can you check?",
  createdAt: "2026-10-05T14:01:00.000Z",
  updatedAt: "2026-10-05T14:01:00.000Z",
  mentions: [{ uid: "walter-c", name: "Walter Casey" }],
};
const lowerThirdReply: MediaComment = {
  ...base,
  id: id(2),
  authorUid: "walter-c",
  authorName: "Walter Casey",
  text: "Moved it up in the new export.",
  createdAt: "2026-10-05T14:02:00.000Z",
  updatedAt: "2026-10-05T14:02:00.000Z",
  parentId: id(1),
  canResolve: false,
};
const audio: MediaComment = {
  ...base,
  id: id(3),
  authorUid: "walter-c",
  authorName: "Walter Casey",
  text: "Audio dips under the music bed.",
  version: 2,
  createdAt: "2026-10-05T14:03:00.000Z",
  updatedAt: "2026-10-05T14:03:00.000Z",
  resolvedAt: "2026-10-05T14:09:00.000Z",
  resolvedBy: { uid: "jody-e", name: "Jody Example" },
};
const color: MediaComment = {
  ...base,
  id: id(4),
  authorUid: "me",
  authorName: "Sam Staff",
  text: "Color looks good overall.",
  canEdit: true,
  createdAt: "2026-10-05T14:04:00.000Z",
  updatedAt: "2026-10-05T14:04:00.000Z",
};
const COMMENTS = [lowerThird, lowerThirdReply, audio, color];

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function endpoint(input: RequestInfo | URL): string {
  return new URL(String(input)).pathname.split("/").at(-1)!;
}
function bodies(fetchMock: FetchMock, name: string) {
  return fetchMock.mock.calls
    .filter(([input]) => endpoint(input) === name)
    .map(call => JSON.parse(call[1]!.body as string) as Record<string, unknown>);
}

function install(
  mutate: (body: Record<string, unknown>) => Response,
  { comments = COMMENTS, nextCursor = null }: { comments?: MediaComment[]; nextCursor?: string | null } = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const name = endpoint(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (name === "cmsGetMediaReview") return json({ success: true, review: null });
    if (name === "cmsListMediaComments") {
      return body.staff === true
        ? json({ success: true, staff: STAFF })
        : json({ success: true, comments, nextCursor });
    }
    if (name === "cmsMutateMediaComment") return mutate(body);
    throw new Error(`Unexpected request: ${name}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Harness() {
  const feedback = useMediaFeedback(ref, getIdToken);
  return <MediaFeedbackSections feedback={feedback} locked={false}
    onCommentDirtyChange={() => undefined} reviewSaveMode="separate" />;
}

function threadList() {
  return screen.getByRole("list", { name: "Comment threads" });
}
function threadItem(text: string) {
  return within(threadList()).getAllByRole("listitem").find(item =>
    item.parentElement === threadList() && item.textContent?.includes(text))!;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("comment thread helpers", () => {
  it("groups replies under their first comment and filters whole threads", () => {
    const threads = commentThreads(COMMENTS);
    expect(threads.map(thread => [thread.comment.id, thread.replies.map(reply => reply.id)])).toEqual([
      [id(1), [id(2)]],
      [id(3), []],
      [id(4), []],
    ]);
    const shown = (filter: Parameters<typeof threadMatches>[1]) =>
      threads.filter(thread => threadMatches(thread, filter)).map(thread => thread.comment.id);
    expect(shown("open")).toEqual([id(1), id(4)]);
    expect(shown("resolved")).toEqual([id(3)]);
    expect(shown("mine")).toEqual([id(4)]);
    expect(shown("mentions")).toEqual([]);
    expect(shown("all")).toEqual([id(1), id(3), id(4)]);
    // A reply that mentions the reader brings its whole thread into Mentions me.
    const mentioned = commentThreads([lowerThird, { ...lowerThirdReply, mentionsYou: true }]);
    expect(threadMatches(mentioned[0], "mentions")).toBe(true);
    // A reply whose first comment is not loaded still shows.
    expect(commentThreads([lowerThirdReply]).map(thread => thread.comment.id)).toEqual([id(2)]);
  });

  it("puts only first comments of shown threads on the timeline", () => {
    expect(filteredTimelineComments(COMMENTS, "open").map(comment => comment.id)).toEqual([id(1), id(4)]);
    expect(filteredTimelineComments(COMMENTS, "resolved").map(comment => comment.id)).toEqual([id(3)]);
  });

  it("finds an @ query at the caret and keeps only mentions still in the text", () => {
    expect(mentionQuery("Thanks @jo", 10)).toEqual({ start: 7, query: "jo" });
    expect(mentionQuery("@Jody E", 7)).toEqual({ start: 0, query: "Jody E" });
    expect(mentionQuery("mail me@example", 15)).toBeNull();
    expect(mentionQuery("@Jody Example Extra", 19)).toBeNull();
    expect(mentionQuery("@jo\nnext", 8)).toBeNull();
    expect(mentionsInText("Hi @Jody Example", STAFF).map(person => person.uid)).toEqual(["jody-e"]);
  });

  it("matches a mention only when the whole picked name is there", () => {
    const ann = { uid: "ann", name: "Ann" };
    const anna = { uid: "anna", name: "Anna" };
    // Ann was picked, then the text changed to @Anna: Ann is no longer mentioned.
    expect(mentionsInText("Thanks @Anna", [ann])).toEqual([]);
    // Both were picked and only @Anna is left.
    expect(mentionsInText("Thanks @Anna", [ann, anna]).map(person => person.uid)).toEqual(["anna"]);
    expect(mentionsInText("@Ann, @Anna.", [ann, anna]).map(person => person.uid)).toEqual(["ann", "anna"]);
    expect(namesMention("@Annabel and @Ann", "Ann")).toBe(true);
    expect(namesMention("@Ann-Marie", "Ann")).toBe(false);
    expect(namesMention("@Jody Example's cut", "Jody Example")).toBe(false);
    expect(namesMention("@Jody Example?", "Jody Example")).toBe(true);
  });
});

describe("comment threads in the inspector", () => {
  it("shows threads as a list with nested reply lists and resolve state in text", async () => {
    install(() => json({}, 500));
    render(<Harness />);
    await screen.findByText(lowerThird.text);

    // Open is the default filter, so the resolved thread is hidden.
    expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue("open");
    expect(screen.queryByText(audio.text)).not.toBeInTheDocument();
    const options = within(screen.getByRole("combobox", { name: "Show" })).getAllByRole("option");
    expect(options.map(option => option.textContent)).toEqual([
      "Open (2)", "Resolved (1)", "Mine (1)", "Mentions me (0)", "All (3)",
    ]);
    const thread = threadItem(lowerThird.text);
    const replies = within(thread).getByRole("list", { name: "Replies to Jody Example" });
    expect(within(replies).getAllByRole("listitem").map(item => item.querySelector(".media-feedback-comment-text")?.textContent))
      .toEqual([lowerThirdReply.text]);
    expect(within(thread).getByText("Mentioned: Walter Casey")).toBeVisible();
    // Replies have no resolve control, and a first comment with replies has no delete.
    expect(within(replies).queryByRole("button", { name: /Mark resolved/ })).not.toBeInTheDocument();
    expect(within(threadItem(color.text)).getByRole("button", { name: "Delete comment" })).toBeVisible();

    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "resolved" } });
    const resolved = threadItem(audio.text);
    expect(within(resolved).getByText("Resolved")).toBeVisible();
    expect(resolved.querySelector(".media-feedback-resolved")?.textContent)
      .toBe("Resolved by Jody Example · Oct 5, 2026, 10:09 AM ET");
    expect(within(resolved).getByRole("button", { name: "Reopen" })).toBeVisible();
  });

  it("resolves a thread, announces that the filter hides it, and moves focus to the next thread", async () => {
    const fetchMock = install(() => json({
      success: true,
      comment: { ...lowerThird, version: 2, resolvedAt: "2026-10-05T15:00:00.000Z", resolvedBy: { uid: "me", name: "Sam Staff" } },
    }));
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    fireEvent.click(within(threadItem(lowerThird.text)).getByRole("button", { name: "Mark resolved" }));

    await waitFor(() => expect(screen.queryByText(lowerThird.text)).not.toBeInTheDocument());
    const [body] = bodies(fetchMock, "cmsMutateMediaComment");
    expect(body).toEqual({
      schemaVersion: 1,
      ref,
      action: "resolve",
      requestId: body.requestId,
      commentId: id(1),
      baseVersion: 1,
    });
    expect(screen.getByText(/Thread marked resolved\. The Open filter now hides it/)).toBeVisible();
    await waitFor(() => expect(document.activeElement).toBe(threadItem(color.text)));
  });

  it("reuses the request id when a reopen is retried and keeps focus on the thread", async () => {
    let calls = 0;
    const fetchMock = install(() => {
      calls += 1;
      return calls === 1
        ? json({ error: "Comment service unavailable" }, 503)
        : json({ success: true, comment: { ...audio, version: 3, resolvedAt: null, resolvedBy: null } });
    });
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    fireEvent.change(screen.getByRole("combobox", { name: "Show" }), { target: { value: "all" } });
    fireEvent.click(within(threadItem(audio.text)).getByRole("button", { name: "Reopen" }));
    expect(await screen.findByText("Comment service unavailable")).toBeVisible();
    fireEvent.click(within(threadItem(audio.text)).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(bodies(fetchMock, "cmsMutateMediaComment")).toHaveLength(2));
    const [first, second] = bodies(fetchMock, "cmsMutateMediaComment");
    expect(second).toEqual(first);
    expect(first).toMatchObject({ action: "reopen", commentId: id(3), baseVersion: 2 });
    const reopenedButton = await within(threadItem(audio.text)).findByRole("button", { name: "Mark resolved" });
    await waitFor(() => expect(document.activeElement).toBe(reopenedButton));
    expect(screen.getByText("Thread reopened.")).toBeVisible();
  });

  it("supports a keyboard-only reply with a mention picked from the staff list", async () => {
    const fetchMock = install(body => json({
      success: true,
      comment: {
        ...base,
        id: id(9),
        authorUid: "me",
        authorName: "Sam Staff",
        text: body.text,
        canEdit: true,
        canResolve: false,
        parentId: id(1),
        mentions: [{ uid: "jordan-e", name: "Jordan Example" }],
        createdAt: "2026-10-05T15:00:00.000Z",
        updatedAt: "2026-10-05T15:00:00.000Z",
      },
    }));
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    fireEvent.click(within(threadItem(lowerThird.text)).getByRole("button", { name: "Reply to Jody Example" }));
    const field = screen.getByRole("textbox", { name: "Reply to Jody Example" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveAttribute("aria-autocomplete", "list");

    fireEvent.change(field, { target: { value: "Thanks @jo", selectionStart: 10 } });
    const listbox = await screen.findByRole("listbox", { name: "Staff to mention" });
    expect(bodies(fetchMock, "cmsListMediaComments").filter(body => body.staff === true)).toEqual([
      { schemaVersion: 1, ref, staff: true },
    ]);
    // "jo" starts a word in Jody Example and Jordan Example, not in Walter Casey.
    expect(within(listbox).getAllByRole("option").map(option => option.textContent))
      .toEqual(["Jody Example", "Jordan Example"]);
    expect(field).toHaveAttribute("aria-controls", listbox.id);
    expect(field).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    const active = within(listbox).getAllByRole("option")[1];
    expect(field).toHaveAttribute("aria-activedescendant", active.id);
    expect(active).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field).toHaveAttribute("aria-activedescendant", within(listbox).getAllByRole("option")[0].id);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(field).toHaveValue("Thanks @Jordan Example ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(field).toHaveFocus();

    // Escape closes an open list without leaving the field.
    fireEvent.change(field, { target: { value: "Thanks @Jordan Example and @wa", selectionStart: 30 } });
    expect(await screen.findByRole("listbox", { name: "Staff to mention" })).toBeVisible();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "Thanks @Jordan Example, can you confirm?", selectionStart: 40 } });

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(bodies(fetchMock, "cmsMutateMediaComment")).toHaveLength(1));
    const [body] = bodies(fetchMock, "cmsMutateMediaComment");
    expect(body).toEqual({
      schemaVersion: 1,
      ref,
      action: "create",
      requestId: body.requestId,
      text: "Thanks @Jordan Example, can you confirm?",
      parentId: id(1),
      mentions: ["jordan-e"],
    });
    const replies = within(threadItem(lowerThird.text)).getByRole("list", { name: "Replies to Jody Example" });
    await waitFor(() => expect(within(replies).getAllByRole("listitem")).toHaveLength(2));
    // Focus moves to the new reply, which is announced as part of the thread.
    await waitFor(() => expect(document.activeElement?.id).toBe(`media-comment-${id(9)}`));
    expect(screen.getByText("Reply added to the thread by Jody Example.")).toBeVisible();
  });

  it("does not send a mention whose name was removed from the text", async () => {
    const fetchMock = install(body => json({
      success: true,
      comment: { ...color, id: id(10), text: body.text, createdAt: "2026-10-05T15:00:00.000Z", updatedAt: "2026-10-05T15:00:00.000Z" },
    }));
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    const field = screen.getByRole("textbox", { name: "New comment" });
    fireEvent.change(field, { target: { value: "@wal", selectionStart: 4 } });
    await screen.findByRole("listbox", { name: "Staff to mention" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toHaveValue("@Walter Casey ");
    fireEvent.change(field, { target: { value: "Never mind, it is fine.", selectionStart: 23 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    });
    await waitFor(() => expect(bodies(fetchMock, "cmsMutateMediaComment")).toHaveLength(1));
    expect(bodies(fetchMock, "cmsMutateMediaComment")[0]).not.toHaveProperty("mentions");
  });
  it("keeps a renamed person's mention when an edit does not remove it", async () => {
    // The saved text holds the old name. The projection gives the current name.
    const renamed: MediaComment = {
      ...color,
      text: "Check the color @Walter Casey",
      mentions: [{ uid: "walter-c", name: "Walter C. Casey" }],
    };
    let version = 1;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const name = endpoint(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (name === "cmsGetMediaReview") return json({ success: true, review: null });
      if (name === "cmsListMediaComments") {
        return body.staff === true
          ? json({ success: true, staff: STAFF })
          : json({ success: true, comments: [renamed], nextCursor: null });
      }
      version += 1;
      return json({ success: true, comment: { ...renamed, text: body.text, version,
        mentions: Array.isArray(body.mentions) ? [] : renamed.mentions } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    await screen.findByText(renamed.text);

    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit comment by Sam Staff" }),
      { target: { value: "Check the color @Walter Casey, please", selectionStart: 37 } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    await waitFor(() => expect(bodies(fetchMock, "cmsMutateMediaComment")).toHaveLength(1));
    // The mention did not change, so the edit leaves it out and the server keeps the stored ID.
    expect(bodies(fetchMock, "cmsMutateMediaComment")[0]).not.toHaveProperty("mentions");
  });

  it("removes a stored mention when the edit deletes its @name", async () => {
    const fetchMock = install(body => json({ success: true, comment: { ...lowerThird, canEdit: true, text: body.text, version: 2, mentions: [] } }));
    // Make the first comment editable by the reader.
    COMMENTS[0] = { ...lowerThird, canEdit: true };
    try {
      render(<Harness />);
      await screen.findByText(lowerThird.text);
      fireEvent.click(within(threadItem(lowerThird.text)).getByRole("button", { name: "Edit comment" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Edit comment by Jody Example" }),
        { target: { value: "Lower third covers the name.", selectionStart: 28 } });
      fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
      await waitFor(() => expect(bodies(fetchMock, "cmsMutateMediaComment")).toHaveLength(1));
      expect(bodies(fetchMock, "cmsMutateMediaComment")[0]).toMatchObject({ action: "edit", mentions: [] });
    } finally {
      COMMENTS[0] = lowerThird;
    }
  });

  it("opens the picker again after Escape once the query is gone and after a send", async () => {
    install(body => json({
      success: true,
      comment: { ...color, id: id(11), text: body.text, createdAt: "2026-10-05T15:00:00.000Z", updatedAt: "2026-10-05T15:00:00.000Z" },
    }));
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    const field = screen.getByRole("textbox", { name: "New comment" });
    fireEvent.change(field, { target: { value: "@wa", selectionStart: 3 } });
    await screen.findByRole("listbox", { name: "Staff to mention" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // More typing in the closed query keeps it closed.
    fireEvent.change(field, { target: { value: "@wal", selectionStart: 4 } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(field, { target: { value: "@", selectionStart: 1 } });
    expect(await screen.findByRole("listbox", { name: "Staff to mention" })).toBeVisible();

    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.change(field, { target: { value: "@ looks fine", selectionStart: 12 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    });
    await waitFor(() => expect(field).toHaveValue(""));
    fireEvent.change(field, { target: { value: "@", selectionStart: 1 } });
    expect(await screen.findByRole("listbox", { name: "Staff to mention" })).toBeVisible();
  });
  it("hides Delete while an unloaded page may hold replies and shows it once every page is loaded", async () => {
    const withReplies = { ...color, hasReplies: true };
    // A full first page, so the inspector stops loading and keeps a next page. The other
    // threads are resolved and the Open filter hides them.
    const fullPage = [withReplies, ...Array.from({ length: 29 }, (_, index) => ({ ...audio, id: id(100 + index) }))];
    install(() => json({}, 500), { comments: fullPage, nextCursor: "next-page" });
    const { unmount } = render(<Harness />);
    await screen.findByText(color.text);
    expect(within(threadItem(color.text)).getByRole("button", { name: "Edit comment" })).toBeVisible();
    expect(within(threadItem(color.text)).queryByRole("button", { name: "Delete comment" })).not.toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();

    // With every page loaded, the loaded replies are complete.
    install(() => json({}, 500), { comments: [withReplies], nextCursor: null });
    render(<Harness />);
    await screen.findByText(color.text);
    expect(within(threadItem(color.text)).getByRole("button", { name: "Delete comment" })).toBeVisible();
  });

  it("says where a new comment went when the filter hides it and moves focus to the filter", async () => {
    install(body => json({
      success: true,
      comment: { ...color, id: id(12), text: body.text, createdAt: "2026-10-05T15:00:00.000Z", updatedAt: "2026-10-05T15:00:00.000Z" },
    }));
    render(<Harness />);
    await screen.findByText(lowerThird.text);
    const show = screen.getByRole("combobox", { name: "Show" });
    fireEvent.change(show, { target: { value: "resolved" } });
    fireEvent.change(screen.getByRole("textbox", { name: "New comment" }), { target: { value: "Check the fade out", selectionStart: 18 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    });
    expect(await screen.findByText("Comment added. The Resolved filter hides it. Choose All in Show to see it.")).toBeVisible();
    await waitFor(() => expect(show).toHaveFocus());
    expect(screen.queryByText("Check the fade out")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Open (3)" })).toBeInTheDocument();
  });
});
