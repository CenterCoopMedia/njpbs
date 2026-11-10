import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DropOverlay } from "../src/components/media/DropOverlay";

const image = new File(["image"], "news.png", { type: "image/png" });
const fileDrag = () => ({ types: ["Files"], files: [image], dropEffect: "none" });

describe("DropOverlay", () => {
  it("announces only a file drag and sends the files once without moving focus", () => {
    const onFiles = vi.fn();
    render(
      <DropOverlay canUpload destination="Images" onFiles={onFiles}>
        <button type="button">Current result</button>
      </DropOverlay>,
    );
    const result = screen.getByRole("button", { name: "Current result" });
    result.focus();
    const target = result.parentElement!;

    fireEvent.dragEnter(target, { dataTransfer: { types: ["text/plain"] } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.dragEnter(target, { dataTransfer: fileDrag() });
    expect(screen.getByRole("status")).toHaveTextContent("Drop to upload to Images");
    expect(result).toHaveFocus();

    fireEvent.drop(target, { dataTransfer: fileDrag() });
    expect(onFiles).toHaveBeenCalledOnce();
    expect(onFiles).toHaveBeenCalledWith([image]);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the dirty-state block and ignores a drop", () => {
    const onFiles = vi.fn();
    render(
      <DropOverlay blocked canUpload destination="Images" onFiles={onFiles}>
        <span>Results</span>
      </DropOverlay>,
    );
    const target = screen.getByText("Results").parentElement!;
    fireEvent.dragEnter(target, { dataTransfer: fileDrag() });
    expect(screen.getByRole("status")).toHaveTextContent("Save or discard details first");
    fireEvent.drop(target, { dataTransfer: fileDrag() });
    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears on dragleave or permission loss and ignores a disabled drop", () => {
    const onFiles = vi.fn();
    const { rerender } = render(
      <DropOverlay canUpload destination="Images" onFiles={onFiles}><span>Results</span></DropOverlay>,
    );
    const target = screen.getByText("Results").parentElement!;
    fireEvent.dragEnter(target, { dataTransfer: fileDrag() });
    fireEvent.dragLeave(target, { relatedTarget: null });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.dragEnter(target, { dataTransfer: fileDrag() });
    rerender(
      <DropOverlay blocked canUpload={false} destination="Images" onFiles={onFiles}><span>Results</span></DropOverlay>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.drop(target, { dataTransfer: fileDrag() });
    expect(onFiles).not.toHaveBeenCalled();
  });
});
