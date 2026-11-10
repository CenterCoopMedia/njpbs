import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceoverLibraryRoute } from "../src/routes/VoiceoverLibraryRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";

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

function take(id: string, style: string, takeNumber: number) {
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
  };
}

function library(count = 2) {
  return {
    success: true as const,
    schemaVersion: 1,
    manifestVersion: 1,
    performers: { "jordan-avery": { name: "Jordan Avery" } },
    takes: Array.from({ length: count }, (_, index) => take(
      `take-${index}`,
      index % 2 === 0 ? "soft-spoken" : "masculine",
      index + 1,
    )),
    reviews: {},
  };
}

const shell: ShellData = {
  principal: { id: "reviewer-1", grants: [{ role: "admin" }] },
  user: { uid: "reviewer-1", email: "account-20@example.org" },
  userDoc: null,
  signOut: vi.fn(),
};

function renderLibrary(mode: "strict" | "plain" = "plain") {
  const router = createMemoryRouter(
    [{
      path: "/voiceovers",
      element: (
        <ShellProvider value={shell}>
          <VoiceoverLibraryRoute />
        </ShellProvider>
      ),
    }],
    { initialEntries: ["/voiceovers"] },
  );
  const page = <RouterProvider router={router} />;
  return render(mode === "strict" ? <StrictMode>{page}</StrictMode> : page);
}

function rows() {
  return screen.getAllByText("You're watching NJ PBS.").map((reading) => {
    const row = reading.closest("tr");
    if (!row) throw new Error("Voiceover row is missing");
    return row;
  });
}

function mountedPlayers(container: ParentNode = document) {
  return container.querySelectorAll("audio.voiceover-player-audio").length;
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

describe("voiceover player mounting", () => {
  it("renders a light row and mounts one player for the take being played", async () => {
    mocks.list.mockResolvedValue(library());
    const view = renderLibrary();
    await screen.findByRole("heading", { name: "Audio" });

    expect(mountedPlayers(view.container)).toBe(0);
    expect(view.container.querySelectorAll("input[type='range']")).toHaveLength(0);

    const [first, second] = rows();
    expect(within(first).getByRole("button", { name: "Listen" })).toHaveAttribute("type", "button");
    expect(within(first).getByText("Saved")).toBeInTheDocument();
    expect(within(first).getByLabelText("Watching NJ PBS, Soft-spoken, take 1 playback time"))
      .toHaveTextContent("0:02");
    expect(within(first).queryByRole("slider")).not.toBeInTheDocument();
    expect(within(second).getByRole("button", { name: "Listen" })).toBeEnabled();

    mocks.audio.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
    fireEvent.click(within(first).getByRole("button", { name: "Listen" }));
    expect(within(first).getByRole("button", { name: "Listen" })).toHaveFocus();
    expect(mountedPlayers(view.container)).toBe(1);
    expect(first.querySelector("audio.voiceover-player-audio")).not.toBeNull();
    expect(second.querySelector("audio")).toBeNull();
    expect(within(second).queryByRole("slider")).not.toBeInTheDocument();

    await waitFor(() => expect(mocks.peaks).toHaveBeenCalledTimes(1));
    const audio = first.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 2.1 });
    fireEvent.loadedMetadata(audio);
    expect(within(first).getByRole("slider", {
      name: "Watching NJ PBS, Soft-spoken, take 1 playback position",
    })).toBeEnabled();
  });

  it("moves the mounted player when another take starts", async () => {
    const firstAudio = deferred<Blob>();
    const secondAudio = deferred<Blob>();
    mocks.audio.mockReturnValueOnce(firstAudio.promise).mockReturnValueOnce(secondAudio.promise);
    mocks.list.mockResolvedValue(library());
    const view = renderLibrary();
    await screen.findByRole("heading", { name: "Audio" });
    const [first, second] = rows();

    fireEvent.click(within(first).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.audio.mock.calls[0][2] as AbortSignal;

    fireEvent.click(within(second).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(mountedPlayers(view.container)).toBe(1);
    expect(first.querySelector("audio")).toBeNull();
    expect(second.querySelector("audio.voiceover-player-audio")).not.toBeNull();
    expect(within(first).getByRole("button", { name: "Listen" })).toBeEnabled();
    expect(within(second).getByRole("button", { name: "Listen" })).toHaveFocus();

    await act(async () => {
      firstAudio.resolve(new Blob(["first"], { type: "audio/wav" }));
      secondAudio.resolve(new Blob(["second"], { type: "audio/wav" }));
    });
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  });

  it("keeps Listen closed while that take's download is still loading", async () => {
    const download = deferred<Blob>();
    mocks.audio.mockReturnValueOnce(download.promise);
    mocks.list.mockResolvedValue(library());
    renderLibrary();
    await screen.findByRole("heading", { name: "Audio" });
    const row = rows()[0];

    fireEvent.click(within(row).getByRole("button", { name: "Download WAV" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(1));
    const listen = within(row).getByRole("button", { name: "Listen" });
    expect(listen).toBeDisabled();
    fireEvent.click(listen);
    expect(mocks.audio).toHaveBeenCalledTimes(1);
    expect(row.querySelector("audio")).toBeNull();

    await act(async () => {
      download.resolve(new Blob(["wav"], { type: "audio/wav" }));
    });
    await waitFor(() => expect(within(row).getByRole("button", { name: "Listen" })).toBeEnabled());
  });

  it("loads one recording when StrictMode replays mount effects", async () => {
    mocks.list.mockResolvedValue(library());
    mocks.audio.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
    renderLibrary("strict");
    await screen.findByRole("heading", { name: "Audio" });
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Listen" }));
    await waitFor(() => expect(mocks.audio).toHaveBeenCalledTimes(1));
    expect(mountedPlayers()).toBe(1);
  });

  it("keeps a 100-take library free of players until one take is played", async () => {
    mocks.list.mockResolvedValue(library(100));
    mocks.audio.mockResolvedValue(new Blob(["wav"], { type: "audio/wav" }));
    const view = renderLibrary();
    await screen.findByRole("heading", { name: "Audio" });
    expect(screen.getAllByRole("button", { name: "Listen" })).toHaveLength(100);
    expect(screen.getAllByText("Saved")).toHaveLength(100);
    expect(mountedPlayers(view.container)).toBe(0);
    expect(view.container.querySelectorAll("input[type='range']")).toHaveLength(0);

    fireEvent.click(screen.getAllByRole("button", { name: "Listen" })[0]);
    await waitFor(() => expect(mountedPlayers(view.container)).toBe(1));
    expect(view.container.querySelectorAll("input[type='range']")).toHaveLength(1);
  }, 15_000);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
