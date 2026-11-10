import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceoverLibraryRoute } from "../src/routes/VoiceoverLibraryRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { VoiceoverTake } from "../src/lib/voiceovers";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  audio: vi.fn(),
  peaks: vi.fn(),
}));

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/voiceovers", () => ({
  cmsListVoiceovers: mocks.list,
  cmsSaveVoiceoverReview: mocks.save,
  cmsGetVoiceoverAudio: mocks.audio,
}));

vi.mock("../src/lib/waveform", () => ({ deriveWaveformPeaks: mocks.peaks }));

vi.mock("../src/lib/functions", () => ({
  isConflictError: (error: unknown) =>
    typeof error === "object" && error !== null &&
    (error as { status?: unknown }).status === 409,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function take(id: string, style: string, takeNumber: number, overrides: Partial<VoiceoverTake> = {}): VoiceoverTake {
  return {
    id,
    family_id: "watching-station",
    family: "Watching NJ PBS",
    take: takeNumber,
    style,
    performer_id: "jordan-avery",
    text: "You're watching NJ PBS.",
    display_text: "You're watching NJ PBS.",
    complete: true,
    flags: [],
    duration_seconds: 2.1,
    ...overrides,
  };
}

function library(reviews: Record<string, unknown> = {}) {
  return {
    success: true as const,
    schemaVersion: 1,
    manifestVersion: 1,
    performers: { "jordan-avery": { name: "Jordan Avery" } },
    takes: [
      take("soft-spoken-watching-station-01", "soft-spoken", 1),
      take("masculine-watching-station-01", "masculine", 1),
    ],
    reviews,
  };
}

const shell: ShellData = {
  principal: { id: "reviewer-1", grants: [{ role: "admin" }] },
  user: { uid: "reviewer-1", email: "account-20@example.org" },
  userDoc: null,
  signOut: vi.fn(),
};

function renderRoute() {
  const router = createMemoryRouter(
    [{ path: "/voiceovers", element: <ShellProvider value={shell}><VoiceoverLibraryRoute /></ShellProvider> }],
    { initialEntries: ["/voiceovers"] },
  );
  return render(<RouterProvider router={router} />);
}

function firstRow(): HTMLTableRowElement {
  const reading = screen.getAllByText("You're watching NJ PBS.")[0];
  const row = reading.closest("tr");
  if (!row) throw new Error("Voiceover row is missing");
  return row;
}

function chooseFilter(property: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: /^Filter(?:, \d+ applied)?$/ }));
  const dialog = screen.getByRole("dialog", { name: "Filter" });
  fireEvent.click(within(dialog).getByRole("button", { name: property }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: option }));
  fireEvent.keyDown(dialog, { key: "Escape" });
}

async function renderLoaded() {
  mocks.list.mockResolvedValueOnce(library());
  const view = renderRoute();
  await screen.findByRole("heading", { name: "Audio" });
  return view;
}

