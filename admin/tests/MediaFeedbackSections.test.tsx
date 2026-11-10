import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFeedbackSections } from "../src/components/media/MediaFeedbackSections";
import { useMediaFeedback } from "../src/lib/use-media-feedback";

const BASE = "http://127.0.0.1:5001/demo-njpbs/us-central1";
const ref = { backend: "s3" as const, sourceId: "video-library", id: "video-1" };
const getIdToken = async () => "staff-token";
const originalReview = {
  moreLikeThis: false,
  notes: "Keep the natural sound.",
  version: 1,
  updatedAt: "2026-10-05T12:00:00.000Z",
};
const firstComment = {
  id: "1".repeat(64),
  authorUid: "staff-1",
  authorName: "Alex Rivera",
  text: "<strong>Keep this as text.</strong>",
  version: 1,
  createdAt: "2026-10-05T12:05:00.000Z",
  updatedAt: "2026-10-05T12:05:00.000Z",
  canEdit: true,
};
const secondComment = {
  ...firstComment,
  id: "2".repeat(64),
  authorName: "Morgan Lee",
  text: "The final frame works.",
  createdAt: "2026-10-05T12:10:00.000Z",
  updatedAt: "2026-10-05T12:10:00.000Z",
};

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function endpoint(input: RequestInfo | URL): string {
  return new URL(String(input)).pathname.split("/").at(-1)!;
}

function requestBody(call: FetchMock["mock"]["calls"][number]): Record<string, unknown> {
  return JSON.parse(call[1]!.body as string) as Record<string, unknown>;
}

function requestsFor(fetchMock: FetchMock, name: string) {
  return fetchMock.mock.calls.filter(([input]) => endpoint(input) === name);
}

function expectRequest(
  fetchMock: FetchMock,
  name: string,
  expectedBody: Record<string, unknown>,
  index = 0,
) {
  const call = requestsFor(fetchMock, name)[index]!;
  expect(call[0]).toBe(`${BASE}/${name}`);
  expect(new Headers(call[1]!.headers).get("Authorization")).toBe("Bearer staff-token");
  expect(requestBody(call)).toEqual(expectedBody);
}

function defaultResponse(name: string): Response {
  if (name === "cmsGetMediaReview") {
    return jsonResponse({ success: true, review: originalReview });
  }
  if (name === "cmsListMediaComments") {
    return jsonResponse({
      success: true,
      comments: [firstComment, secondComment],
      nextCursor: null,
    });
  }
  throw new Error(`Unexpected media feedback request: ${name}`);
}

