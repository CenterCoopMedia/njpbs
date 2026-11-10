import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaInspector, type MediaInspectorProps } from "../src/components/media/MediaInspector";
import type { MediaAssetSummary } from "../src/lib/functions";

const asset: MediaAssetSummary = {
  id: "image-one",
  name: "Studio control room",
  originalName: "studio.jpg",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: "The main production room",
  altText: "Monitors and switchers",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/jpeg",
  kind: "image",
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.example.test/studio.jpg",
  source: "upload",
  lifecycle: "active",
  version: 2,
  etag: '"studio.2"',
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

const commonProps = {
  asset,
  categories: [{
    id: "news",
    label: "News",
    description: "News media",
    order: 1,
    active: true,
    reserved: false,
    version: 1,
    etag: '"news.1"',
    canUpload: true,
    canManage: true,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
  }],
  canEdit: true,
  deleteMedia: vi.fn(),
  onDeleted: vi.fn(),
  onDirtyChange: vi.fn(),
  onReload: vi.fn(),
  onSaved: vi.fn(),
  onSavingChange: vi.fn(),
  saveMetadata: vi.fn(),
} satisfies Omit<MediaInspectorProps, "docked" | "onClose" | "onOpenFullSize">;

describe("MediaInspector viewer modes", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("opens the full-size viewer from the standalone preview", () => {
    const onOpenFullSize = vi.fn();
    render(
      <MediaInspector
        {...commonProps}
        onClose={vi.fn()}
        onOpenFullSize={onOpenFullSize}
      />,
    );

    const preview = screen.getByRole("link", { name: "Open full size" });
    expect(preview).toHaveAttribute("href", asset.url);
    expect(preview).not.toHaveAttribute("target");
    fireEvent.click(preview);
    expect(onOpenFullSize).toHaveBeenCalledOnce();
  });

  it("docks details without duplicate preview controls and keeps the favorite action", () => {
    render(
      <MediaInspector
        {...commonProps}
        docked
        favoriteControl={<button type="button">Add to favorites</button>}
      />,
    );

    const inspector = screen.getByRole("complementary", { name: "Asset details" });
    expect(within(inspector).queryByRole("button", { name: "Close details" })).not.toBeInTheDocument();
    expect(within(inspector).queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(within(inspector).queryByText("Open original")).not.toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Add to favorites" })).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Details" })).toBeInTheDocument();
  });

  it("puts recorded voiceover details directly after the audio preview", () => {
    const voiceover: MediaAssetSummary = { ...asset, id: "take-2", name: "Station identification",
      kind: "audio", mimeType: "audio/wav", source: "voiceover", width: null, height: null,
      voiceover: { id: "take-2", family_id: "station", family: "Station ID", take: 2,
        style: "Warm", performer_id: "pat", performer_name: "Pat Lee", text: "This is NJ PBS",
        complete: true, flags: [], duration_seconds: 17, manifestVersion: 1 } };
    render(<MediaInspector {...commonProps} asset={voiceover} getIdToken={async () => "staff-token"} onClose={vi.fn()} />);
    const headings = within(screen.getByRole("complementary", { name: "Asset details" }))
      .getAllByRole("button", { name: /^(Preview|Voiceover|Details)$/ });
    expect(headings.map(heading => heading.getAttribute("aria-label") ?? heading.textContent?.trim()))
      .toEqual(["Preview", "Voiceover", "Details"]);
    expect(screen.getByText("Pat Lee")).toBeVisible();
    expect(screen.getByText("Warm")).toBeVisible();
    expect(screen.getByText("0:17")).toBeVisible();
    expect(screen.getByRole("button", { name: "Listen to Station identification" })).toHaveTextContent("Listen");
  });
});

it.each([false, true])("renders the replace action slot with docked=%s", docked => {
  render(<MediaInspector {...commonProps} {...(docked ? { docked: true } : { onClose: vi.fn() })} replaceControl={<button>Replace file</button>} />);
  const inspector = screen.getByRole("complementary", { name: "Asset details" });
  expect(within(inspector).getAllByRole("button", { name: "Replace file" })).toHaveLength(1);
});

