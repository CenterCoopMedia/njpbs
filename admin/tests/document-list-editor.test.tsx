import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentListEditor } from "../src/components/DocumentListEditor";
import { MediaPickerDialog } from "../src/components/MediaPickerDialog";
import type { MediaAssetSummary, ListMediaResponse } from "../src/lib/functions";
const block = { id: "list", type: "document_list" as const, order: 0, visible: true, data: { documents: [] } };
const pdf: MediaAssetSummary = { id: "pdf-one", name: "Board notice.pdf", originalName: "Board notice.pdf", category: "news", categories: ["news"],
  mimeType: "application/pdf", kind: "document", sizeBytes: 4000, url: "https://media.njpbs.org/cms-media/notice.pdf",
  width: null, height: null, tags: [], description: null, altText: null, license: null, credit: null,
  lifecycle: "active", version: 1, etag: "a", createdAt: "2026-10-07T12:00:00.000Z", createdBy: null,
  updatedAt: null, updatedBy: null };
const response = (records: MediaAssetSummary[]): ListMediaResponse => ({ success: true, records, total: records.length,
  allCount: records.length, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: {} });
describe("PDF notice editor", () => {
  it("adds a selected PDF without accepting a client date and requests documents only", async () => {
    const onChange = vi.fn(); const loadMedia = vi.fn(async () => response([pdf]));
    render(<DocumentListEditor block={block} loadMedia={loadMedia} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add PDF notice" }));
    expect(await screen.findByRole("heading", { name: "Choose a PDF" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /^Board notice\.pdf/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const item = onChange.mock.calls[0][0].documents[0];
    expect(item).toMatchObject({ title: "Board notice", assetId: pdf.id, publisher: "njpba" });
    expect(item.itemId).toBeTruthy(); expect(item.addedAt).toBeUndefined();
    expect(loadMedia).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["document"] }));
  });
  it("keeps the entry identity and first-added date while replacing its PDF", async () => {
    const item = { itemId: "entry", assetId: "old-pdf", title: "Existing notice", addedAt: "2026-10-01T12:00:00.000Z" };
    const onChange = vi.fn(); const loadMedia = vi.fn(async () => response([pdf]));
    render(<DocumentListEditor block={{ ...block, data: { documents: [item] } }} loadMedia={loadMedia} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Change PDF for Existing notice" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Board notice\.pdf/ }));
    expect(onChange.mock.calls[0][0].documents[0]).toEqual({ ...item, assetId: pdf.id });
  });
  it("prevents edits in the read-only preview", () => {
    render(<DocumentListEditor block={block} readOnly loadMedia={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add PDF notice" })).toBeDisabled();
  });
  it("retains image-only requests for the existing image picker", async () => {
    const loadMedia = vi.fn(async () => response([]));
    render(<MediaPickerDialog currentAssetId="" loadMedia={loadMedia} onClose={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(loadMedia).toHaveBeenCalledWith(expect.objectContaining({ kinds: ["image"] })));
    expect(screen.getByRole("heading", { name: "Choose an image" })).toBeVisible();
  });
});
