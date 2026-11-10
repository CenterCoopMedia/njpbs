import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadSheet } from "../src/components/media/UploadSheet";

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

function Harness({ dirty = false }: { dirty?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open upload</button>
      <UploadSheet dirty={dirty} heading="Upload images and documents" onDismiss={() => setOpen(false)} onRequestClose={() => setOpen(false)} open={open}>
        <label>Caption <input defaultValue="" /></label>
      </UploadSheet>
    </>
  );
}

beforeEach(() => setViewport(false));

describe("UploadSheet", () => {
  it("uses the fixed inspector slot, names the region, and restores opener focus", () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open upload" });
    opener.focus();
    fireEvent.click(opener);

    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(sheet).toHaveClass("media-upload-sheet");
    expect(screen.getByRole("heading", { name: "Upload images and documents" })).toHaveFocus();
    expect(screen.queryByRole("separator", { name: "Resize details" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close upload" }));
    expect(screen.queryByRole("complementary", { name: "Upload media" })).toBeNull();
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
    expect(opener).toHaveFocus();
  });

  it("keeps child state mounted while closed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open upload" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Caption" }), {
      target: { value: "Local queue metadata" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close upload" }));
    expect(screen.queryByRole("textbox", { name: "Caption" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open upload" }));
    expect(screen.getByRole("textbox", { name: "Caption" })).toHaveValue("Local queue metadata");
  });

  it("dismisses on an outside click while preserving metadata and the clicked control's focus", () => {
    const { rerender } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open upload" });
    fireEvent.click(opener);
    const caption = screen.getByRole("textbox", { name: "Caption" });
    fireEvent.change(caption, { target: { value: "Local queue metadata" } });
    fireEvent.click(caption);
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    fireEvent.pointerDown(caption);
    rerender(<Harness />);
    fireEvent.click(document.body, { detail: 1 });
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    const overlay = document.createElement("div");
    overlay.id = "admin-overlay-root";
    document.body.append(overlay);
    fireEvent.click(overlay);
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    overlay.remove();
    opener.focus();
    fireEvent.click(document.body);
    expect(screen.queryByRole("complementary", { name: "Upload media" })).toBeNull();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    expect(screen.getByRole("textbox", { name: "Caption" })).toHaveValue("Local queue metadata");
  });

  it("delegates dirty close and Escape decisions to its owner", () => {
    const onRequestClose = vi.fn();
    render(
      <UploadSheet dirty heading="Upload video" onRequestClose={onRequestClose} open>
        <p>Pending metadata</p>
      </UploadSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close upload" }));
    fireEvent.keyDown(screen.getByRole("heading", { name: "Upload video" }), { key: "Escape" });
    expect(onRequestClose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeInTheDocument();
  });

  it("uses the Inspector modal focus scope on narrow screens", async () => {
    setViewport(true);
    render(<Harness dirty />);
    const opener = screen.getByRole("button", { name: "Open upload" });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Upload media" })).toHaveAttribute("aria-modal", "true");
    expect(opener.closest("[inert]")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Caption" }), { target: { value: "Keep this draft" } });
    fireEvent.click(document.querySelector(".ui-inspector-scrim")!);
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
    expect(document.querySelector(".ui-inspector-scrim")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    fireEvent.click(opener);
    expect(screen.getByRole("textbox", { name: "Caption" })).toHaveValue("Keep this draft");
  });
});