describe("MediaInspector save receipts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  function submitChangedName(saveMetadata: MediaInspectorProps["saveMetadata"], onSaveReceipt = vi.fn(), chosenAsset = asset) {
    render(
      <MediaInspector
        {...commonProps}
        asset={chosenAsset}
        onClose={vi.fn()}
        onSaveReceipt={onSaveReceipt}
        saveMetadata={saveMetadata}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Updated studio" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    return onSaveReceipt;
  }

  it("reports the confirmed previous values and post-save ETag", async () => {
    const savedAsset = {
      ...asset,
      name: "Updated studio",
      version: 3,
      etag: '"studio.3"',
    };
    const saveMetadata = vi.fn(async () => ({
      success: true as const,
      changed: true,
      asset: savedAsset,
    }));
    const onSaveReceipt = submitChangedName(saveMetadata);

    await waitFor(() => expect(onSaveReceipt).toHaveBeenCalledWith({
      previous: {
        name: "Studio control room",
        description: "The main production room",
        altText: "Monitors and switchers",
        license: "NJ PBS owned",
        credit: "NJ PBS",
        tags: ["studio"],
        categories: ["news"],
      },
      asset: savedAsset,
    }));
  });

  it("omits an unchanged uploaded filename that cannot pass rename validation", async () => {
    const source = { ...asset, mimeType: "image/webp", originalName: "studio.jpg" };
    const savedAsset = { ...source, name: "Updated studio", version: 3, etag: '"studio.3"' };
    const onSaveReceipt = submitChangedName(vi.fn(async () => ({
      success: true as const, changed: true, asset: savedAsset,
    })), vi.fn(), source);

    await waitFor(() => expect(onSaveReceipt).toHaveBeenCalledOnce());
    expect(onSaveReceipt.mock.calls[0][0].previous).not.toHaveProperty("originalName");
  });

  it("restores the generated alt-text marker with its prior text", async () => {
    const source = { ...asset, altTextGenerated: true };
    const savedAsset = { ...source, altText: "Edited description", altTextGenerated: false,
      version: 3, etag: '"studio.3"' };
    const onSaveReceipt = vi.fn();
    render(<MediaInspector {...commonProps} asset={source} onClose={vi.fn()}
      onSaveReceipt={onSaveReceipt} saveMetadata={vi.fn(async () => ({ success: true as const, changed: true, asset: savedAsset }))} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Alt-text suggestion" }), { target: { value: "Edited description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(onSaveReceipt).toHaveBeenCalledOnce());
    expect(onSaveReceipt.mock.calls[0][0].previous).toMatchObject({
      altText: "Monitors and switchers", altTextGenerated: true,
    });
  });

  it("offers no Undo when a changed filename cannot be restored", async () => {
    const source = { ...asset, mimeType: "image/webp", originalName: "studio.jpg" };
    const onSaveReceipt = vi.fn();
    render(<MediaInspector {...commonProps} asset={source} onClose={vi.fn()}
      onSaveReceipt={onSaveReceipt} saveMetadata={vi.fn(async () => ({ success: true as const, changed: true,
        asset: { ...source, originalName: "studio.webp", version: 3, etag: '"studio.3"' } }))} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filename" }), { target: { value: "studio.webp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(screen.getByText("Media details saved")).toBeInTheDocument());
    expect(onSaveReceipt).not.toHaveBeenCalled();
  });

  it.each([
    ["the server reports no change", asset, false],
    ["the post-save ETag is missing", { ...asset, name: "Updated studio", etag: "" }, true],
  ])("does not report a receipt when %s", async (_label, savedAsset, changed) => {
    const onSaveReceipt = submitChangedName(vi.fn(async () => ({
      success: true as const,
      changed,
      asset: savedAsset,
    })));

    await waitFor(() => expect(screen.getByText("Media details saved")).toBeInTheDocument());
    expect(onSaveReceipt).not.toHaveBeenCalled();
  });

  it("does not report a receipt when the save fails", async () => {
    const onSaveReceipt = submitChangedName(vi.fn(async () => {
      throw new Error("Save failed");
    }));

    await waitFor(() => expect(screen.getByText("Save failed")).toBeInTheDocument());
    expect(onSaveReceipt).not.toHaveBeenCalled();
  });
});
