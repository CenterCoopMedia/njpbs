import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickLook, type QuickLookItem } from "../src/components/media/QuickLook";

const image: QuickLookItem = {
  id: "image-1",
  name: "Offshore wind turbines",
  kind: "image",
  previewUrl: "https://media.example/wind-960.webp",
  originalUrl: "https://media.example/wind.jpg",
};

describe("QuickLook", () => {
  it("shows a preview, position and step controls, then closes with Escape or the shortcut", () => {
    const onClose = vi.fn();
    const onStep = vi.fn();
    const view = render(<QuickLook count={5} item={image} onClose={onClose} onStep={onStep} position={3} />);

    const dialog = screen.getByRole("dialog", { name: "Quick Look: Offshore wind turbines" });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog.querySelector("img")).toHaveAttribute("src", image.previewUrl);
    expect(screen.getByRole("status")).toHaveTextContent("3 of 5 · ← → to step");
    expect(screen.getByRole("button", { name: "Close Quick Look" })).toHaveFocus();
    expect(screen.queryByRole("link", { name: "Open original" })).toBeNull();

    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(onStep.mock.calls).toEqual([["previous"], ["next"]]);
    fireEvent.keyDown(dialog, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(dialog, { key: "ArrowRight", shiftKey: true });
    expect(onStep).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(<QuickLook count={5} item={image} onClose={onClose} onStep={onStep} position={3} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "y", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "y", ctrlKey: true, altKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows a PDF mark and original link", () => {
    render(<QuickLook count={1} item={{ id: "pdf", name: "Agenda", kind: "document", originalUrl: "https://media.example/agenda.pdf" }}
      onClose={() => undefined} onStep={() => undefined} position={1} />);

    expect(screen.getByText("PDF")).toBeVisible();
    expect(screen.getByText("PDF document")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute("href", "https://media.example/agenda.pdf");
    expect(screen.getByRole("button", { name: "Previous item" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next item" })).toBeDisabled();
  });

  it("closes outside and at either Tab boundary, while an inside press stays open", () => {
    const onClose = vi.fn();
    const view = render(<QuickLook count={3} item={image} onClose={onClose} onStep={() => undefined} position={2} />);
    const dialog = screen.getByRole("dialog");

    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);

    const search = document.createElement("input");
    document.body.append(search);
    fireEvent.pointerDown(search);
    expect(onClose).toHaveBeenLastCalledWith(false);
    search.remove();

    const close = screen.getByRole("button", { name: "Close Quick Look" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(3);

    const next = screen.getByRole("button", { name: "Next item" });
    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(4);

    view.rerender(<QuickLook count={3} item={{ ...image, kind: "video", previewUrl: null }}
      onClose={onClose} onStep={() => undefined} position={2} />);
    expect(screen.getByText("Preview unavailable")).toBeVisible();
  });

  it("keeps focus in the dialog when a step disables its button", () => {
    const onStep = vi.fn();
    const onClose = vi.fn();
    const view = render(<QuickLook count={3} item={image} onClose={onClose} onStep={onStep} position={2} />);
    const next = screen.getByRole("button", { name: "Next item" });
    next.focus();
    fireEvent.click(next);
    view.rerender(<QuickLook count={3} item={{ ...image, id: "image-3" }} onClose={onClose} onStep={onStep} position={3} />);
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close Quick Look" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close Quick Look" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("shows a fallback after an image load fails and keeps focus when stepping away from a PDF link", () => {
    const onStep = vi.fn();
    const onPreviewError = vi.fn();
    const view = render(<QuickLook count={2} item={image} onClose={() => undefined} onStep={onStep}
      onPreviewError={onPreviewError} position={1} />);
    fireEvent.error(screen.getByRole("dialog").querySelector("img")!);
    expect(screen.getByText("Preview unavailable")).toBeVisible();
    expect(onPreviewError).toHaveBeenCalledWith(image);

    view.rerender(<QuickLook count={2} item={{ id: "pdf", name: "Agenda", kind: "document", originalUrl: "/agenda.pdf" }}
      onClose={() => undefined} onStep={onStep} position={1} />);
    const link = screen.getByRole("link", { name: "Open original" });
    link.focus();
    fireEvent.keyDown(link, { key: "ArrowRight" });
    expect(onStep).toHaveBeenCalledWith("next");
    expect(screen.getByRole("button", { name: "Close Quick Look" })).toHaveFocus();
  });

  it("lets an associated outside label focus its control", () => {
    const onClose = vi.fn();
    render(<QuickLook count={1} item={image} onClose={onClose} onStep={() => undefined} position={1} />);
    const label = document.createElement("label");
    label.htmlFor = "search-field";
    const input = document.createElement("input");
    input.id = "search-field";
    document.body.append(label);
    document.body.append(input);
    expect(fireEvent.pointerDown(label)).toBe(true);
    expect(onClose).toHaveBeenCalledWith(false);
    input.disabled = true;
    expect(fireEvent.pointerDown(label)).toBe(false);
    expect(onClose).toHaveBeenLastCalledWith(true);
    input.remove();
    expect(fireEvent.pointerDown(label)).toBe(false);
    expect(onClose).toHaveBeenLastCalledWith(true);
    const progress = document.createElement("progress");
    progress.id = "search-field";
    document.body.append(progress);
    expect(fireEvent.pointerDown(label)).toBe(false);
    expect(onClose).toHaveBeenLastCalledWith(true);
    label.remove();
    progress.remove();
  });
});
