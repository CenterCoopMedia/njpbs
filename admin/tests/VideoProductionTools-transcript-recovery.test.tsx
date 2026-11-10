import { useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useVideoProductionTools } from "../src/components/VideoProductionTools";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

// Only Firebase identity/App Check is supplied. Exercise the actual HTTP,
// transcript settings, variants, paging helpers and production hook.
vi.mock("../src/lib/firebase", () => ({ auth: { currentUser: null }, firebaseConfig: { projectId: "demo-njpbs" }, getRequiredAppCheckToken: async () => null }));
const token = async () => "fixture-token";
const asset = { id: "video-paging", sourceId: "video-library", name: "Meeting", fileVersion: "same-file",
  viewingCopy: { state: "ready", durationSeconds: 60, sizeBytes: 1024 } } as SourceMediaAssetSummary;
function Harness({ workspace = false, getIdToken = token }: { workspace?: boolean; getIdToken?: () => Promise<string> }) {
  const player = useRef<HTMLVideoElement>(null);
  const tools = useVideoProductionTools({ asset, getIdToken, player, canRequest: true, disabled: false, workspace });
  return <><video ref={player} data-testid="player" onTimeUpdate={tools.onTimeUpdate} />{tools.actions}{tools.content}{tools.transcriptPane}</>;
}
const first = (id = "original") => ({ id, state: "ready", editRevision: 0, totalSegments: 2,
  languageCode: "en-US", maxSpeakers: 10,
  segments: [{ index: 0, speaker: "spk_0", startSeconds: 0, endSeconds: id === "original" ? 2 : 5, text: `${id} first passage` }], nextCursor: `${id}-page` });
const page = (id: string) => ({ ...first(id), segments: [{ index: 1, speaker: "spk_0", startSeconds: 6, endSeconds: 8, text: `${id} second passage` }], nextCursor: null });
const reply = (transcript: ReturnType<typeof first> | ReturnType<typeof page>) => Response.json({ success: true, cached: true, transcript });
let answer: (endpoint: string, body: Record<string, string>) => Response | Promise<Response>;
beforeEach(() => {
  answer = (endpoint, body) => endpoint === "cmsGetVideoTranscript" ? reply(first(body.transcriptId))
    : endpoint === "cmsListVideoTranscripts" ? Response.json({ success: true, transcripts: [first("variant")], nextCursor: null })
    : Response.json({ error: "No paid transcription in this fixture" }, { status: 503 });
  vi.stubGlobal("fetch", vi.fn(async (input, init) => answer(String(input).split("/").at(-1)!, JSON.parse(String(init?.body ?? "{}")))));
});
afterEach(() => vi.unstubAllGlobals());
async function openSettings(workspace = false) {
  const disclosure = screen.getByText(workspace ? "Transcript settings" : "Transcript", { selector: "summary" }).closest("details")!;
  await act(async () => { disclosure.open = true; fireEvent(disclosure, new Event("toggle")); });
}

it("continues paging the selected variant after an old playback page resolves", async () => {
  let finish!: (response: Response) => void;
  const normal = answer;
  answer = (endpoint, body) => {
    if (endpoint === "cmsGetVideoTranscript" && body.cursor) return body.transcriptId === "original"
      ? new Promise(resolve => { finish = resolve; }) : reply(page("variant"));
    return normal(endpoint, body);
  };
  render(<Harness workspace />);
  await screen.findByText("original first passage");
  const player = screen.getByTestId("player") as HTMLVideoElement;
  await act(async () => { player.currentTime = 3; fireEvent.timeUpdate(player); });
  await waitFor(() => expect(finish).toBeDefined());
  await openSettings(true);
  const choices = await screen.findByLabelText("Saved transcript");
  await act(async () => { fireEvent.change(choices, { target: { value: "variant" } }); });
  await screen.findByText("variant first passage");
  await act(async () => { finish(reply(page("original"))); });
  expect(screen.queryByText("original second passage")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more transcript" })).toBeEnabled();
  await act(async () => { player.currentTime = 6; fireEvent.timeUpdate(player); });
  expect(await screen.findByText("variant second passage")).toBeVisible();
});

it("releases foreground paging after the saved-transcript effect reloads the same file", async () => {
  let finish!: (response: Response) => void;
  let pages = 0;
  const normal = answer;
  answer = (endpoint, body) => endpoint === "cmsGetVideoTranscript" && body.cursor
    ? ++pages === 1 ? new Promise(resolve => { finish = resolve; }) : reply(page("original"))
    : normal(endpoint, body);
  const view = render(<Harness />);
  await openSettings();
  await screen.findByText("original first passage");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more transcript" })); });
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { view.rerender(<Harness getIdToken={async () => "refreshed-token"} />); });
  await act(async () => { finish(reply(page("stale"))); });
  expect(screen.queryByText("stale second passage")).toBeNull();
  expect(screen.getByRole("button", { name: "Load more transcript" })).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more transcript" })); });
  expect(await screen.findByText("original second passage")).toBeVisible();
});
