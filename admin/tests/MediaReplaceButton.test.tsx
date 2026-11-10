import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { MediaReplaceButton } from "../src/components/media/MediaReplaceButton";
import { cmsListMedia, cmsReplaceMediaBinary, HttpError, type MediaAssetSummary } from "../src/lib/functions";
import { HIDDEN_DUPLICATE_MESSAGE } from "../src/lib/media-upload";

vi.mock("../src/lib/functions", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsReplaceMediaBinary: vi.fn(),
  cmsListMedia: vi.fn(),
}));

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


const replace = vi.mocked(cmsReplaceMediaBinary);
const getIdToken = vi.fn(async () => "id-token");
const onReplaced = vi.fn();
const onReload = vi.fn();
const file = new File(["image"], "new.png", { type: "image/png" });
function choose(chosen = file) {
  fireEvent.change(screen.getByLabelText(`Choose a replacement image for ${asset.name}`), { target: { files: [chosen] } });
}
function CurrentLocation() {
  const location = useLocation();
  return <div aria-label="Current location">{location.pathname}{location.search}</div>;
}
function show(overrides: Partial<Parameters<typeof MediaReplaceButton>[0]> = {}) {
  return render(<MediaReplaceButton asset={asset} principal={{ id: "editor", grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }] }} getIdToken={getIdToken} onReplaced={onReplaced} onReload={onReload} {...overrides} />,
    { wrapper: ({ children }) => <MemoryRouter><CurrentLocation />{children}</MemoryRouter> });
}
beforeEach(() => { vi.clearAllMocks(); });

