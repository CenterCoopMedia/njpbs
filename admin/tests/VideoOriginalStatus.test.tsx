import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useVideoOriginalStatus, VideoOriginalNotices, VideoOriginalStatus as OriginalControls } from "../src/components/media/VideoOriginalStatus";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
const asset: SourceMediaAssetSummary = { id: "video-1", sourceId: "video-library", name: "News master", originalName: "news.mxf",
  description: null, mimeType: "application/mxf", kind: "video", sizeBytes: 1000, preview: "download_only",
  license: null, credit: null, tags: [], rightsStatus: "complete", version: 1, fileVersion: "version-a", createdAt: null, updatedAt: null };
const getIdToken = async () => "staff-test-token";
function VideoOriginalStatus({ asset, getIdToken, canManageVideo = true }: { asset: SourceMediaAssetSummary; getIdToken: () => Promise<string>; canManageVideo?: boolean }) {
  return <OriginalControls controls={useVideoOriginalStatus(asset, getIdToken, canManageVideo)} />;
}
const original = (state: string) => ({ state, archiveTier: "DEEP_ARCHIVE_ACCESS", checkedAt: "2026-10-17T18:00:00Z" });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([
  ["2026-11-16T00:00:00.000Z", "Available until Nov. 15, 7:00 PM ET"],
  ["2026-07-16T00:00:00.000Z", "Available until July 15, 8:00 PM ET"],
  [undefined, null],
  ["invalid", null],
])("shows a restored original's available-until time in Eastern time (%s)", async (availableUntil, label) => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ success: true,
    original: { ...original("restored"), archiveTier: null, availableUntil } })));
  render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} />);
  await screen.findByText("Original restored");
  if (label) {
    expect(screen.getByText(label)).toHaveAttribute("datetime", availableUntil);
  } else {
    expect(screen.queryByText(/Available until/)).not.toBeInTheDocument();
  }
});
it("offers restore with the Standard wait and changes to restoring after acceptance", async () => {
  const payloads: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
    const body = JSON.parse(init.body); payloads.push(body);
    return json({ success: true, original: original(body.action === "restore" ? "restoring" : "archived") });
  }));
  render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} />);
  const restore = await screen.findByRole("button", { name: "Restore original" });
  expect(screen.getByText(/Standard retrieval.*12 hours/)).toBeInTheDocument();
  fireEvent.click(restore);
  await screen.findByText("Original restoring");
  expect(screen.queryByRole("button", { name: "Restore original" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check original status" })).toHaveFocus();
  expect(screen.getByText(/viewing copy and saved transcripts remain available/)).toBeInTheDocument();
  expect(payloads).toEqual([{ action: "status", sourceId: asset.sourceId, assetId: asset.id }, { action: "restore", sourceId: asset.sourceId, assetId: asset.id }]);
});
it.each([
  ["Viewer", false, null, false],
  ["Viewer on Intelligent-Tiering", false, "DEEP_ARCHIVE_ACCESS", true],
  ["video manager", true, null, true],
])("matches the server restore rule for a %s", async (_label, canManageVideo, archiveTier, offered) => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ success: true, original: { ...original("archived"), archiveTier } })));
  render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} canManageVideo={canManageVideo} />);
  await screen.findByRole("button", { name: offered ? "Restore original" : "Check original status" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Check original status" })).toBeEnabled());
  expect(screen.getByText("Original archived")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore original" }) !== null).toBe(offered);
  expect(screen.queryByText(/Ask a person who manages video/) !== null).toBe(!offered);
});
it("keeps a lost restore request honest and offers a status check", async () => {
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
    if (JSON.parse(init.body).action === "restore") throw new TypeError("Connection lost");
    return json({ success: true, original: original(++checks === 1 ? "archived" : "restored") });
  }));
  render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore original" }));
  await screen.findByText(/restore request could not be confirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Check original status" }));
  await screen.findByText("Original restored");
});
it("keeps focus in an editor the user entered during a status check", async () => {
  let calls = 0;
  let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async () => ++calls === 1
    ? json({ success: true, original: original("available") })
    : await new Promise<Response>(resolve => { finish = resolve; })));
  render(<><VideoOriginalStatus asset={asset} getIdToken={getIdToken} /><input aria-label="Video title" /></>);
  await screen.findByText("Original available");
  const check = screen.getByRole("button", { name: "Check original status" });
  check.focus();
  fireEvent.click(check);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const editor = screen.getByRole("textbox", { name: "Video title" });
  editor.focus();
  await act(async () => finish!(json({ success: true, original: original("available") })));
  expect(check).toBeEnabled();
  expect(editor).toHaveFocus();
});
it.each([
  [409, "Ask a CMS administrator to restore this storage class."],
  [429, "This restore has enough requests. Check its status later."],
])("shows a definite restore refusal from HTTP %s", async (status, message) => {
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => JSON.parse(init.body).action === "restore"
    ? new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } })
    : json({ success: true, original: original("archived") })));
  render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restore original" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByText(/request could not be confirmed/)).not.toBeInTheDocument();
});
it("does not apply an old file's delayed status to another video", async () => {
  let resolveOld: ((value: Response) => void) | undefined;
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => JSON.parse(init.body).assetId === asset.id
    ? await new Promise<Response>(resolve => { resolveOld = resolve; }) : json({ success: true, original: original("available") })));
  const view = render(<VideoOriginalStatus asset={asset} getIdToken={getIdToken} />);
  await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
  view.rerender(<VideoOriginalStatus asset={{ ...asset, id: "new-video", fileVersion: "new-version" }} getIdToken={getIdToken} />);
  await screen.findByText("Original available");
  await act(async () => resolveOld!(json({ success: true, original: original("archived") })));
  expect(screen.queryByRole("button", { name: "Restore original" })).not.toBeInTheDocument();
});
it("shows a saved requester notice and supports Open video and explicit dismissal", async () => {
  const open = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => JSON.parse(init.body).action === "notices"
    ? json({ success: true, notices: [{ id: "a".repeat(64), assetId: asset.id, sourceId: asset.sourceId, name: asset.name, outcome: "restored" }] }) : json({ success: true })));
  render(<VideoOriginalNotices sourceId={asset.sourceId} getIdToken={getIdToken} onOpen={open} />);
  await screen.findByText("Original restored");
  fireEvent.click(screen.getByRole("button", { name: "Open video" })); expect(open).toHaveBeenCalledWith(asset.id);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByText("Original restored")).not.toBeInTheDocument());
});