beforeEach(() => {
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.list.mockReset();
  mocks.save.mockReset();
  mocks.audio.mockReset();
  mocks.peaks.mockReset().mockResolvedValue(Array(48).fill(0.5));
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:voiceover"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voiceover library route", () => {
  it("filters the loaded library through the shared toolbar without another list request", async () => {
    mocks.list.mockResolvedValueOnce({
      ...library({
        "soft-spoken-watching-station-01": {
          favorite: true, moreLikeThis: false, notes: "", version: 1, updatedAt: null,
        },
      }),
      performers: {
        "jordan-avery": { name: "Jordan Avery" },
        "alex-rivera": { name: "Alex Rivera" },
      },
      takes: [
        take("soft-spoken-watching-station-01", "soft-spoken", 1),
        take("masculine-evening-line-01", "masculine", 1, {
          family_id: "evening-line", family: "Good evening", performer_id: "alex-rivera",
          text: "Good evening from NJ PBS.", display_text: "Good evening from NJ PBS.",
        }),
        take("soft-spoken-incomplete-01", "soft-spoken", 2, {
          complete: false, text: "Incomplete sample.", display_text: "Incomplete sample.",
        }),
      ],
    });
    renderRoute();
    await screen.findByRole("heading", { name: "Audio" });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(mocks.list).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search voiceover lines" }), {
      target: { value: "good evening" },
    });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.getByText("Good evening from NJ PBS.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    chooseFilter("Style", "Soft-spoken");
    fireEvent.click(screen.getByRole("button", { name: "Edit filter Style: Soft-spoken" }));
    const styleDialog = screen.getByRole("dialog", { name: "Filter" });
    expect(within(styleDialog).getByRole("checkbox", { name: "Soft-spoken" })).toBeChecked();
    fireEvent.keyDown(styleDialog, { key: "Escape" });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Style: Soft-spoken" }));

    chooseFilter("Recorder", "Alex Rivera");
    expect(screen.getByText("Good evening from NJ PBS.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Recorder: Alex Rivera" }));
    chooseFilter("Line family", "Good evening");
    expect(screen.getByText("Good evening from NJ PBS.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Line family: Good evening" }));
    chooseFilter("Favorites only", "Only favorites");
    expect(screen.getByRole("button", { name: "Edit filter Favorites only: On" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Favorites only: On" }));
    chooseFilter("Incomplete attempts", "Show incomplete attempts");
    expect(screen.getByRole("button", { name: "Edit filter Incomplete attempts: Shown" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("clears all filters to the default that hides incomplete attempts", async () => {
    mocks.list.mockResolvedValueOnce({
      ...library(),
      takes: [
        ...library().takes,
        take("soft-spoken-incomplete-01", "soft-spoken", 2, {
          complete: false, text: "Incomplete sample.", display_text: "Incomplete sample.",
        }),
      ],
    });
    renderRoute();
    await screen.findByRole("heading", { name: "Audio" });
    chooseFilter("Incomplete attempts", "Show incomplete attempts");
    chooseFilter("Style", "Soft-spoken");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search voiceover lines" }), {
      target: { value: "incomplete" },
    });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.getByText("Incomplete sample.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Applied filters" }))
      .getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("searchbox", { name: "Search voiceover lines" })).toHaveValue("");
    expect(screen.queryByText("Incomplete sample.")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByRole("group", { name: "Applied filters" })).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending search draft when Clear all resets filters", async () => {
    await renderLoaded();
    chooseFilter("Style", "Soft-spoken");
    chooseFilter("Favorites only", "Only favorites");
    const search = screen.getByRole("searchbox", { name: "Search voiceover lines" });
    fireEvent.change(search, { target: { value: "no match" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Applied filters" }))
      .getByRole("button", { name: "Clear all" }));
    expect(search).toHaveValue("");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(search).toHaveValue("");
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("shows only search and filter controls for Voiceovers", async () => {
    await renderLoaded();
    expect(screen.getByRole("searchbox", { name: "Search voiceover lines" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Display/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Select/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("draws a waveform from the requested WAV without delaying playback or refetching", async () => {
    const decoding = deferred<number[]>();
    const wav = new Blob(["fixture WAV"], { type: "audio/wav" });
    mocks.audio.mockResolvedValue(wav);
    mocks.peaks.mockReturnValue(decoding.promise);
    await renderLoaded();
    expect(mocks.audio).not.toHaveBeenCalled();
    expect(mocks.peaks).not.toHaveBeenCalled();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.peaks).toHaveBeenCalledWith(wav));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(mocks.audio).toHaveBeenCalledTimes(1);
    await act(async () => decoding.resolve(Array(48).fill(0.5)));
    fireEvent.click(within(row).getByRole("button", { name: "Listen" }));
    expect(mocks.audio).toHaveBeenCalledTimes(1);
  });

  it("keeps pause available while a separate WAV download is pending", async () => {
    const download = deferred<Blob>();
    mocks.audio.mockResolvedValueOnce(new Blob(["WAV"], { type: "audio/wav" }))
      .mockReturnValueOnce(download.promise);
    await renderLoaded();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.peaks).toHaveBeenCalled());
    const audio = row.querySelector("audio")!;
    fireEvent.play(audio);
    fireEvent.click(within(row).getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(2));
    expect(within(row).getByRole("button", { name: "Pause" })).toBeEnabled();
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  });

  it("ignores a waveform that finishes after its audio is removed by a filter", async () => {
    const decoding = deferred<number[]>();
    mocks.audio.mockResolvedValue(new Blob(["fixture WAV"], { type: "audio/wav" }));
    mocks.peaks.mockReturnValue(decoding.promise);
    await renderLoaded();
    fireEvent.click(within(firstRow()).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.peaks).toHaveBeenCalledTimes(1));
    chooseFilter("Style", "Masculine");
    await act(async () => decoding.resolve(Array(48).fill(0.5)));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Style: Masculine" }));
    expect(firstRow().querySelector(".voiceover-player-waveform")).toBeNull();
  });

  it("serializes later review edits behind the saved version", async () => {
    const firstSave = deferred<{
      success: true;
      takeId: string;
      review: { favorite: boolean; moreLikeThis: boolean; notes: string; version: number; updatedAt: string | null };
    }>();
    mocks.save
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({
        success: true,
        takeId: "soft-spoken-watching-station-01",
        review: { favorite: true, moreLikeThis: false, notes: "Warm station ID.", version: 2, updatedAt: null },
      });

    await renderLoaded();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Favorite" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    fireEvent.change(within(row).getByRole("textbox", { name: "Notes" }), {
      target: { value: "Warm station ID." },
    });
    expect(row.querySelector("summary")).toHaveAccessibleName("Notes and requests, note added");
    expect(mocks.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve({
        success: true,
        takeId: "soft-spoken-watching-station-01",
        review: { favorite: true, moreLikeThis: false, notes: "", version: 1, updatedAt: null },
      });
    });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save).toHaveBeenNthCalledWith(
      2,
      "id-token",
      expect.objectContaining({
        takeId: "soft-spoken-watching-station-01",
        baseVersion: 1,
        favorite: true,
        moreLikeThis: false,
        notes: "Warm station ID.",
      }),
      expect.any(AbortSignal),
    );
  });

  it("keeps later local edits after a conflict and requires an explicit resolution", async () => {
    const firstSave = deferred<never>();
    mocks.save.mockReturnValueOnce(firstSave.promise);

    await renderLoaded();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Favorite" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    fireEvent.click(within(row).getByRole("checkbox", { name: "More like this" }));

    await act(async () => {
      firstSave.reject(Object.assign(new Error("stale"), { status: 409 }));
    });
    expect(await screen.findByText("Needs review")).toBeInTheDocument();
    expect(within(row).getByRole("checkbox", { name: "Favorite" })).toBeChecked();
    expect(within(row).getByRole("checkbox", { name: "More like this" })).toBeChecked();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(within(row).getByRole("button", { name: "Reload saved review" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Retry my choices" })).toBeInTheDocument();

    const refreshed = deferred<ReturnType<typeof library>>();
    mocks.list.mockReturnValueOnce(refreshed.promise);
    fireEvent.click(within(row).getByRole("button", { name: "Reload saved review" }));
    fireEvent.change(within(row).getByRole("textbox", { name: "Notes" }), {
      target: { value: "Keep this newer note." },
    });
    await act(async () => {
      refreshed.resolve(library({
        "soft-spoken-watching-station-01": {
          favorite: false,
          moreLikeThis: false,
          notes: "Older saved note.",
          version: 4,
          updatedAt: null,
        },
      }));
    });
    expect(within(row).getByRole("textbox", { name: "Notes" })).toHaveValue("Keep this newer note.");
  });

  it("does not create an audio URL for a superseded play request and revokes the active one on unmount", async () => {
    const firstAudio = deferred<Blob>();
    const secondAudio = deferred<Blob>();
    mocks.audio
      .mockReturnValueOnce(firstAudio.promise)
      .mockReturnValueOnce(secondAudio.promise);

    const view = await renderLoaded();
    expect(mocks.audio).not.toHaveBeenCalled();
    const rows = screen.getAllByText("You're watching NJ PBS.").map((reading) => reading.closest("tr")!);
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.audio.mock.calls[0][2] as AbortSignal;
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    await act(async () => { firstAudio.resolve(new Blob(["first"], { type: "audio/wav" })); });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    await act(async () => { secondAudio.resolve(new Blob(["second"], { type: "audio/wav" })); });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voiceover");
  });

  it("cancels audio hidden by a filter and permits a fresh load when it returns", async () => {
    const pending = deferred<Blob>();
    mocks.audio.mockReturnValueOnce(pending.promise);
    await renderLoaded();
    fireEvent.click(within(firstRow()).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(1));
    const signal = mocks.audio.mock.calls[0][2] as AbortSignal;
    chooseFilter("Style", "Masculine");
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(new Blob(["old"], { type: "audio/wav" })); });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Style: Masculine" }));
    expect(within(firstRow()).getByRole("button", { name: "Listen" })).toBeEnabled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("releases playing audio when a filter removes its row", async () => {
    mocks.audio.mockResolvedValue(new Blob(["audio"], { type: "audio/wav" }));
    await renderLoaded();
    fireEvent.click(within(firstRow()).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    chooseFilter("Style", "Masculine");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voiceover");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Style: Masculine" }));
    fireEvent.click(within(firstRow()).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(2));
  });

  it("keeps local choices without retrying a take removed from the refreshed library", async () => {
    mocks.save.mockRejectedValueOnce(Object.assign(new Error("stale"), { status: 409 }));
    await renderLoaded();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Favorite" }));
    await screen.findByText("Needs review");
    mocks.list.mockResolvedValueOnce({ ...library(), takes: [] });
    fireEvent.click(within(row).getByRole("button", { name: "Retry my choices" }));
    await screen.findByText("This take is no longer in the library. Copy your notes before reloading the page.");
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(within(row).getByRole("checkbox", { name: "Favorite" })).toBeChecked();
  });

  it("retries intentional local choices only after loading the current server version", async () => {
    const firstSave = deferred<never>();
    mocks.save
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({
        success: true,
        takeId: "soft-spoken-watching-station-01",
        review: { favorite: true, moreLikeThis: true, notes: "", version: 8, updatedAt: null },
      });

    await renderLoaded();
    const row = firstRow();
    fireEvent.click(within(row).getByRole("checkbox", { name: "Favorite" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    fireEvent.click(within(row).getByRole("checkbox", { name: "More like this" }));
    await act(async () => {
      firstSave.reject(Object.assign(new Error("stale"), { status: 409 }));
    });
    await screen.findByText("Needs review");

    mocks.list.mockResolvedValueOnce({ ...library({
      "soft-spoken-watching-station-01": {
        favorite: false,
        moreLikeThis: false,
        notes: "",
        version: 7,
        updatedAt: null,
      },
    }), manifestVersion: 2 });
    fireEvent.click(within(row).getByRole("button", { name: "Retry my choices" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save).toHaveBeenNthCalledWith(
      2,
      "id-token",
      expect.objectContaining({
        takeId: "soft-spoken-watching-station-01",
        baseVersion: 7,
        manifestVersion: 2,
        favorite: true,
        moreLikeThis: true,
        notes: "",
      }),
      expect.any(AbortSignal),
    );
  });
});
