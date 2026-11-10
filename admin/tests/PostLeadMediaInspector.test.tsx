import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PostLeadMediaInspector } from "../src/components/PostLeadMediaInspector";

afterEach(cleanup);
describe("compact Post lead media inspector (#3623)", () => {
  it.each([
    [{ leadMedia: null }, "No lead media"],
    [{}, "No lead media"],
    [{ heroImage: "legacy-image", heroImageAlt: "The boardwalk" }, "Library image · Image selected"],
    [{ leadMedia: { kind: "library-video", data: { sourceId: "video-library", assetId: "video-one", title: "The boardwalk" } } }, "Library video · The boardwalk"],
    [{ leadMedia: { kind: "linked-video", data: { url: "https://example.org/video", title: "The boardwalk" } } }, "Linked video · The boardwalk"],
    [{ leadMedia: { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "The boardwalk" } } }, "Embedded video · The boardwalk"],
    [{ leadMedia: { kind: "unsupported" } }, "Lead media needs review"],
    [{ leadMedia: { kind: "image", data: { assetId: "", alt: "" } } }, "Library image · No image selected"],
    [{ leadMedia: { kind: "library-video", data: { sourceId: "video-library", assetId: "", title: "" } } }, "Library video · No video selected"],
    [{ leadMedia: { kind: "linked-video", data: { url: "", title: "" } } }, "Linked video · No video selected"],
    [{ leadMedia: { kind: "embed", data: { url: "", title: "" } } }, "Embedded video · No video selected"],
  ])("summarizes the stored selection without editing it (%j)", (record, state) => {
    const remove = vi.fn();
    render(<PostLeadMediaInspector record={record} onRemove={remove}><input aria-label="Full lead editor" /></PostLeadMediaInspector>);
    expect(screen.getByText(state)).toBeVisible();
    expect(screen.getByLabelText("Change lead media")).toHaveAccessibleDescription(state);
    const details = screen.getByText("Lead media").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Full lead editor")).not.toBeVisible();
    expect(remove).not.toHaveBeenCalled();
  });

  it("resolves the selected image name and thumbnail through the existing media loader", async () => {
    const loadMedia = vi.fn(async () => ({ success: true as const, records: [{ id: "image", name: "The boardwalk", url: "/boardwalk.webp" }], total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 1, document: 0 } }));
    render(<PostLeadMediaInspector record={{ leadMedia: { kind: "image", data: { assetId: "image", alt: "The boardwalk" } } }}
      loadMedia={loadMedia as never} onRemove={vi.fn()}><span>Editor</span></PostLeadMediaInspector>);
    expect(await screen.findByText("Library image · The boardwalk")).toBeVisible();
    expect(screen.getByLabelText("Change lead media")).toHaveAccessibleDescription("Library image · The boardwalk");
    expect(document.querySelector("summary img")).toHaveAttribute("src", "/boardwalk.webp");
    expect(loadMedia).toHaveBeenCalledWith(expect.objectContaining({ assetIds: ["image"] }), { signal: expect.any(AbortSignal) });
  });

  it("clears a legacy lead explicitly and returns focus to the closed row", () => {
    function Editor() {
      const [record, setRecord] = useState<Record<string, unknown>>({ heroImage: "legacy-image" });
      return <><PostLeadMediaInspector record={record} onRemove={() => setRecord({ ...record, leadMedia: null })}><span>Editor</span></PostLeadMediaInspector>
        <output>{JSON.stringify(record)}</output></>;
    }
    render(<Editor />);
    const summary = screen.getByLabelText("Change lead media");
    const details = summary.closest("details")!;
    details.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Remove lead media" }));
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    expect(summary).toHaveAccessibleDescription("No lead media");
    expect(screen.getByText("No lead media")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent('"heroImage":"legacy-image","leadMedia":null');
  });

  it("keeps locked selections inspectable without a remove action and opens validation errors", () => {
    const record = { leadMedia: { kind: "embed", data: { url: "https://youtu.be/abcdefghijk", title: "The boardwalk" } } };
    const view = render(<PostLeadMediaInspector record={record}><span>Read-only review</span></PostLeadMediaInspector>);
    expect(screen.getByLabelText("View lead media")).toBeVisible();
    expect(screen.getByLabelText("View lead media")).toHaveAccessibleDescription("Embedded video · The boardwalk");
    expect(screen.queryByRole("button", { name: "Remove lead media", hidden: true })).toBeNull();
    view.rerender(<PostLeadMediaInspector record={record} error="Review this lead"><span>Read-only review</span></PostLeadMediaInspector>);
    expect(screen.getByText("Read-only review")).toBeVisible();
  });
});
