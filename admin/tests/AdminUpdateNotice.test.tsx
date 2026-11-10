import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminUpdateNotice } from "../src/components/AdminUpdateNotice";
import { adminPerf } from "../src/lib/perf-receipts";
import { ExitGuardProvider, useRegisterExitGuard } from "../src/routes/ExitGuard";

const interval = 5 * 60_000;
const loaded = "a".repeat(7);
const deployed = (revision = "b".repeat(40)) => ({
  schemaVersion: 2,
  status: "current",
  build: { revision, builtAt: "2026-11-04T17:00:00.000Z" },
  milestone: null,
  milestones: null,
});
const fetchMock = vi.fn<typeof fetch>();
const respond = (value: unknown) => fetchMock.mockResolvedValue(new Response(JSON.stringify(value)));
const focus = () => act(async () => { window.dispatchEvent(new Event("focus")); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  const receipt = adminPerf.receipt();
  vi.spyOn(adminPerf, "receipt").mockReturnValue({ ...receipt, build: loaded });
  respond(deployed());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AdminUpdateNotice at the network boundary", () => {
  it("waits five minutes, bypasses the asset cache and recognizes the loaded short SHA", async () => {
    respond(deployed("a".repeat(40)));
    render(<AdminUpdateNotice />);
    expect(fetchMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(interval - 1));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/admin-status.json", {
      cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" }, signal: expect.any(AbortSignal),
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(interval));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offers an update on focus without changing the active draft or continuing to poll", async () => {
    render(<><input aria-label="Draft" defaultValue="Unsaved words" /><AdminUpdateNotice /></>);
    const draft = screen.getByRole("textbox");
    draft.focus();
    await focus();
    expect(screen.getByRole("status")).toHaveTextContent("A Boardwalk update is ready");
    expect(screen.getByRole("button", { name: "Reload Boardwalk" })).toBeVisible();
    const notes = screen.getByRole("link", { name: "What's new (opens in a new tab)" });
    expect(notes).toHaveAttribute("href", "/guide?whats-new=1");
    expect(notes).toHaveAttribute("target", "_blank");
    expect(notes).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(draft).toHaveValue("Unsaved words");
    expect(draft).toHaveFocus();
    await act(() => vi.advanceTimersByTimeAsync(interval * 3));
    await focus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unknown schema", { ...deployed(), schemaVersion: 1 }],
    ["unavailable build", { schemaVersion: 2, status: "unavailable", build: null }],
    ["malformed revision", deployed("new-build")],
    ["malformed timestamp", { ...deployed(), build: { ...deployed().build, builtAt: "invalid" } }],
  ])("silently ignores %s and can recover on the next focus", async (_label, response) => {
    respond(response);
    render(<AdminUpdateNotice />);
    await focus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    respond(deployed());
    await focus();
    expect(screen.getByRole("status")).toHaveTextContent("A Boardwalk update is ready");
  });

  it.each(["network", "http", "json"])("silently ignores a %s failure", async failure => {
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    else fetchMock.mockResolvedValue(new Response("<html>Unavailable</html>", { status: failure === "http" ? 503 : 200 }));
    render(<AdminUpdateNotice />);
    await focus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("skips unknown loaded builds without making a request", async () => {
    vi.mocked(adminPerf.receipt).mockReturnValue({ ...adminPerf.receipt(), build: null });
    render(<AdminUpdateNotice />);
    await focus();
    await act(() => vi.advanceTimersByTimeAsync(interval));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips hidden and offline tabs, then checks when visible again", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(<AdminUpdateNotice />);
    await focus();
    await act(() => vi.advanceTimersByTimeAsync(interval));
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await focus();
    expect(fetchMock).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByRole("status")).toBeVisible();
  });

  it("does not overlap checks, times them out silently, and aborts on unmount", async () => {
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const { unmount } = render(<AdminUpdateNotice />);
    await focus();
    await focus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await focus();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    await focus();
    await act(() => vi.advanceTimersByTimeAsync(interval));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps unsaved work behind the existing exit confirmation when Reload is chosen", async () => {
    function DirtyEditor() {
      useRegisterExitGuard({ saving: false, hasUnsavedWork: () => true });
      return <input aria-label="Draft" defaultValue="Unsaved words" />;
    }
    render(<ExitGuardProvider><DirtyEditor /><AdminUpdateNotice /></ExitGuardProvider>);
    await focus();
    fireEvent.click(screen.getByRole("button", { name: "Reload Boardwalk" }));
    expect(screen.getByRole("dialog", { name: /unsaved/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved words");
    expect(screen.getByRole("button", { name: "Reload Boardwalk" })).toBeVisible();
  });

  it("waits for an in-flight save and protects edits left behind when it settles", async () => {
    function Editor({ saving }: { saving: boolean }) {
      useRegisterExitGuard({ saving, hasUnsavedWork: () => true });
      return <AdminUpdateNotice />;
    }
    const view = render(<ExitGuardProvider><Editor saving /></ExitGuardProvider>);
    await focus();
    fireEvent.click(screen.getByRole("button", { name: "Reload Boardwalk" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<ExitGuardProvider><Editor saving={false} /></ExitGuardProvider>);
    expect(screen.getByRole("dialog", { name: /unsaved/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("button", { name: "Reload Boardwalk" })).toBeVisible();
  });
});
