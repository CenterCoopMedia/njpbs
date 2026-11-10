import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoPreview } from "../src/routes/SourceMediaLibrary";
import type { MediaComment } from "../src/lib/media-feedback";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

const asset: SourceMediaAssetSummary = {
  id: "replaced-video", sourceId: "shared-video", name: "County meeting", originalName: "county.mp4",
  description: null, mimeType: "video/mp4", kind: "video", sizeBytes: 1024, preview: "browser",
  license: null, credit: null, tags: [], rightsStatus: "complete", version: 1, createdAt: null, updatedAt: null,
  fileVersion: "file-a", viewingCopy: { state: "ready", sizeBytes: 512, durationSeconds: 120 },
};
const noop = () => {};

function timedComment(currentVersion: boolean): MediaComment {
  return {
    id: "comment-1", authorUid: "editor", authorName: "Dana Editor", text: "Trim here", version: 1,
    createdAt: "2026-11-05T12:00:00.000Z", updatedAt: "2026-11-05T12:00:00.000Z", canEdit: false,
    time: { startFrame: null, endFrame: null, rateNum: null, rateDen: null, startMs: 60_000, endMs: null, currentVersion },
  };
}

let commentLists: Array<(currentVersion: boolean) => void>;
let servedFile: string;

beforeEach(() => {
  commentLists = [];
  servedFile = "file-a";
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = noop;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1);
    const body = JSON.parse(String(init?.body));
    if (endpoint === "cmsCreateSourceMediaRead") return Response.json({ success: true, access: {
      assetId: asset.id, action: body.action, url: `https://media.example.test/${servedFile}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(), mimeType: "video/mp4", fileVersion: servedFile,
      disposition: "inline", supportsRange: true, credit: null,
    } });
    if (endpoint === "cmsGetMediaReview") return Response.json({ success: true, review: null });
    if (endpoint === "cmsListMediaComments") {
      return new Promise<Response>(resolve => {
        commentLists.push(currentVersion => resolve(Response.json({
          success: true, comments: [timedComment(currentVersion)], nextCursor: null,
        })));
      });
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function viewer(fileVersion: string) {
  servedFile = fileVersion;
  return <VideoPreview asset={{ ...asset, fileVersion }} getIdToken={async () => "fixture-token"}
    canEditMetadata={false} canRequestProduction={false} canDelete={false} navigationBlocked={false}
    onClose={noop} onDeleted={noop} onUpdated={noop} onDirtyChange={noop} onSavingChange={noop}
    onDiscardNavigation={noop} onKeepNavigation={noop} />;
}

async function answerComments(call: number, currentVersion: boolean) {
  await waitFor(() => expect(commentLists).toHaveLength(call));
  await act(async () => { commentLists[call - 1](currentVersion); });
}

async function player(fileVersion: string) {
  const preview = () => screen.getByLabelText<HTMLVideoElement>("Preview County meeting");
  await waitFor(() => expect(preview().src).toBe(`https://media.example.test/${fileVersion}`));
  return preview();
}

const seekName = /Go to\s*1:00/;
const seekButton = () => screen.queryByRole("button", { name: seekName });
const marker = () => screen.queryByRole("button", { name: /^Comment by Dana Editor/ });

it("reloads comment times for a new file and blocks a stale seek until they arrive", async () => {
  const { rerender } = render(viewer("file-a"));
  await answerComments(1, true);
  fireEvent.click(await screen.findByRole("button", { name: seekName }));
  expect((await player("file-a")).currentTime).toBe(60);

  // A replacement arrives through the asset refresh, on the same mounted viewer.
  rerender(viewer("file-b"));
  await waitFor(() => expect(commentLists).toHaveLength(2));
  const replacement = await player("file-b");
  replacement.currentTime = 5;
  expect(seekButton()).toBeNull();
  expect(marker()).toBeNull();
  expect(screen.getByText("1:00")).toBeInTheDocument();
  expect(screen.queryByText(/Made on an earlier version/)).toBeNull();
  fireEvent.keyDown(replacement, { key: "]" });
  expect(replacement.currentTime).toBe(5);

  await answerComments(2, false);
  expect(await screen.findByText(/Made on an earlier version/)).toBeInTheDocument();
  expect(seekButton()).toBeNull();
  expect(marker()).toBeNull();

  // A rollback puts the same comment back on the restored file.
  rerender(viewer("file-a"));
  await waitFor(() => expect(commentLists).toHaveLength(3));
  expect(seekButton()).toBeNull();
  await answerComments(3, true);
  fireEvent.click(await screen.findByRole("button", { name: seekName }));
  expect((await player("file-a")).currentTime).toBe(60);
});
