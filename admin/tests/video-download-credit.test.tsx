import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoPreview } from "../src/routes/SourceMediaLibrary";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

const asset: SourceMediaAssetSummary = {
  id: "credit-video", sourceId: "video-library", name: "County meeting", originalName: "county.mp4",
  description: null, mimeType: "video/mp4", kind: "video", sizeBytes: 1024, preview: "browser",
  license: null, credit: null, tags: [], rightsStatus: "complete", version: 1, createdAt: null, updatedAt: null,
  viewingCopy: { state: "ready", sizeBytes: 512 },
};
let currentCredit: string | null;
let requests: string[];
let downloads: string[];
let clockSkew: number;
let linkLifetime: number;
const noop = () => {};

beforeEach(() => {
  currentCredit = null;
  requests = [];
  downloads = [];
  clockSkew = 0;
  linkLifetime = 300_000;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.href); });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1);
    const body = JSON.parse(String(init?.body));
    requests.push(`${endpoint}:${body.action ?? ""}`);
    if (endpoint === "cmsCreateSourceMediaRead") return Response.json({ success: true, access: {
      assetId: asset.id, action: body.action, url: `https://media.example.test/${body.action}`,
      expiresAt: new Date(Date.now() - clockSkew + linkLifetime).toISOString(), mimeType: "video/mp4",
      disposition: body.action === "preview" ? "inline" : "attachment", supportsRange: true, credit: currentCredit,
    } });
    if (endpoint === "cmsGetMediaReview") return Response.json({ success: true, review: null });
    if (endpoint === "cmsListMediaComments") return Response.json({ success: true, comments: [], nextCursor: null });
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openVideo(credit: string | null = null) {
  render(<VideoPreview asset={{ ...asset, credit }} getIdToken={async () => "fixture-token"}
    canEditMetadata={false} canRequestProduction={false} canDelete={false} navigationBlocked={false}
    onClose={noop} onDeleted={noop} onUpdated={noop} onDirtyChange={noop} onSavingChange={noop}
    onDiscardNavigation={noop} onKeepNavigation={noop} />);
  return screen.findByLabelText("Preview County meeting");
}

function chooseDownload(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${label}`) }));
}

it.each([
  ["Original", "download"], ["Web copy", "download_web"],
])("checks fresh credit before %s and keeps one authorization request per attempt", async (label, action) => {
  await openVideo();
  currentCredit = "County pool camera"; // Another editor changed the credit after the preview opened.
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  chooseDownload(label);
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm.mock.calls[0][0]).toContain("County pool camera");
  expect(downloads).toEqual([]);
  await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
  chooseDownload(label);
  await waitFor(() => expect(downloads).toEqual([`https://media.example.test/${action}`]));
  expect(requests.filter(value => value.startsWith("cmsCreateSourceMediaRead:")))
    .toEqual(["cmsCreateSourceMediaRead:preview", `cmsCreateSourceMediaRead:${action}`, `cmsCreateSourceMediaRead:${action}`]);
});

it("explains a pending download and prevents opening a second format", async () => {
  await openVideo();
  const respond = fetch;
  let release!: () => void;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).action !== "download") return respond(input, init);
    return new Promise<Response>(resolve => { release = () => { void respond(input, init).then(resolve); }; });
  });
  chooseDownload("Original");
  const pending = await screen.findByRole("button", { name: "Preparing original" });
  expect(pending).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(pending);
  expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  await waitFor(() => expect(release).toBeDefined());
  release();
  await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).not.toHaveAttribute("aria-disabled"));
});

it("asks again when the authorized credit differs from the credit already acknowledged", async () => {
  await openVideo("Original credit");
  currentCredit = "Corrected pool credit";
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
  chooseDownload("Original");
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  expect(confirm.mock.calls[1][0]).toContain("Corrected pool credit");
  expect(downloads).toEqual([]);
});

it("does not repeat a matching credit warning or prompt for an uncredited download", async () => {
  currentCredit = "NJ PBS";
  await openVideo(currentCredit);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  chooseDownload("Original");
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(confirm).toHaveBeenCalledOnce();
  cleanup();
  currentCredit = null;
  await openVideo();
  chooseDownload("Original");
  await waitFor(() => expect(downloads).toHaveLength(2));
  expect(confirm).toHaveBeenCalledOnce();
});

it("keeps playback controls while blocking native download controls and the player context menu", async () => {
  const player = await openVideo();
  expect(player).toHaveAttribute("controls");
  expect(player).toHaveAttribute("controlslist", "nodownload");
  expect(fireEvent.contextMenu(player)).toBe(false);
});

it("renews an expired authorization and checks its changed credit before downloading", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await openVideo();
  currentCredit = "County pool camera";
  const confirm = vi.spyOn(window, "confirm").mockImplementationOnce(() => {
    now += 300_001;
    currentCredit = "Corrected pool credit";
    return true;
  }).mockReturnValue(false);
  chooseDownload("Original");
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  expect(confirm.mock.calls[1][0]).toContain("Corrected pool credit");
  expect(downloads).toEqual([]);
  expect(requests.filter(value => value === "cmsCreateSourceMediaRead:download")).toHaveLength(2);
});

it("bounds renewal when both credit confirmations outlive their links", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await openVideo();
  currentCredit = "County pool camera";
  vi.spyOn(window, "confirm").mockImplementation(() => {
    now += 300_001;
    currentCredit += " updated";
    return true;
  });
  chooseDownload("Original");
  await screen.findByText("The download link expired. Try again.");
  expect(downloads).toEqual([]);
  expect(requests.filter(value => value === "cmsCreateSourceMediaRead:download")).toHaveLength(2);
});

it("downloads with a fast client clock without renewing a fresh link", async () => {
  clockSkew = 600_000;
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + clockSkew);
  await openVideo();
  chooseDownload("Original");
  await waitFor(() => expect(downloads).toEqual(["https://media.example.test/download"]));
  expect(requests.filter(value => value === "cmsCreateSourceMediaRead:download")).toHaveLength(1);
});


it("retains a long private preview during playback and renews it after pause", async () => {
  linkLifetime = 3_600_000;
  const timers: Array<{ run: () => void; delay: number }> = [];
  const schedule = window.setTimeout.bind(window);
  vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof handler === "function" && (delay ?? 0) > 3_500_000) timers.push({ run: handler as () => void, delay: delay! });
    return schedule(handler, delay, ...args);
  }) as typeof window.setTimeout);
  const video = await openVideo() as HTMLVideoElement;
  await waitFor(() => expect(timers).toHaveLength(1));
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  const originalUrl = video.src;
  timers[0].run();
  expect(requests.filter(value => value === "cmsCreateSourceMediaRead:preview")).toHaveLength(1);
  expect(video.src).toBe(originalUrl);
  Object.defineProperty(video, "paused", { configurable: true, value: true });
  fireEvent.pause(video);
  await waitFor(() => expect(requests.filter(value => value === "cmsCreateSourceMediaRead:preview")).toHaveLength(2));
});
