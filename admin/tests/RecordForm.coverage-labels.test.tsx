import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordForm, type RecordSaveReceipt } from "../src/components/RecordForm";
import { CoverageLabelsProvider } from "../src/context/CoverageLabelsContext";
import { DEFAULT_COVERAGE_LABELS } from "../src/components/CoverageLabelsSettings";
import type { CoverageLabelsBuildData } from "../../packages/content-core/src/coverage-labels";

const registry: CoverageLabelsBuildData = { settingId: "coverage-labels", labels: [DEFAULT_COVERAGE_LABELS.labels[0]!,
  { ...DEFAULT_COVERAGE_LABELS.labels[0]!, id: "statehouse", name: "Statehouse Watch" }],
  sourceVersion: 1, publishedAt: "2026-10-29T12:00:00.000Z" };
const load = async () => registry;
const blog = { schemaVersion: 1, coverageState: "ongoing", branding: "nj-decides-2026", updates: [] };
function setup(initial: Record<string, unknown> = {}, readonly = false) {
  const onSave = vi.fn(async (record: Record<string, unknown>): Promise<RecordSaveReceipt> => {
    const document: Record<string, unknown> = { ...record, id: "label-post", version: 2 };
    if (document.coverageLabelId === null) delete document.coverageLabelId;
    return { kind: "record-save-receipt", document, mintedIds: {} };
  });
  const onDraftChange = vi.fn();
  render(<CoverageLabelsProvider load={load}><RecordForm kind="post" initial={{ title: "Coverage headline", blocks: [], ...initial }}
    onSave={onSave} onDraftChange={onDraftChange} canSave allowIncomplete readOnly={readonly} /></CoverageLabelsProvider>);
  return { onSave, onDraftChange };
}
describe("Post coverage assignment", () => {
  it("leaves new Posts unassigned and saves a chosen published label with a title preview", async () => {
    const { onSave, onDraftChange } = setup();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Coverage label" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Unassigned coverage" } });
    expect(onDraftChange.mock.calls.at(-1)?.[0]).not.toHaveProperty("coverageLabelId");
    fireEvent.change(screen.getByRole("combobox", { name: "Coverage label" }), { target: { value: "statehouse" } });
    expect(document.querySelector(".post-editor-title-fields")).toHaveTextContent("Statehouse Watch");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ coverageLabelId: "statehouse" });
  });
  it("sends an explicit clear and adopts the server removal without resending it", async () => {
    const { onSave } = setup({ coverageLabelId: "nj-decides-2026" });
    const choice = screen.getByRole("combobox", { name: "Coverage label" });
    await waitFor(() => expect(choice).toBeEnabled());
    fireEvent.change(choice, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].coverageLabelId).toBeNull();
    await screen.findByText("Saved.");
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), { target: { value: "Another edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0]).not.toHaveProperty("coverageLabelId");
  });
  it("replaces live-blog branding with one synchronized coverage choice", async () => {
    const { onSave, onDraftChange } = setup({ liveBlog: blog });
    const choice = screen.getByRole("combobox", { name: "Coverage label" });
    await waitFor(() => expect(choice).toBeEnabled());
    expect(screen.queryByRole("combobox", { name: "Coverage branding" })).not.toBeInTheDocument();
    expect(choice).toHaveValue("nj-decides-2026");
    fireEvent.change(choice, { target: { value: "statehouse" } });
    expect(onDraftChange.mock.calls.at(-1)?.[0]).toMatchObject({ coverageLabelId: "statehouse" });
    expect(onDraftChange.mock.calls.at(-1)?.[0].liveBlog).not.toHaveProperty("branding");
    fireEvent.change(choice, { target: { value: "nj-decides-2026" } });
    expect(onDraftChange.mock.calls.at(-1)?.[0].liveBlog).toMatchObject({ branding: "nj-decides-2026" });
    fireEvent.change(choice, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].coverageLabelId).toBeNull();
    expect(onSave.mock.calls[0]![0].liveBlog).not.toHaveProperty("branding");
  });
  it.each(["nj-decides-2026", "statehouse", undefined])("starts a live blog with artwork matching the Post label %s", async coverageLabelId => {
    const { onSave } = setup(coverageLabelId ? { coverageLabelId } : {});
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Coverage label" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    expect(screen.queryByText(/saved coverage label and live-blog artwork differ/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const created = onSave.mock.calls[0]![0].liveBlog;
    if (coverageLabelId === "nj-decides-2026") expect(created).toMatchObject({ branding: "nj-decides-2026" });
    else expect(created).not.toHaveProperty("branding");
  });
  it("locks assignment with the record and preserves the old blog control without a new backend", async () => {
    setup({ coverageLabelId: "statehouse" }, true);
    await screen.findByRole("option", { name: "Statehouse Watch" });
    expect(screen.getByRole("combobox", { name: "Coverage label" })).toBeDisabled();
  });
  it("retains legacy blog editing when published label reads are unavailable", () => {
    render(<RecordForm kind="post" initial={{ title: "Legacy coverage", blocks: [], liveBlog: blog }} onSave={() => {}} canSave allowIncomplete />);
    expect(screen.getByRole("combobox", { name: "Coverage branding" })).toHaveValue("nj-decides-2026");
    expect(screen.queryByRole("combobox", { name: "Coverage label" })).not.toBeInTheDocument();
  });
  it.each([false, true])("keeps election artwork available before labels are published (existing blog: %s)", async existing => {
    const onSave = vi.fn();
    render(<CoverageLabelsProvider load={async () => undefined}><RecordForm kind="post"
      initial={{ title: "Pre-publication coverage", blocks: [], ...(existing ? { liveBlog: blog } : {}) }}
      onSave={onSave} canSave allowIncomplete /></CoverageLabelsProvider>);
    if (!existing) fireEvent.click(screen.getByRole("button", { name: "Start live blog draft" }));
    const artwork = await screen.findByRole("combobox", { name: "Coverage branding" });
    expect(screen.getByText(/No coverage labels are published yet/)).toBeVisible();
    fireEvent.change(artwork, { target: { value: "general" } });
    fireEvent.change(artwork, { target: { value: "nj-decides-2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].liveBlog).toMatchObject({ branding: "nj-decides-2026" });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty("coverageLabelId");
  });
  it("honors an explicitly published empty registry without restoring retired choices", async () => {
    render(<CoverageLabelsProvider load={async () => ({ ...registry, labels: [] })}><RecordForm kind="post"
      initial={{ title: "Published choices", blocks: [], liveBlog: { ...blog, branding: undefined } }}
      onSave={() => {}} canSave allowIncomplete /></CoverageLabelsProvider>);
    const choice = screen.getByRole("combobox", { name: "Coverage label" });
    await waitFor(() => expect(choice).toBeEnabled());
    expect(screen.queryByRole("combobox", { name: "Coverage branding" })).not.toBeInTheDocument();
    expect(choice).not.toHaveTextContent("NJ Decides 2026");
  });
  it("keeps the unified error and retry visible after a transient live-blog read failure", async () => {
    const retryLoad = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(registry);
    render(<CoverageLabelsProvider load={retryLoad}><RecordForm kind="post" initial={{ title: "Coverage", blocks: [], liveBlog: blog }} onSave={() => {}} canSave allowIncomplete /></CoverageLabelsProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Retry coverage labels" }));
    expect(screen.queryByRole("combobox", { name: "Coverage branding" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Coverage label" })).toBeEnabled());
    expect(retryLoad).toHaveBeenCalledTimes(2);
  });
  it("uses the old live-blog control when the endpoint is absent", async () => {
    render(<CoverageLabelsProvider load={async () => { throw { status: 404 }; }}><RecordForm kind="post" initial={{ title: "Coverage", blocks: [], liveBlog: blog }} onSave={() => {}} canSave allowIncomplete /></CoverageLabelsProvider>);
    expect(await screen.findByRole("combobox", { name: "Coverage branding" })).toHaveValue("nj-decides-2026");
    expect(screen.queryByRole("combobox", { name: "Coverage label" })).not.toBeInTheDocument();
  });
});
