import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaRecycleBin, removalCountdown } from "../src/components/MediaRecycleBin";
import { HttpError, type BinnedMediaAsset } from "../src/lib/functions";

const mocks = vi.hoisted(() => ({ list: vi.fn(), restore: vi.fn(), token: vi.fn() }));
vi.mock("../src/lib/functions", async original => ({
  ...await original<typeof import("../src/lib/functions")>(),
  cmsListBinnedMedia: mocks.list,
  cmsRestoreMedia: mocks.restore,
}));

const now = Date.parse("2026-09-25T12:00:00Z");
function asset(id = "photo", days = 2): BinnedMediaAsset {
  return {
    id, name: id, originalName: `${id}.png`, category: "news", categories: ["news"], tags: [],
    description: null, altText: null, license: null, credit: null, mimeType: "image/png", kind: "image",
    sizeBytes: 20, width: 100, height: 100, url: `https://media.example/${id}.png`,
    thumbnails: [{ url: `https://media.example/${id}-thumb.webp`, width: 96, height: 96 }],
    lifecycle: "tombstoned", version: 2, etag: `"media.${id}.2"`,
    createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
    purgeAfter: new Date(now + days * 86_400_000).toISOString(), tombstonedAt: "2026-09-24T12:00:00Z", tombstonedByName: "Pat Editor",
  };
}
function page(records: BinnedMediaAsset[], current = 1, pageCount = 1) {
  return { success: true, records, total: records.length, page: current, pageCount };
}
function open(targetId?: string) {
  return render(<MemoryRouter><MediaRecycleBin getIdToken={mocks.token} categories={[]} targetId={targetId} /></MemoryRouter>);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.token.mockResolvedValue("token");
  mocks.list.mockResolvedValue(page([asset()]));
  mocks.restore.mockResolvedValue({ success: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("removal countdown", () => {
  it.each([
    [30 * 86_400_000, "Removed in 30 days"],
    [86_400_001, "Removed in 2 days"],
    [86_400_000, "Removed in 1 day"],
    [1, "Removed in 1 day"], [0, "Due for removal"], [-1, "Due for removal"],
  ])("handles %i milliseconds left", (remaining, expected) => {
    expect(removalCountdown(new Date(now + remaining).toISOString(), now)).toBe(expected);
  });
  it("does not show NaN for a missing deadline", () => expect(removalCountdown("", now)).toBe("Removal date unavailable"));
});

describe("image recycle bin", () => {
  it("lists thumbnails, deletion details and deadlines in ascending order", async () => {
    mocks.list.mockResolvedValue(page([asset("later", 30), asset("sooner", 1)]));
    open();
    const list = await screen.findByRole("list", { name: "Binned images" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map(row => row.getAttribute("aria-label"))).toEqual(["sooner", "later"]);
    expect(within(rows[0]).getByText("news")).toBeVisible();
    expect(within(rows[0]).getByText("Pat Editor")).toBeVisible();
    expect(rows[0].querySelector("time")).toHaveAttribute("datetime", "2026-09-24T12:00:00Z");
    expect(rows[0].querySelector("img")).toHaveAttribute("src", "https://media.example/sooner-thumb.webp");
    expect(within(rows[0]).getByText("Removed in 1 day")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Images" })).toHaveAttribute("href", "/media/images");
  });
  it.each([null, "", "   "])("uses a neutral deletion actor for %s", async name => {
    mocks.list.mockResolvedValue(page([{ ...asset(), ...{ tombstonedBy: "private-uid" }, tombstonedByName: name }]));
    open();
    expect(await screen.findByText("A staff member")).toBeVisible();
    expect(screen.queryByText("private-uid")).not.toBeInTheDocument();
  });
  it("announces the busy restore state and clears success on refresh", async () => {
    let finish!: () => void;
    mocks.restore.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Restore photo" }));
    expect(await screen.findByRole("button", { name: "Restoring photo" })).toBeDisabled();
    await act(async () => finish());
    expect(await screen.findByRole("status")).toHaveTextContent("Restored");
    fireEvent.click(screen.getByRole("button", { name: "Refresh bin" }));
    await screen.findByRole("button", { name: "Restore photo" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("clears success when paging or changing the target list", async () => {
    mocks.list.mockResolvedValue(page([asset()], 1, 2));
    const view = open();
    fireEvent.click(await screen.findByRole("button", { name: "Restore photo" }));
    await screen.findByRole("status");
    await screen.findByRole("button", { name: "Next bin page" });
    mocks.list.mockResolvedValue(page([asset("next")], 2, 2));
    fireEvent.click(screen.getByRole("button", { name: "Next bin page" }));
    const restoreNext = await screen.findByRole("button", { name: "Restore next" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(restoreNext);
    await screen.findByRole("status");
    await screen.findByRole("button", { name: "Restore next" });
    view.rerender(<MemoryRouter><MediaRecycleBin getIdToken={mocks.token} categories={[]} targetId="next" /></MemoryRouter>);
    await screen.findByRole("button", { name: "Restore next" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("shows no action for an image being removed", async () => {
    mocks.list.mockResolvedValue(page([{ ...asset(), lifecycle: "purging" }]));
    open();
    expect(await screen.findByText("Being removed")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Restore / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete now/ })).not.toBeInTheDocument();
  });
  it("restores using the listed asset and announces success with stable focus", async () => {
    const row = asset();
    open();
    const restore = await screen.findByRole("button", { name: "Restore photo" });
    restore.focus();
    expect(restore).toHaveFocus();
    expect(restore.tagName).toBe("BUTTON"); // Native Enter/Space activation, no custom keyboard handler.
    mocks.list.mockResolvedValue(page([]));
    fireEvent.click(restore);
    expect(await screen.findByRole("status")).toHaveTextContent("Restored “photo” to the image library.");
    expect(mocks.restore).toHaveBeenCalledWith("token", row);
    expect(await screen.findByText("The recycle bin is empty")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recycle bin" })).toHaveFocus();
  });
  it.each([
    [409, "This image is being removed or has already been removed.", "being removed or has already been removed"],
    [409, "Restore the image's primary and assigned categories before restoring this image.", "Restore the image's primary and assigned categories"],
    [409, "The active media library is full.", "active media library is full"],
    [412, "This media asset changed since you opened it. Reload before saving.", "Use Refresh bin"],
    [409, "The stored media object cannot be verified.", "stored media object cannot be verified"],
    [404, "Not found", "Not found"],
  ])("explains a %i restore refusal: %s", async (status, message, expected) => {
    mocks.restore.mockRejectedValue(new HttpError(status, message));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Restore photo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    if (status === 412) expect(screen.getByRole("alert").textContent?.match(/refresh/gi)).toHaveLength(1);
    expect(screen.queryByText(/Restored “/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh bin" })).toBeEnabled();
  });
  it("loads only on mount, reports load errors and allows retry", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Connection failed"));
    open();
    expect(screen.getByText("Loading recycle bin")).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection failed");
    fireEvent.click(screen.getByRole("button", { name: "Refresh bin" }));
    expect(await screen.findByRole("button", { name: "Restore photo" })).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  it("locates and focuses a duplicate on a later page, then allows paging back", async () => {
    mocks.list.mockResolvedValueOnce(page([asset("other")], 1, 2)).mockResolvedValueOnce(page([asset()], 2, 2)).mockResolvedValue(page([asset("other")], 1, 2));
    open("photo");
    expect(await screen.findByRole("button", { name: "Restore photo" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("listitem", { name: "photo" })).toHaveFocus());
    expect(mocks.list).toHaveBeenNthCalledWith(2, "token", { page: 2 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Previous bin page" }));
    expect(await screen.findByRole("button", { name: "Restore other" })).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });
  it("explains an unavailable duplicate without claiming it can be restored", async () => {
    mocks.list.mockResolvedValueOnce(page([asset("first")], 1, 2)).mockResolvedValueOnce(page([asset("last")], 2, 2));
    open("missing");
    expect(await screen.findByText(/The matching image is no longer in this bin/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Restore first" })).toBeVisible();
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
  });
  it("keeps focus on the heading after restoring another row beside a duplicate target", async () => {
    mocks.list.mockResolvedValue(page([asset("target"), asset("other")]));
    open("target");
    await screen.findByRole("button", { name: "Restore other" });
    expect(screen.getByRole("listitem", { name: "target" })).toHaveFocus();
    mocks.list.mockResolvedValue(page([asset("target")]));
    fireEvent.click(screen.getByRole("button", { name: "Restore other" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Recycle bin" })).toHaveFocus());
  });
  it("uses the server's clamped page after restoring the last row on the last page", async () => {
    mocks.list.mockResolvedValueOnce(page([asset("first")], 1, 2)).mockResolvedValueOnce(page([asset("last")], 2, 2)).mockResolvedValue(page([asset("first")], 1, 1));
    open("last");
    fireEvent.click(await screen.findByRole("button", { name: "Restore last" }));
    expect(await screen.findByRole("button", { name: "Restore first" })).toBeVisible();
    expect(mocks.list).toHaveBeenNthCalledWith(3, "token", { page: 2 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Refresh bin" }));
    await waitFor(() => expect(mocks.list).toHaveBeenNthCalledWith(4, "token", { page: 1 }, expect.any(AbortSignal)));
  });
  it("clears a refusal when refreshing the image's current state", async () => {
    mocks.restore.mockRejectedValue(new HttpError(409, "This image is being removed or has already been removed."));
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Restore photo" }));
    await screen.findByRole("alert");
    mocks.list.mockResolvedValue(page([{ ...asset(), lifecycle: "purging" }]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh bin" }));
    expect(await screen.findByText("Being removed")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore photo" })).not.toBeInTheDocument();
  });
  it("updates the countdown without another list request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const view = open();
    await act(async () => {});
    vi.mocked(Date.now).mockReturnValue(now + 86_400_000);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(within(view.container).getByText("Removed in 1 day")).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});
