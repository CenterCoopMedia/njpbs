import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadTray, type UploadTrayRow } from "../src/components/media/UploadTray";

function setViewport(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: compact,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => setViewport(false));

describe("UploadTray", () => {
  it("renders controlled progress and only the supplied row actions", () => {
    const stop = vi.fn();
    const retry = vi.fn();
    const clear = vi.fn();
    const view = vi.fn();
    const rows: UploadTrayRow[] = [
      { id: "active", name: "studio.png", status: "uploading", progress: 42, onStop: stop },
      { id: "failed", name: "report.pdf", status: "failed", message: "Upload did not finish.", onRetry: retry, onClear: clear },
      { id: "done", name: "bumper.png", status: "succeeded", onViewAsset: view },
    ];
    render(<UploadTray announcement="One of three files uploaded." collapsed={false} onOpen={vi.fn()} rows={rows} summary="Uploading 2 of 3" />);

    const region = screen.getByRole("region", { name: "Upload progress" });
    expect(within(region).getByRole("progressbar", { name: "studio.png upload progress" }))
      .toHaveAttribute("value", "42");
    expect(within(region).getByText("Upload did not finish.")).toBeVisible();
    expect(within(region).getByRole("status")).toHaveTextContent("One of three files uploaded.");
    const stopButton = within(region).getByRole("button", { name: "Stop studio.png" });
    const retryButton = within(region).getByRole("button", { name: "Retry report.pdf" });
    const clearButton = within(region).getByRole("button", { name: "Clear report.pdf" });
    const viewButton = within(region).getByRole("button", { name: "View asset bumper.png" });
    expect([stopButton, retryButton, clearButton, viewButton].map(button => button.textContent))
      .toEqual(["Stop", "Retry", "Clear", "View asset"]);

    fireEvent.click(stopButton);
    fireEvent.click(retryButton);
    fireEvent.click(clearButton);
    fireEvent.click(viewButton);
    expect(stop).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(view).toHaveBeenCalledOnce();
  });

  it("collapses through its owner and expands from its summary pill", () => {
    function Harness() {
      const [collapsed, setCollapsed] = useState(false);
      return <UploadTray collapsed={collapsed} onCollapsedChange={setCollapsed} onOpen={() => undefined}
        rows={[{ id: "active", name: "studio.png", status: "uploading" }]}
        summary="Uploading 1 of 1" />;
    }
    render(<Harness />);
    const collapse = screen.getByRole("button", { name: "Collapse upload tray" });
    collapse.focus();
    fireEvent.click(collapse);
    expect(screen.queryByText("studio.png")).toBeNull();
    const pill = screen.getByRole("button", { name: "Uploading 1 of 1" });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(pill).toHaveFocus();
    fireEvent.click(pill);
    expect(screen.getByText("studio.png")).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse upload tray" })).toHaveFocus();
  });

  it("moves focus to the next row action when Clear removes a row", () => {
    function Harness() {
      const [rows, setRows] = useState<UploadTrayRow[]>([
        { id: "failed", name: "report.pdf", status: "failed" },
        { id: "done", name: "bumper.png", status: "succeeded", onViewAsset: () => undefined },
      ]);
      const controlled = rows.map(row => row.id === "failed"
        ? { ...row, onClear: () => setRows(current => current.filter(item => item.id !== row.id)) }
        : row);
      return <UploadTray collapsed={false} onOpen={() => undefined} rows={controlled} summary="1 of 2 uploaded" />;
    }

    render(<Harness />);
    const clear = screen.getByRole("button", { name: "Clear report.pdf" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByText("report.pdf")).toBeNull();
    expect(screen.getByRole("button", { name: "View asset bumper.png" })).toHaveFocus();
  });

  it("uses the compact pill below 62rem and opens the owner sheet", () => {
    setViewport(true);
    const open = vi.fn();
    render(<UploadTray collapsed={false}
      onOpen={open}
      rows={[{ id: "active", name: "studio.png", status: "uploading", progress: 20 }]}
      summary="Uploading 1 of 1" />);
    const pill = screen.getByRole("button", { name: "Open upload details, Uploading 1 of 1" });
    expect(pill).toHaveClass("media-upload-tray-pill");
    fireEvent.click(pill);
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByText("studio.png")).toBeNull();

  });

  it("names a blocked compact sheet action and still lets a desktop tray expand", () => {
    setViewport(true);
    const open = vi.fn();
    const compact = render(<UploadTray collapsed={false}
      onOpen={open}
      openLockedReason="Save or discard video details first."
      rows={[{ id: "video", name: "studio.mp4", status: "paused" }]}
      summary="1 of 1 paused" />);
    const phonePill = screen.getByRole("button", { name: "Open upload details, 1 of 1 paused" });
    expect(phonePill).toHaveAttribute("aria-disabled", "true");
    expect(phonePill).toHaveAccessibleDescription("Save or discard video details first.");
    fireEvent.click(phonePill);
    expect(open).not.toHaveBeenCalled();
    compact.unmount();

    setViewport(false);
    function DesktopHarness() {
      const [collapsed, setCollapsed] = useState(true);
      return <UploadTray collapsed={collapsed} onCollapsedChange={setCollapsed}
        onOpen={open}
        openLockedReason="Save or discard video details first."
        rows={[{ id: "video", name: "studio.mp4", status: "paused" }]}
        summary="1 of 1 paused" />;
    }
    render(<DesktopHarness />);
    const desktopPill = screen.getByRole("button", { name: "1 of 1 paused" });
    expect(desktopPill).not.toHaveAttribute("aria-disabled");
    fireEvent.click(desktopPill);
    expect(screen.getByText("studio.mp4")).toBeVisible();
  });
});
