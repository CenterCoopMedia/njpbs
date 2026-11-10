import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VideoDetailsInspector,
  type VideoDetailsSaveReceipt,
} from "../src/components/media/VideoDetailsInspector";
import {
  updateSourceMediaMetadata,
  type SourceMediaAssetSummary,
} from "../src/lib/source-media";
vi.mock("../src/lib/source-media", () => ({
  deleteSourceMedia: vi.fn(),
  updateSourceMediaMetadata: vi.fn(),
}));

function installMediaFeedbackFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split("/").at(-1);
    const body = name === "cmsGetMediaReview"
      ? { success: true, review: null }
      : name === "cmsListMediaComments"
        ? { success: true, comments: [], nextCursor: null }
        : null;
    if (!body) throw new Error(`Unexpected request: ${String(input)}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }));
}

const asset: SourceMediaAssetSummary = {
  id: "video-1",
  sourceId: "video-library",
  name: "Morning update",
  description: null,
  originalName: "morning.mp4",
  mimeType: "video/mp4",
  kind: "video",
  sizeBytes: 1024,
  preview: "browser",
  license: null,
  credit: "Newsroom",
  tags: ["Morning"],
  rightsStatus: "pending",
  version: 4,
  createdAt: null,
  updatedAt: null,
};

function renderInspector(overrides: {
  asset?: SourceMediaAssetSummary;
  onSaved?: (receipt: VideoDetailsSaveReceipt) => void;
  onSaveSuccess?: (asset: SourceMediaAssetSummary) => void;
  onUpdated?: (asset: SourceMediaAssetSummary) => void;
} = {}) {
  return render(<VideoDetailsInspector
    asset={overrides.asset ?? asset}
    canDelete={false}
    canEditMetadata
    deleteConfirmationId="delete-video"
    getIdToken={async () => "token-a"}
    onDeleted={vi.fn()}
    onDirtyChange={vi.fn()}
    onSaved={overrides.onSaved}
    onSaveSuccess={overrides.onSaveSuccess}
    onSavingChange={vi.fn()}
    onUpdated={overrides.onUpdated ?? vi.fn()}
  />);
}

beforeEach(() => {
  vi.resetAllMocks();
  installMediaFeedbackFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("VideoDetailsInspector save receipt", () => {
  it("shows the exact source rate and CentralCast notice without changing metadata access", () => {
    renderInspector({ asset: { ...asset, viewingCopy: { state: "ready", sourceFrameRateNumerator: 24000, sourceFrameRateDenominator: 1001 } } });
    fireEvent.click(screen.getByText("File information"));
    expect(screen.getByText("23.976 fps (24000/1001)")).toBeInTheDocument();
    expect(screen.getByText(/CentralCast needs 29.97 fps/)).toHaveTextContent("Selection and publishing remain available");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
  });
  it("reports the confirmed prior values and post-save asset after one save", async () => {
    const onSaved = vi.fn();
    const saved = { ...asset, name: "Morning briefing", rightsStatus: "complete" as const, version: 5 };
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({ success: true, asset: saved });
    renderInspector({ onSaved });

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.change(screen.getByRole("combobox", { name: "Rights review" }), { target: { value: "complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      previous: {
        name: "Morning update",
        description: "",
        credit: "Newsroom",
        license: "",
        tags: ["Morning"],
        rightsStatus: "pending",
      },
      asset: saved,
    }));
    expect(updateSourceMediaMetadata).toHaveBeenCalledWith("token-a", "video-library", "video-1", 4,
      expect.objectContaining({ name: saved.name, rightsStatus: "complete" }));
  });

  it("does not report a receipt for a failed save", async () => {
    const onSaved = vi.fn();
    vi.mocked(updateSourceMediaMetadata).mockRejectedValue(new Error("Save failed"));
    renderInspector({ onSaved });

    expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Changed title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(await screen.findByText("Save failed")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["unchanged", 4],
  ])("does not report a receipt when the response version is %s", async (_label, version) => {
    const onSaved = vi.fn();
    const onUpdated = vi.fn();
    const responseAsset = { ...asset, name: "Changed title", version } as unknown as SourceMediaAssetSummary;
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({ success: true, asset: responseAsset });
    renderInspector({ onSaved, onUpdated });

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Changed title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await screen.findByText("Video details saved.");
    expect(onUpdated).toHaveBeenCalledWith(responseAsset);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reports a successful no-change response without creating an Undo receipt", async () => {
    const onSaved = vi.fn();
    const onSaveSuccess = vi.fn();
    const responseAsset = { ...asset, name: "Changed title" };
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({ success: true, asset: responseAsset });
    renderInspector({ onSaved, onSaveSuccess });

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: responseAsset.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(onSaveSuccess).toHaveBeenCalledWith(responseAsset));
    expect(onSaved).not.toHaveBeenCalled();
  });
});

it("reveals Comments and focuses the existing composer after a player comment request", async () => {
  const timing = { rate: null, fileVersion: "fixture-v1", draft: null, message: "", composerRequest: 0,
    onUseCurrent: vi.fn(), onSetIn: vi.fn(), onSetOut: vi.fn(), onClear: vi.fn(), onSeek: vi.fn() };
  const props = { asset, contextual: true, canDelete: false, canEditMetadata: true,
    deleteConfirmationId: "delete-video", getIdToken: async () => "fixture-token",
    onDeleted: vi.fn(), onDirtyChange: vi.fn(), onSavingChange: vi.fn(), onUpdated: vi.fn() };
  const view = render(<VideoDetailsInspector {...props} commentTiming={timing} />);
  await screen.findByText("No staff comments yet.");
  const composer = screen.getByLabelText("New comment");
  expect(composer).not.toBeVisible();
  view.rerender(<VideoDetailsInspector {...props} commentTiming={{ ...timing, composerRequest: 1 }} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true"));
  await waitFor(() => expect(composer).toHaveFocus());
  expect(screen.getByRole("textbox", { name: "New comment" })).toBe(composer);
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  const commentsTab = screen.getByRole("tab", { name: "Comments" });
  commentsTab.focus();
  fireEvent.click(commentsTab);
  expect(commentsTab).toHaveFocus();
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  view.rerender(<VideoDetailsInspector {...props} commentTiming={{ ...timing, composerRequest: 2 }} />);
  await waitFor(() => expect(composer).toHaveFocus());
  expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
});


it("reveals Comments for repeated activation of the same marker", async () => {
  const timing = { rate: null, fileVersion: "fixture-v1", draft: null, message: "", activeId: "comment-a", composerRequest: 0, navigationRequest: 1,
    onUseCurrent: vi.fn(), onSetIn: vi.fn(), onSetOut: vi.fn(), onClear: vi.fn(), onSeek: vi.fn() };
  const props = { asset, contextual: true, canDelete: false, canEditMetadata: true,
    deleteConfirmationId: "delete-video", getIdToken: async () => "fixture-token",
    onDeleted: vi.fn(), onDirtyChange: vi.fn(), onSavingChange: vi.fn(), onUpdated: vi.fn() };
  const view = render(<VideoDetailsInspector {...props} commentTiming={timing} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(screen.getByRole("tab", { name: "Details" }));
  expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");
  view.rerender(<VideoDetailsInspector {...props} commentTiming={{ ...timing, navigationRequest: 2 }} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Comments" })).toHaveAttribute("aria-selected", "true"));
  expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
});