function Harness() {
  const feedback = useMediaFeedback(ref, getIdToken);
  return <MediaFeedbackSections feedback={feedback} locked={false}
    onCommentDirtyChange={() => undefined} reviewSaveMode="separate" />;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("media feedback sections", () => {
  it("preserves a private draft across conflict reload and retries against the refreshed version", async () => {
    let reviewReads = 0;
    let reviewSaves = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const name = endpoint(input);
      if (name === "cmsGetMediaReview") {
        reviewReads += 1;
        return jsonResponse({
          success: true,
          review: reviewReads === 1
            ? originalReview
            : { ...originalReview, notes: "Saved elsewhere.", version: 2 },
        });
      }
      if (name === "cmsSaveMediaReview") {
        reviewSaves += 1;
        return reviewSaves === 1
          ? jsonResponse({
              error: "Media review changed. Reload and try again",
              code: "media_review_conflict",
            }, 409)
          : jsonResponse({
              success: true,
              review: { ...originalReview, notes: "My retained draft.", version: 3 },
            });
      }
      return defaultResponse(name);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    const notes = await screen.findByRole("textbox", { name: "Notes" });
    await waitFor(() => expect(notes).toHaveValue(originalReview.notes));
    expectRequest(fetchMock, "cmsGetMediaReview", { schemaVersion: 1, ref });
    expectRequest(fetchMock, "cmsListMediaComments", { schemaVersion: 1, ref, limit: 30 });

    fireEvent.change(notes, { target: { value: "My retained draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));

    expect(await screen.findByText("Media review changed. Reload and try again")).toBeVisible();
    expect(notes).toHaveValue("My retained draft.");
    expectRequest(fetchMock, "cmsSaveMediaReview", {
      schemaVersion: 1,
      ref,
      baseVersion: 1,
      moreLikeThis: false,
      notes: "My retained draft.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Reload current review" }));
    await waitFor(() => expect(requestsFor(fetchMock, "cmsGetMediaReview")).toHaveLength(2));
    expect(notes).toHaveValue("My retained draft.");
    expectRequest(fetchMock, "cmsGetMediaReview", { schemaVersion: 1, ref }, 1);

    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(requestsFor(fetchMock, "cmsSaveMediaReview")).toHaveLength(2));
    expectRequest(fetchMock, "cmsSaveMediaReview", {
      schemaVersion: 1,
      ref,
      baseVersion: 2,
      moreLikeThis: false,
      notes: "My retained draft.",
    }, 1);
    expect(await screen.findByText("Your private review is version 3.")).toBeVisible();
  });

  it("keeps a failed create draft, reuses its request id, and renders comment text without HTML", async () => {
    let mutations = 0;
    const createdComment = {
      ...firstComment,
      id: "3".repeat(64),
      text: "New newsroom note",
      createdAt: "2026-10-05T12:20:00.000Z",
      updatedAt: "2026-10-05T12:20:00.000Z",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const name = endpoint(input);
      if (name === "cmsMutateMediaComment") {
        mutations += 1;
        return mutations === 1
          ? jsonResponse({ error: "Comment save unavailable" }, 503)
          : jsonResponse({ success: true, comment: createdComment });
      }
      return defaultResponse(name);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    expect(await screen.findByText(firstComment.text)).toBeVisible();
    expect(screen.queryByText("Keep this as text.")).not.toBeInTheDocument();
    const draft = screen.getByRole("textbox", { name: "New comment" });
    fireEvent.change(draft, { target: { value: "New newsroom note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

    expect(await screen.findByText("Comment save unavailable")).toBeVisible();
    expect(draft).toHaveValue("New newsroom note");
    const firstMutation = requestsFor(fetchMock, "cmsMutateMediaComment")[0]!;
    const firstBody = requestBody(firstMutation);
    expect(firstBody.requestId).toMatch(/^[0-9a-f]{32}$/);
    expectRequest(fetchMock, "cmsMutateMediaComment", {
      schemaVersion: 1,
      ref,
      action: "create",
      requestId: firstBody.requestId,
      text: "New newsroom note",
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(requestsFor(fetchMock, "cmsMutateMediaComment")).toHaveLength(2));
    expectRequest(fetchMock, "cmsMutateMediaComment", {
      schemaVersion: 1,
      ref,
      action: "create",
      requestId: firstBody.requestId,
      text: "New newsroom note",
    }, 1);
    expect(await screen.findByText("New newsroom note")).toBeVisible();
    expect(draft).toHaveValue("");
  });

  it("links safe web addresses without interpreting other comment text", async () => {
    const url = "https://example.test/review?scene=one#note";
    const httpUrl = "http://example.test/plain";
    const parenthesizedUrl = "https://example.test/review_(final)";
    const smartQuotedUrl = "https://example.test/from-ipad";
    const linkedComment = {
      ...firstComment,
      text: `Review ${url}. Compare ${httpUrl}, then ${parenthesizedUrl}). Read “${smartQuotedUrl}”… Keep <strong>this as text</strong> and https://name:secret@example.test/private.`,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const name = endpoint(input);
      if (name === "cmsListMediaComments") {
        return jsonResponse({ success: true, comments: [linkedComment], nextCursor: null });
      }
      return defaultResponse(name);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    const link = await screen.findByRole("link", {
      name: `${url} (opens in a new tab)`,
    });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const comment = link.closest(".media-feedback-comment-text");
    expect(within(comment as HTMLElement).getByRole("link", {
      name: `${httpUrl} (opens in a new tab)`,
    })).toHaveAttribute("href", httpUrl);
    expect(within(comment as HTMLElement).getByRole("link", {
      name: `${parenthesizedUrl} (opens in a new tab)`,
    })).toHaveAttribute("href", parenthesizedUrl);
    expect(within(comment as HTMLElement).getByRole("link", {
      name: `${smartQuotedUrl} (opens in a new tab)`,
    })).toHaveAttribute("href", smartQuotedUrl);
    expect(comment).toHaveTextContent(linkedComment.text);
    expect(comment?.querySelector("strong")).toBeNull();
    expect(within(comment as HTMLElement).getAllByRole("link")).toHaveLength(4);
  });

  it("links each address when punctuation separates them without a space", async () => {
    const first = "https://one.test/a";
    const second = "https://two.test/b";
    const nested = "https://three.test/?urls=https://a.test,https://b.test&q=x.https://c.test";
    const linkedComment = { ...firstComment, text: `See ${first},${second};${first}. Also ${nested}.` };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const name = endpoint(input);
      if (name === "cmsListMediaComments") {
        return jsonResponse({ success: true, comments: [linkedComment], nextCursor: null });
      }
      return defaultResponse(name);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    const link = await screen.findByRole("link", { name: `${second} (opens in a new tab)` });
    expect(link).toHaveAttribute("href", second);
    const comment = link.closest(".media-feedback-comment-text") as HTMLElement;
    expect(within(comment).getAllByRole("link").map(item => item.getAttribute("href")))
      .toEqual([first, second, first, new URL(nested).href]);
    expect(comment).toHaveTextContent(linkedComment.text);
  });

  it("merges a created comment with a later page without duplicates and keeps chronological order", async () => {
    const comment = (number: number) => ({
      id: number.toString(16).padStart(64, "0"),
      authorUid: "staff-1",
      authorName: "Alex Rivera",
      text: `Comment ${String(number).padStart(2, "0")}`,
      version: 1,
      createdAt: `2026-10-05T12:${String(number).padStart(2, "0")}:00.000Z`,
      updatedAt: `2026-10-05T12:${String(number).padStart(2, "0")}:00.000Z`,
      canEdit: false,
    });
    const firstPage = Array.from({ length: 30 }, (_, index) => comment(index + 1));
    const created = comment(32);
    let commentReads = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const name = endpoint(input);
      if (name === "cmsGetMediaReview") {
        return jsonResponse({ success: true, review: originalReview });
      }
      if (name === "cmsListMediaComments") {
        commentReads += 1;
        return commentReads === 1
          ? jsonResponse({ success: true, comments: firstPage, nextCursor: "cursor-30" })
          : jsonResponse({ success: true, comments: [comment(31), created], nextCursor: null });
      }
      if (name === "cmsMutateMediaComment") {
        return jsonResponse({ success: true, comment: created });
      }
      throw new Error(`Unexpected media feedback request: ${name}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    await screen.findByText("Comment 30");
    const draft = screen.getByRole("textbox", { name: "New comment" });
    fireEvent.change(draft, { target: { value: "Comment 32" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await screen.findByText("Comment 32");

    const mutation = requestsFor(fetchMock, "cmsMutateMediaComment")[0]!;
    const mutationBody = requestBody(mutation);
    expectRequest(fetchMock, "cmsMutateMediaComment", {
      schemaVersion: 1,
      ref,
      action: "create",
      requestId: mutationBody.requestId,
      text: "Comment 32",
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
    await waitFor(() => expect(requestsFor(fetchMock, "cmsListMediaComments")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more comments" })).not.toBeInTheDocument());
    expectRequest(fetchMock, "cmsListMediaComments", {
      schemaVersion: 1,
      ref,
      limit: 30,
    });
    expectRequest(fetchMock, "cmsListMediaComments", {
      schemaVersion: 1,
      ref,
      cursor: "cursor-30",
      limit: 30,
    }, 1);

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(32);
    expect(rows.map(row => row.querySelector(".media-feedback-comment-text")?.textContent))
      .toEqual(Array.from({ length: 32 }, (_, index) => `Comment ${String(index + 1).padStart(2, "0")}`));
  });

  it("does not let a second owned comment replace an unsaved edit draft", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => defaultResponse(endpoint(input)));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    await screen.findByText(firstComment.text);
    expectRequest(fetchMock, "cmsGetMediaReview", { schemaVersion: 1, ref });
    expectRequest(fetchMock, "cmsListMediaComments", { schemaVersion: 1, ref, limit: 30 });

    const editButtons = screen.getAllByRole("button", { name: "Edit comment" });
    fireEvent.click(editButtons[0]);
    const draft = screen.getByRole("textbox", { name: `Edit comment by ${firstComment.authorName}` });
    fireEvent.change(draft, { target: { value: "Unsaved first edit" } });

    const remainingEdit = screen.getByRole("button", { name: "Edit comment" });
    expect(remainingEdit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete comment" })).toBeDisabled();
    expect(draft).toHaveValue("Unsaved first edit");
    expect(within(draft.closest("li")!).getByText(firstComment.authorName)).toBeVisible();
  });
});
