import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaFeedbackSections } from "../src/components/media/MediaFeedbackSections";
import { useMediaFeedback } from "../src/lib/use-media-feedback";
import type { MediaComment } from "../src/lib/media-feedback";

const comment: MediaComment = {
  id: "a".repeat(64), authorUid: "staff", authorName: "José, 李", text: 'Check "intro"',
  version: 1, createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", canEdit: true,
};
const getIdToken = async () => "test-token";
function Harness({ id = "video-1" }: { id?: string }) {
  const feedback = useMediaFeedback({ backend: "s3", sourceId: "video-library", id }, getIdToken);
  return <MediaFeedbackSections feedback={feedback} onCommentDirtyChange={() => undefined} reviewSaveMode="separate" />;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

function install(exportResponse: () => Promise<Response>) {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const endpoint = new URL(String(input)).pathname.split("/").at(-1);
    const body = JSON.parse(String(init?.body));
    requests.push({ endpoint, ...body });
    if (endpoint === "cmsGetMediaReview") return json({ success: true, review: null });
    if (endpoint === "cmsListMediaComments") return body.export
      ? exportResponse()
      : json({ success: true, comments: [comment], nextCursor: "more-comments" });
    throw new Error(`Unexpected endpoint ${endpoint}`);
  }));
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return "blob:comment-export"; }
    static revokeObjectURL() {}
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return { requests, blobs, click };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("comment CSV download", () => {
  it("fetches the selected filter on demand, recovers from failure and includes unloaded replies", async () => {
    let reply: (response: Response) => void;
    const exported = { ...comment, id: "b".repeat(64), parentId: comment.id, text: "Reply beyond first page" };
    const { requests, blobs, click } = install(() => new Promise(resolve => { reply = resolve; }));
    render(<Harness />);
    const button = await screen.findByRole("button", { name: "Export CSV" });
    expect(requests.filter(request => request.export)).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "resolved" } });
    fireEvent.click(button);
    await waitFor(() => expect(requests.filter(request => request.export)).toHaveLength(1));
    expect(requests.at(-1)).toMatchObject({ export: "resolved", ref: { id: "video-1" } });
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
    await act(async () => reply!(json({ error: "Access changed. Try again." }, 403)));
    expect(await screen.findByText("Access changed. Try again.")).toBeVisible();
    expect(blobs).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(requests.filter(request => request.export)).toHaveLength(2));
    await act(async () => reply!(json({ success: true, exported: true, comments: [comment, exported] })));
    expect(await screen.findByText("Downloaded 2 comments (Resolved).")).toBeVisible();
    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
    const csv = await new Promise<string>(resolve => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blobs[0]);
    });
    expect(csv).toContain("Reply beyond first page");
    expect(csv).toContain('"José, 李","Check ""intro"""');
  });

  it.each(["unmount", "switch"])("discards a pending export after %s", async mode => {
    let reply: (response: Response) => void;
    const { requests, blobs } = install(() => new Promise(resolve => { reply = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(requests.some(request => request.export)).toBe(true));
    if (mode === "unmount") view.unmount();
    else view.rerender(<Harness id="video-2" />);
    await act(async () => reply!(json({ success: true, exported: true, comments: [comment] })));
    expect(blobs).toHaveLength(0);
    expect(screen.queryByText(/Downloaded/)).toBeNull();
  });

  it("refuses an unaudited legacy page response instead of downloading a partial CSV", async () => {
    const { blobs } = install(async () => json({ success: true, comments: [comment], nextCursor: "more" }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Comment export is not available. Reload and try again.")).toBeVisible();
    expect(blobs).toHaveLength(0);
  });
});
