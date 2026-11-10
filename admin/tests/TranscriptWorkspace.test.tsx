import type { ReactNode } from "react";
import { MediaFullViewer, type MediaFullViewerItem } from "../src/components/media/MediaFullViewer";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptEditor } from "../src/components/TranscriptEditor";
import { mediaTranscriptFixture } from "../src/dev/fixtures/media-transcript";
import { HttpError } from "../src/lib/functions";
import type { TranscriptResponse } from "../src/lib/video-production";
vi.mock("../src/lib/functions", () => ({ HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } } }));
afterEach(cleanup);

function fixture(count = 120): TranscriptResponse {
  return {
    success: true, cached: true, nextCursor: null,
    transcript: { id: "saved", state: "ready", editRevision: 3, totalSegments: count, speakerIds: ["spk_0", "spk_1"], speakerNames: { spk_0: "Alex", spk_1: "Jordan" } },
    segments: Array.from({ length: count }, (_, index) => ({ index, speaker: `spk_${index % 2}`, startSeconds: index * 30, endSeconds: index * 30 + 10, text: `Passage text ${index + 1}` })),
  };
}
function setup(response = fixture(), overrides = {}, wrap: (editor: ReactNode) => ReactNode = editor => editor) {
  const props = { response, onSave: vi.fn().mockResolvedValue(response),
    onAlign: vi.fn().mockResolvedValue({ state: "queued", timingBasis: "viewing-copy-elapsed" }),
    onCancelAlignment: vi.fn().mockResolvedValue({ state: "cancelled", timingBasis: "viewing-copy-elapsed" }),
    canEdit: true, disabled: false, onSeek: vi.fn(), onSaved: vi.fn(), onReload: vi.fn(), onDirtyChange: vi.fn(), onSavingChange: vi.fn(), onEditingChange: vi.fn(), onSelectPassage: vi.fn(), canSelectPassage: () => true, ...overrides };
  return { ...render(wrap(<TranscriptEditor {...props} />)), props };
}
const passages = () => screen.getByRole("list", { name: "Transcript passages" });
const row = (name: string) => screen.getByRole("listitem", { name: new RegExp(`^${name}:`) });

