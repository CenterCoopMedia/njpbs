import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptEditor } from "../src/components/TranscriptEditor";
import { HttpError } from "../src/lib/functions";
import type { TranscriptResponse } from "../src/lib/video-production";
vi.mock("../src/lib/functions", () => ({ HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } }));
afterEach(cleanup);
const response: TranscriptResponse = { success: true, cached: true, transcript: { state: "ready", editRevision: 3, totalSegments: 1, speakerIds: ["unknown", "spk_0"], speakerNames: { spk_0: "Alex" } }, segments: [{ index: 0, speaker: "unknown", startSeconds: 1, endSeconds: 3, text: "Example passage", speakerUncertain: true, overlappingSpeech: true }], nextCursor: null };
function setup(value = response, onSave = vi.fn().mockResolvedValue(response)) {
 const props = { response: value, onSave, onAlign: vi.fn().mockResolvedValue({ state: "queued", timingBasis: "viewing-copy-elapsed", requestId: "a".repeat(64) }),
  onCancelAlignment: vi.fn().mockResolvedValue({ state: "cancelled", timingBasis: "viewing-copy-elapsed", requestId: "a".repeat(64) }),
  canEdit: true, disabled: false, onSeek: vi.fn(), onSaved: vi.fn(), onReload: vi.fn(), onDirtyChange: vi.fn(), onSavingChange: vi.fn(), onEditingChange: vi.fn(), onSelectPassage: vi.fn(), canSelectPassage: () => true };
 return { ...render(<TranscriptEditor {...props} />), props };
}
describe("broadcast transcript review", () => {
 it("requires all passages and an explicit audio check, then sends only the review revision", async () => {
  const onSave = vi.fn().mockResolvedValue(response);
  const view = setup({ ...response, nextCursor: "next", transcript: { ...response.transcript, totalSegments: 2 } }, onSave);
  expect(screen.getByRole("checkbox")).toBeDisabled();
  view.rerender(<TranscriptEditor {...view.props} response={response} />);
  expect(screen.getByRole("button", { name: "Mark transcript reviewed" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark transcript reviewed" })); });
  expect(onSave).toHaveBeenCalledWith({ revision: 3, reviewed: true });
 });
 it("keeps unknown voices unassigned and saves named-speaker roles with changed passages", async () => {
  const { props } = setup();
  expect(screen.getByText("Speaker uncertain · Overlapping speech")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
  expect(screen.queryByRole("textbox", { name: "Unknown speaker name" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Speaker 1 title or affiliation" }), { target: { value: "Reporter" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Speaker for passage 1" }), { target: { value: "spk_0" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save transcript" })); });
  expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: {}, speakerRoles: { spk_0: "Reporter" }, segments: [{ index: 0, text: "Example passage", speaker: "spk_0" }] });
 });
 it("preserves review conflicts and never shows raw errors", async () => {
  setup(response, vi.fn().mockRejectedValue(new HttpError(409, "private provider detail")));
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark transcript reviewed" })); });
  expect(screen.getByRole("button", { name: "Mark transcript reviewed" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Reload saved transcript" })).toBeEnabled();
  expect(screen.queryByText(/private provider/)).not.toBeInTheDocument();
 });
 it("shows review name and revision, and passes the saved passage for clipping", () => {
  const { props } = setup({ ...response, transcript: { ...response.transcript, reviewedRevision: 3, reviewedByName: "Alex", reviewedBy: "private-uid", reviewedAt: "2026-09-15T16:00:00Z" } });
  expect(screen.getByText(/Revision 3 checked by Alex/)).toBeInTheDocument();
  expect(screen.queryByText(/private-uid/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Passage 1 actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Use passage 1 as clip" }));
  expect(props.onSelectPassage).toHaveBeenCalledWith(response.segments![0]);
 });
 it("queues corrected-word timing only after the current revision is reviewed", async () => {
  const reviewed = { ...response, transcript: { ...response.transcript, id: "b".repeat(64), reviewedRevision: 3 },
   segments: [{ ...response.segments![0], overlappingSpeech: false }] };
  const { props } = setup(reviewed);
  expect(screen.getByText(/model estimates in elapsed viewing-copy time/)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Align corrected words" })); });
  expect(props.onAlign).toHaveBeenCalledWith(false);
  expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ transcript: expect.objectContaining({
   alignment: expect.objectContaining({ state: "queued" }),
  }) }));
 });
 it("does not offer alignment when every untimed passage is ineligible", () => {
  const reviewed = { ...response, segments: [
    { ...response.segments![0], overlappingSpeech: true },
    { ...response.segments![0], index: 1, startSeconds: 4, endSeconds: 5, text: "" },
    { ...response.segments![0], index: 2, startSeconds: 6, endSeconds: 187, text: "Too long", overlappingSpeech: false },
   ], transcript: { ...response.transcript, id: "b".repeat(64), reviewedRevision: 3, totalSegments: 3 } };
  setup(reviewed);
  expect(screen.queryByRole("button", { name: "Align corrected words" })).not.toBeInTheDocument();
  expect(screen.getByText(/cannot be aligned automatically/)).toBeInTheDocument();
 });
 it("uses the saved remaining count after a partial alignment output", () => {
  const unavailable = { ...response, transcript: { ...response.transcript, id: "b".repeat(64),
   reviewedRevision: 3, alignment: { state: "unavailable" as const,
    timingBasis: "viewing-copy-elapsed" as const, requestId: "a".repeat(64), revision: 3,
    eligiblePassages: 0, unavailablePassages: 1 } },
   segments: [{ ...response.segments![0], overlappingSpeech: false }] };
  setup(unavailable);
  expect(screen.queryByRole("button", { name: "Retry word alignment" })).not.toBeInTheDocument();
  expect(screen.getByText(/cannot be aligned automatically/)).toBeInTheDocument();
 });
 it("treats an empty word token as missing timing, like the server", () => {
  const reviewed = { ...response, transcript: { ...response.transcript, id: "b".repeat(64), reviewedRevision: 3 },
   segments: [{ ...response.segments![0], text: "a b", overlappingSpeech: false, words: [
    { text: "a", startSeconds: 1, endSeconds: 1.4 },
    { text: "", startSeconds: 1.4, endSeconds: 1.5 },
    { text: "b", startSeconds: 1.5, endSeconds: 2 },
   ] }] };
  setup(reviewed);
  expect(screen.getByRole("button", { name: "Align corrected words" })).toBeEnabled();
 });
 it("uses the existing review action for an alignment candidate", async () => {
  const candidate = { ...response, transcript: { ...response.transcript, id: "b".repeat(64), alignment: {
   state: "review_required" as const, timingBasis: "viewing-copy-elapsed" as const, requestId: "a".repeat(64), revision: 3,
  } } };
  const onSave = vi.fn().mockResolvedValue(candidate);
  setup(candidate, onSave);
  expect(screen.getByText(/timing candidate cleared the earlier review record/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "I checked the entire transcript and estimated word timing against the audio" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark transcript and timing reviewed" })); });
  expect(onSave).toHaveBeenCalledWith({ revision: 3, reviewed: true });
 });
 it("cancels an active alignment and keeps an unconfirmed error recoverable", async () => {
  const active = { ...response, transcript: { ...response.transcript, alignment: { state: "processing" as const,
   timingBasis: "viewing-copy-elapsed" as const, requestId: "a".repeat(64), revision: 3 } } };
  const { props } = setup(active);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel word alignment" })); });
  expect(props.onCancelAlignment).toHaveBeenCalledWith("a".repeat(64));
  expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({ transcript: expect.objectContaining({
   alignment: expect.objectContaining({ state: "cancelled" }),
  }) }));
 });
 it("offers an explicit retry when an alignment becomes stale", async () => {
  const stale = { ...response, transcript: { ...response.transcript, id: "b".repeat(64), reviewedRevision: 3,
   alignment: { state: "stale" as const, timingBasis: "viewing-copy-elapsed" as const,
    requestId: "a".repeat(64), revision: 3 } },
   segments: [{ ...response.segments![0], overlappingSpeech: false }] };
  const { props } = setup(stale);
  expect(screen.getByText(/alignment model changed/)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry word alignment" })); });
  expect(props.onAlign).toHaveBeenCalledWith(true);
 });
});