describe("MediaReplaceButton", () => {
  it.each([true, false])("names an active duplicate with a permission-aware pointer (can manage: %s)", async canManage => {
    const existing = { ...asset, id: "existing-image", name: "Existing studio image", category: canManage ? "news" : "arts" };
    vi.mocked(cmsListMedia).mockResolvedValue({ success: true, records: [existing], total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 1, document: 0 } });
    replace.mockRejectedValue(new HttpError(409, "This file is already in the media library.", { duplicateAssetId: existing.id }));
    const onBusyChange = vi.fn();
    show({ onBusyChange, principal: { grants: [{ role: canManage ? "editor" : "staff", sections: ["watch"], registeredMediaSections: ["watch"] }] } });
    expect(cmsListMedia).not.toHaveBeenCalled();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent('This file is already in the media library as "Existing studio image".'));
    expect(cmsListMedia).toHaveBeenCalledExactlyOnceWith("id-token", { assetIds: [existing.id] });
    if (canManage) expect(screen.getByRole("link", { name: "Open existing asset" })).toHaveAttribute("href", "/media/images?asset=existing-image");
    else {
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Ask an editor with media management to use the existing file.");
    }
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("uses the upload helper's permission-aware message when the duplicate is hidden", async () => {
    replace.mockRejectedValue(new HttpError(409, "This file is already in the media library.", { duplicateAssetId: null }));
    show(); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(HIDDEN_DUPLICATE_MESSAGE);
    expect(cmsListMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps the original refusal and releases the guard if duplicate lookup fails", async () => {
    replace.mockRejectedValue(new HttpError(409, "This file is already in the media library.", { duplicateAssetId: "existing-image" }));
    vi.mocked(cmsListMedia).mockRejectedValue(new Error("Network error"));
    const onBusyChange = vi.fn();
    show({ onBusyChange }); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(onBusyChange.mock.calls).toEqual([[true], [false]]));
    expect(screen.getByRole("alert")).toHaveTextContent("This file is already in the media library.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each([true, false])("offers a bin pointer only with bin access (access: %s)", async canOpenBin => {
    replace.mockRejectedValue(new HttpError(409, "This file is already in the media library.", { duplicateAssetId: "unavailable-image" }));
    vi.mocked(cmsListMedia).mockResolvedValue({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 0, categoryCounts: {}, kindCounts: { image: 0, document: 0 } });
    const onBusyChange = vi.fn();
    show({ onBusyChange, principal: { id: "staff", grants: [{ role: canOpenBin ? "editor" : "contributor", sections: ["news"], registeredMediaSections: ["news"] }] },
      librarySearch: "category=news&q=studio&binAsset=old-pointer" }); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(onBusyChange.mock.calls).toEqual([[true], [false]]));
    expect(screen.getByRole("alert")).toHaveTextContent("The matching image may be in the Recycle bin.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (canOpenBin) {
      const link = screen.getByRole("link", { name: "Find it in the Recycle bin" });
      const target = "/media/images?category=news&q=studio&bin=1&binAsset=unavailable-image";
      expect(link).toHaveAttribute("href", target);
      fireEvent.click(link);
      expect(screen.getByLabelText("Current location")).toHaveTextContent(target);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } else {
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Ask a media manager to restore it.");
    }
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("keeps the leave guard until the duplicate lookup finishes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof cmsListMedia>>) => void;
    vi.mocked(cmsListMedia).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    replace.mockRejectedValue(new HttpError(409, "This file is already in the media library.", { duplicateAssetId: "binned-image" }));
    const onBusyChange = vi.fn();
    show({ onBusyChange }); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(cmsListMedia).toHaveBeenCalledOnce());
    expect(onBusyChange.mock.calls).toEqual([[true]]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish({ success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 0, categoryCounts: {}, kindCounts: { image: 0, document: 0 } }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    fireEvent.click(screen.getByRole("link", { name: "Find it in the Recycle bin" }));
    expect(screen.getByLabelText("Current location")).toHaveTextContent("/media/images?bin=1&binAsset=binned-image");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses a keyboard-accessible named button and image-only chooser, then requires confirmation", () => {
    show();
    const trigger = screen.getByRole("button", { name: "Replace file" });
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("type", "button");
    const input = screen.getByLabelText(`Choose a replacement image for ${asset.name}`);
    const click = vi.spyOn(input, "click");
    // Native button activation (including Enter/Space) dispatches click.
    fireEvent.click(trigger, { detail: 0 });
    expect(click).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute("accept", "image/jpeg,image/png,image/webp,image/gif,image/avif");
    choose();
    expect(screen.getByRole("dialog", { name: `Confirm replacement of ${asset.name}` })).toBeInTheDocument();
    expect(screen.getByText(/keeps its ID, name, alt text, credit and usage/)).toHaveTextContent(/purge queue/);
    expect(screen.getByRole("button", { name: "Confirm replacement" })).toHaveFocus();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("announces progress, prevents duplicate requests, and returns the fresh asset with success feedback", async () => {
    let finish!: (value: Awaited<ReturnType<typeof cmsReplaceMediaBinary>>) => void;
    replace.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onBusyChange = vi.fn();
    show({ onBusyChange }); choose();
    const confirm = screen.getByRole("button", { name: "Confirm replacement" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent("Replacing image");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("dialog"), escape);
    expect(escape.defaultPrevented).toBe(true);
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    const reopen = vi.spyOn(dialog, "showModal");
    act(() => dialog.close());
    expect(reopen).toHaveBeenCalledOnce();
    expect(dialog).toHaveFocus();
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith("id-token", asset, file, true);
    const fresh = { ...asset, version: 3, url: "https://media.example.test/new.webp", etag: '"new.3"' };
    await act(async () => finish({ success: true, changed: true, asset: fresh }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(onReplaced).toHaveBeenCalledWith(fresh);
    expect(screen.getByRole("status")).toHaveTextContent("File replaced. Check the alt text for the new image.");
    expect(screen.getByRole("button", { name: "Replace file" })).toHaveFocus();
  });

  it("allows opting out and distinguishes an unchanged file", async () => {
    replace.mockResolvedValue({ success: true, changed: false, asset });
    show(); choose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Optimize JPEG and PNG files and convert them to WebP" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await screen.findByText("This is already the current file. No changes were made.");
    expect(replace).toHaveBeenCalledWith("id-token", asset, file, false);
  });

  it.each([new HttpError(409, "Replacement refused."), new Error("Network error")])(
    "clears the busy report after %s", async cause => {
      replace.mockRejectedValue(cause);
      const onBusyChange = vi.fn();
      show({ onBusyChange }); choose();
      fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
      await screen.findByRole("alert");
      expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    },
  );

  it("clears the busy report when unmounted during a request", async () => {
    let finish!: (value: Awaited<ReturnType<typeof cmsReplaceMediaBinary>>) => void;
    replace.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onBusyChange = vi.fn();
    const view = show({ onBusyChange }); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    view.unmount();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    await act(async () => finish({ success: true, changed: true, asset }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it("does not offer optimization for staff profiles", async () => {
    const profile = { ...asset, category: "staff-profile" };
    replace.mockResolvedValue({ success: true, changed: true, asset: profile });
    show({ asset: profile }); choose();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Staff profile photos must keep the original/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("id-token", profile, file, false));
  });

  it("rejects non-images before sending and respects disabled metadata editing", () => {
    const view = show();
    choose(new File(["pdf"], "a.pdf", { type: "application/pdf" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a JPEG, PNG, WebP, GIF, or AVIF file.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    view.rerender(<MediaReplaceButton asset={asset} getIdToken={getIdToken} onReplaced={onReplaced} onReload={onReload} disabled />);
    expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
  });

  it("keeps the ETag the user confirmed even if the asset refreshes", async () => {
    replace.mockResolvedValue({ success: true, changed: false, asset });
    const view = show(); choose();
    view.rerender(<MediaReplaceButton asset={{ ...asset, version: 3, etag: '"new.3"' }} getIdToken={getIdToken} onReplaced={onReplaced} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("id-token", asset, file, true));
  });

  it.each([
    [409, "This media asset cannot be replaced until coordinated media deployment is active.", "Republish the affected page without this image, or unpublish it"],
    [412, "The media asset changed.", "Refresh the asset before trying again."],
    [400, "Only an image can replace an image.", "Only an image can replace an image."],
    [400, "Profile photos must keep the original file", "Profile photos must keep the original file"],
    [400, "A profile photo must be at least 400 by 400 pixels", "at least 400 by 400 pixels"],
    [413, "Profile photos must be 5 MB or smaller", "5 MB or smaller"],
    [409, "The active media library is full", "The active media library is full"],
    [503, "The media replacement needs recovery before it can be retried", "Try again later."],
    [409, "This media replacement is already being recovered. Try again later.", "Try again later."],
  ])("shows the %s refusal: %s", async (status, message, guidance) => {
    replace.mockRejectedValue(new HttpError(status, message));
    show(); choose();
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(guidance);
    expect(onReplaced).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (status === 412) {
      expect(screen.getByRole("button", { name: "Replace file" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Reload asset" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Reload asset" }));
      expect(onReload).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Replace file" })).toHaveFocus();
    } else {
      expect(screen.getByRole("button", { name: "Replace file" })).toBeEnabled();
    }
  });
});