describe("long transcript workspace", () => {
  it("renders at most 50 rows and returns from a later page to the first passage", () => {
    setup();
    expect(within(passages()).getAllByRole("listitem")).toHaveLength(50);
    expect(screen.queryByText("Passage text 51")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Passage text 51")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to top" }));
    expect(screen.getByText("Passage text 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Transcript" })).toHaveFocus();
  });
  it("searches across loaded pages, filters by speaker, and resets filters without losing content", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "Passage text 119" } });
    expect(screen.getByText("Passage text 119")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by speaker" }), { target: { value: "spk_1" } });
    expect(screen.getByText("No matching loaded passages.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(within(passages()).getAllByRole("listitem")).toHaveLength(50);
  });
  it("navigates to hour-long transcript positions without seeking or requesting data", () => {
    const { props } = setup(fixture(150));
    fireEvent.change(screen.getByRole("textbox", { name: "Jump to time" }), { target: { value: "1:05:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(row("Passage 131")).toHaveFocus();
    expect(props.onSeek).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(props.onReload).not.toHaveBeenCalled();
  });
  it("does not pretend loaded-content search reaches pages not fetched from the server", () => {
    setup({ ...fixture(2), nextCursor: "next", transcript: { ...fixture(2).transcript, totalSegments: 150 } });
    expect(screen.getByText(/Search and navigation cover loaded passages only/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Jump to time" }), { target: { value: "1:05:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("beyond the loaded passages");
  });
  it("opens the clicked speaker, propagates draft names, and saves a revisioned global mapping", async () => {
    const { props } = setup(fixture(4));
    fireEvent.click(within(row("Passage 2")).getByRole("button", { name: "Passage 2 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Jordan (Speaker 2)" }));
    const input = screen.getByRole("textbox", { name: "Speaker 2 name" });
    expect(input).toHaveFocus();
    // Contextual naming must also focus its field when naming mode is already open.
    fireEvent.click(within(row("Passage 2")).getByRole("button", { name: "Passage 2 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Jordan (Speaker 2)" }));
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "New name" } });
    expect(within(row("Passage 2")).getByText("New name")).toBeInTheDocument();
    expect(within(row("Passage 4")).getByText("New name")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Passage 2" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save speaker names" })); });
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, segments: [], speakerNames: { spk_1: "New name" }, speakerRoles: {} });
    expect(screen.getByRole("button", { name: "Rename speakers" })).toHaveFocus();
  });
  it("keeps text corrections from different pages and retains original saved indices", async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "First correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(within(row("Passage 51")).getByRole("button", { name: "Passage 51 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit passage 51" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 51" }), { target: { value: "Later correction" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save transcript" })); });
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: {}, speakerRoles: {}, segments: [
      { index: 0, text: "First correction", speaker: "spk_0" }, { index: 50, text: "Later correction", speaker: "spk_0" },
    ] });
  });
  it("keeps a filtered passage mounted while its wording and speaker are corrected", () => {
    setup(fixture(4));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "Passage text 1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by speaker" }), { target: { value: "spk_0" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    const input = screen.getByRole("textbox", { name: "Passage 1" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Completely different wording" } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Completely different wording");
    fireEvent.change(screen.getByRole("combobox", { name: "Speaker for passage 1" }), { target: { value: "spk_1" } });
    expect(screen.getByRole("textbox", { name: "Passage 1" })).toBe(input);
  });
  it.each(["text", "speakers"])("opens the first visible passage after paging from %s mode without losing drafts", async mode => {
    const { props } = setup(fixture(52));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "Retained first-page draft" } });
    if (mode === "speakers") fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("textbox", { name: "Passage 51" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 51" }), { target: { value: "Second-page draft" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save transcript" })));
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: {}, speakerRoles: {}, segments: [
      { index: 0, speaker: "spk_0", text: "Retained first-page draft" },
      { index: 50, speaker: "spk_0", text: "Second-page draft" },
    ] });
  });
  it.each(["text", "speakers"])("opens the first visible passage after filtering from %s mode without losing drafts", async mode => {
    const { props } = setup(fixture(4));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "Retained hidden draft" } });
    if (mode === "speakers") fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by speaker" }), { target: { value: "spk_1" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "Passage text 4" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("textbox", { name: "Passage 4" })).toHaveFocus();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save transcript" })));
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: {}, speakerRoles: {}, segments: [
      { index: 0, speaker: "spk_0", text: "Retained hidden draft" },
    ] });
  });
  it("selects from saved filter matches when switching from speaker naming to text mode", () => {
    setup(fixture(4));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "Draft wording" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Speaker for passage 1" }), { target: { value: "spk_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by speaker" }), { target: { value: "spk_1" } });
    // Naming mode matches the draft assignment; text mode matches the saved one.
    expect(row("Passage 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("textbox", { name: "Passage 2" })).toHaveFocus();
    expect(screen.queryByRole("listitem", { name: /^Passage 1:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Passage 1 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit passage 1" }));
    expect(screen.getByRole("textbox", { name: "Passage 1" })).toHaveValue("Draft wording");
    expect(screen.getByRole("combobox", { name: "Speaker for passage 1" })).toHaveValue("spk_1");
  });
  it("refocuses a remembered visible passage instead of replacing it with the first row", () => {
    setup(fixture(4));
    fireEvent.click(screen.getByRole("button", { name: "Passage 3 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit passage 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("textbox", { name: "Passage 3" })).toHaveFocus();
  });
  it("keeps focus in the editor when a filter leaves no passage", () => {
    setup(fixture(2));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "No matching text" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("button", { name: "Cancel edits" })).toHaveFocus();
  });
  it.each(["text", "speakers"])("keeps the empty-results focus fallback when re-entering text from %s mode", mode => {
    setup(fixture(2));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    if (mode === "speakers") fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "No matching text" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.queryByRole("textbox", { name: /^Passage / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel edits" })).toHaveFocus();
  });
  it("keeps focus in speaker mode when no numbered speaker exists", () => {
    const emptySpeakers = fixture(0);
    setup({ ...emptySpeakers, transcript: { ...emptySpeakers.transcript, speakerIds: ["unknown"], speakerNames: {} } });
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    expect(screen.getByRole("button", { name: "Cancel edits" })).toHaveFocus();
  });
  it("keeps failed renames recoverable and does not disclose raw provider errors", async () => {
    setup(fixture(2), { onSave: vi.fn().mockRejectedValue(new HttpError(409, "private detail")) });
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Speaker 1 name" }), { target: { value: "Correct name" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save speaker names" })); });
    expect(screen.getByRole("textbox", { name: "Speaker 1 name" })).toHaveValue("Correct name");
    expect(screen.getByRole("button", { name: "Save speaker names" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard edits and reload" })).toBeEnabled();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
  });
  it("retains selection across pages and filters, and hands off one explicitly continuous range", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Select passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 51" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by speaker" }), { target: { value: "spk_1" } });
    const selection = screen.getByRole("region", { name: "Clip selection" });
    expect(selection).toHaveTextContent("2 passages selected · 2 outside this page or filter");
    expect(selection).toHaveTextContent("Continuous range; includes gaps and unselected passages");
    fireEvent.click(screen.getByRole("button", { name: "Use selected range as clip" }));
    expect(props.onSelectPassage).toHaveBeenCalledWith({ speaker: "unknown", text: "", startSeconds: 0, endSeconds: 1510 });
  });
  it("supports shift selection using a captured anchor, including reverse ranges", () => {
    setup(fixture(6));
    fireEvent.click(screen.getByRole("button", { name: "Select passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 4" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 1" }), { shiftKey: true });
    expect(screen.getByRole("region", { name: "Clip selection" })).toHaveTextContent("4 passages selected");
  });
  it("rejects a combined span longer than the export limit even when each passage is valid", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Select passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 70" }));
    expect(screen.getByRole("button", { name: "Use selected range as clip" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("0.25 seconds to 30 minutes");
  });
  it("clears stale selections after a transcript revision changes", () => {
    const view = setup(fixture(4));
    fireEvent.click(screen.getByRole("button", { name: "Select passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 1" }));
    view.rerender(<TranscriptEditor {...view.props} response={{ ...view.props.response, transcript: { ...view.props.response.transcript, editRevision: 4 } }} />);
    expect(screen.getByRole("region", { name: "Clip selection" })).toHaveTextContent("0 passages selected");
  });
  it("does not expose rename or text-edit actions to read-only staff", () => {
    setup(fixture(2), { canEdit: false });
    expect(screen.queryByRole("button", { name: "Rename speakers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit transcript" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Passage 1 actions" }));
    expect(screen.getByRole("menuitem", { name: /Passage details/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit passage 1" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Rename/ })).not.toBeInTheDocument();
  });
  it("opens just one passage editor and retains earlier drafts when another is opened", async () => {
    const { props } = setup(fixture(4));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getAllByRole("textbox", { name: /^Passage / })).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "First retained draft" } });
    fireEvent.click(within(row("Passage 3")).getByRole("button", { name: "Passage 3 actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit passage 3" }));
    expect(screen.getAllByRole("textbox", { name: /^Passage / })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Passage 3" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 3" }), { target: { value: "Second retained draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    expect(screen.queryByRole("textbox", { name: /^Passage / })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Speaker 1 name" }), { target: { value: "Alex renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    expect(screen.getByRole("textbox", { name: "Passage 3" })).toHaveValue("Second retained draft");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save transcript" })));
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: { spk_0: "Alex renamed" }, speakerRoles: {}, segments: [
      { index: 0, speaker: "spk_0", text: "First retained draft" }, { index: 2, speaker: "spk_0", text: "Second retained draft" },
    ] });
  });
  it("keeps 0.18-second fragments separate and seekable while rejecting their standalone clip", () => {
    const value = mediaTranscriptFixture();
    const { props } = setup(value);
    expect(within(passages()).getAllByRole("listitem")).toHaveLength(50);
    const fragment = row("Passage 2");
    expect(within(fragment).getByText("if")).toBeInTheDocument();
    fireEvent.click(within(fragment).getByRole("button", { name: "Seek to 00:00:08.120" }));
    expect(props.onSeek).toHaveBeenCalledWith(8.12);
    fireEvent.click(within(fragment).getByRole("button", { name: "Passage 2 actions" }));
    expect(screen.getByRole("menuitem", { name: /Passage details/ })).toHaveTextContent("00:00:00.180");
    expect(screen.queryByRole("menuitem", { name: "Use passage 2 as clip" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Select passages" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select passage 2" }));
    expect(screen.getByRole("button", { name: "Use selected range as clip" })).toBeDisabled();
    expect(props.onSelectPassage).not.toHaveBeenCalled();
    expect(value.segments![1]).toEqual(expect.objectContaining({ index: 1, text: "if", startSeconds: 8.12, endSeconds: 8.3 }));
  });
  it("opens row menus by keyboard and restores focus on Escape without seeking", () => {
    const { props } = setup(fixture(2));
    const trigger = within(row("Passage 1")).getByRole("button", { name: "Passage 1 actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: /Passage details/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(props.onSeek).not.toHaveBeenCalled();
  });
  it("never groups separate unknown voices under a continuation identity", () => {
    setup(mediaTranscriptFixture());
    expect(row("Passage 8")).toHaveAccessibleName("Passage 8: Unknown speaker");
    expect(row("Passage 9")).toHaveAccessibleName("Passage 9: Unknown speaker");
    expect(within(row("Passage 8")).getByText("Unknown speaker")).toBeInTheDocument();
    expect(within(row("Passage 9")).getByText("Unknown speaker")).toBeInTheDocument();
    expect(within(row("Passage 2")).getByText("↳")).toBeInTheDocument();
    expect(row("Passage 2")).toHaveAccessibleName("Passage 2: Alex Rivera");
  });

  it("keeps portaled passage-menu arrows inside the actual viewer while frame stepping still works", () => {
    const items: MediaFullViewerItem[] = ["previous", "current", "next"].map(id => ({
      ref: { backend: "s3", sourceId: "fixture-source", id }, kind: "video", name: id,
    }));
    const onStep = vi.fn();
    const onClose = vi.fn();
    setup(fixture(2), {}, editor => <MediaFullViewer activeRef={items[1].ref} items={items} onStep={onStep} onClose={onClose}
      renderBody={() => <details open data-viewer-keys="off"><summary>Transcript area</summary>{editor}</details>} />);
    fireEvent.click(screen.getByRole("button", { name: "Passage 1 actions" }));
    const menu = screen.getByRole("menu");
    const dialog = screen.getByRole("dialog");
    expect(menu.closest("dialog")).toBe(dialog);
    expect(menu.closest("details")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Passage details/ }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Passage details/ }), { key: "ArrowRight" });
    expect(onStep).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Passage 1 actions" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(onStep).toHaveBeenCalledWith(items[2]);
  });
  it("names retained passage corrections when saving from speaker mode", async () => {
    const { props } = setup(fixture(2));
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Passage 1" }), { target: { value: "Retained wording correction" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Speaker 1 name" }), { target: { value: "Alex corrected" } });
    expect(screen.queryByRole("button", { name: "Save speaker names" })).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save transcript" })));
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: { spk_0: "Alex corrected" }, speakerRoles: {}, segments: [
      { index: 0, speaker: "spk_0", text: "Retained wording correction" },
    ] });
    expect(screen.getByText("Passage corrections and speaker details saved.")).toBeInTheDocument();
  });

  it("shows a speaker change when filtering hides an intervening different voice", () => {
    setup(fixture(4));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "Alex" } });
    expect(within(passages()).getAllByRole("listitem")).toHaveLength(2);
    expect(within(row("Passage 3")).getByText("Alex")).toBeInTheDocument();
    expect(within(row("Passage 3")).queryByText("↳")).not.toBeInTheDocument();
  });
  it("confirms the actual speaker-only save after switching to passage mode", async () => {
    const { props } = setup(fixture(2));
    fireEvent.click(screen.getByRole("button", { name: "Rename speakers" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Speaker 1 name" }), { target: { value: "Correct speaker" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit transcript" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save transcript" })));
    expect(props.onSave).toHaveBeenCalledWith({ revision: 3, speakerNames: { spk_0: "Correct speaker" }, speakerRoles: {}, segments: [] });
    expect(screen.getByText("Speaker details saved for every passage, including passages not yet loaded.")).toBeInTheDocument();
  });

  it("names a different visible speaker even when its hidden predecessor has the same identity", () => {
    const value = fixture(3);
    value.segments = value.segments!.map((segment, index) => ({ ...segment,
      speaker: index === 0 ? "spk_0" : "spk_1", text: index === 1 ? "Omitted turn" : "Matching turn",
    }));
    setup(value);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search loaded transcript" }), { target: { value: "Matching" } });
    expect(within(passages()).getAllByRole("listitem")).toHaveLength(2);
    expect(within(row("Passage 3")).getByText("Jordan")).toBeInTheDocument();
    expect(within(row("Passage 3")).queryByText("↳")).not.toBeInTheDocument();
  });

});

describe("playback transcript sidebar", () => {
  it("follows playback across loaded pages without moving focus and lets manual reading pause it", () => {
    const { props, rerender } = setup(fixture(120), { pane: true, playbackSeconds: 31 });
    const search = screen.getByRole("searchbox", { name: "Search loaded transcript" });
    search.focus();
    expect(row("Passage 2")).toHaveAttribute("aria-current", "true");
    rerender(<TranscriptEditor {...props} pane playbackSeconds={1501} />);
    expect(row("Passage 51")).toHaveAttribute("aria-current", "true");
    expect(search).toHaveFocus();
    fireEvent.wheel(passages());
    rerender(<TranscriptEditor {...props} pane playbackSeconds={3001} />);
    expect(row("Passage 51")).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /^Passage 101:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Follow playback" }));
    expect(row("Passage 101")).toHaveAttribute("aria-current", "true");
    expect(props.onSeek).not.toHaveBeenCalled();
  });
  it("does not remove a focused passage or override explicit paging", () => {
    const { props, rerender } = setup(fixture(120), { pane: true, playbackSeconds: 1 });
    row("Passage 1").focus();
    rerender(<TranscriptEditor {...props} pane playbackSeconds={1501} />);
    expect(row("Passage 1")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(row("Passage 51")).toBeInTheDocument();
    rerender(<TranscriptEditor {...props} pane playbackSeconds={1} />);
    expect(row("Passage 51")).toBeInTheDocument();
  });
  it("keeps a portaled passage menu mounted when playback crosses a page", async () => {
    const { props, rerender } = setup(fixture(120), { pane: true, playbackSeconds: 1 });
    // A keyboard activation has no pointerdown event. Menu focus leaves the list DOM.
    fireEvent.click(within(row("Passage 1")).getByRole("button", { name: "Passage 1 actions" }));
    const item = await screen.findByRole("menuitem", { name: /^Passage details/ });
    item.focus();
    rerender(<TranscriptEditor {...props} pane playbackSeconds={1501} />);
    expect(item).toHaveFocus();
    expect(row("Passage 1")).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /^Passage 51:/ })).not.toBeInTheDocument();
  });
  it("clears current state during silence and keeps timed threads expandable", () => {
    const comment = { id: "point", authorUid: "a", authorName: "Editor Alex", text: "Check this cut and its full context.", version: 1,
      createdAt: "2026-10-26", updatedAt: "2026-10-26", canEdit: false,
      time: { startFrame: null, endFrame: null, rateNum: null, rateDen: null, startMs: 15000, endMs: 35000, currentVersion: true } };
    const reply = { ...comment, id: "reply", authorName: "Producer Jordan", parentId: "point", text: "Keep the pause.", time: undefined };
    const onOpenComment = vi.fn();
    const { props, rerender, container } = setup(fixture(4), { pane: true, playbackSeconds: 1,
      commentThreads: [{ comment, replies: [reply] }], onOpenComment });
    const summary = screen.getByText("Check this cut and its full context.", { selector: "summary span" }).closest("summary")!;
    fireEvent.click(summary);
    expect(screen.getByRole("list", { name: "Replies to Editor Alex" })).toHaveTextContent("Keep the pause.");
    fireEvent.click(screen.getByRole("button", { name: "Open in Comments" }));
    expect(onOpenComment).toHaveBeenCalledWith(comment);
    rerender(<TranscriptEditor {...props} pane playbackSeconds={20} />);
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(within(passages()).getAllByRole("listitem")[1]).toHaveClass("transcript-comment");
  });
});
