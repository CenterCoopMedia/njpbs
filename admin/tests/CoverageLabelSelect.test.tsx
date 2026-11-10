import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CoverageLabelSelect } from "../src/components/CoverageLabelSelect";
import { CoverageLabelPreviewStatus } from "../src/components/CoverageLabelPreviewStatus";
import { CoverageLabelsProvider, useCoverageLabels } from "../src/context/CoverageLabelsContext";
import { DEFAULT_COVERAGE_LABELS } from "../src/components/CoverageLabelsSettings";
import type { CoverageLabelsBuildData } from "../../packages/content-core/src/coverage-labels";

const registry: CoverageLabelsBuildData = { settingId: "coverage-labels", labels: [DEFAULT_COVERAGE_LABELS.labels[0]!,
  { ...DEFAULT_COVERAGE_LABELS.labels[0]!, id: "past-coverage", name: "Past coverage", retired: true }],
  sourceVersion: 1, publishedAt: "2026-10-29T12:00:00.000Z" };
function Consumer({ enabled = true }: { enabled?: boolean }) { const state = useCoverageLabels(enabled); return <span>{state.status}</span>; }
describe("Published coverage label choices", () => {
  it("does not read for non-consumers, then shares one bounded read across selectors and previews", async () => {
    const load = vi.fn(async () => registry);
    const view = render(<CoverageLabelsProvider load={load}><Consumer enabled={false} /></CoverageLabelsProvider>);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<CoverageLabelsProvider load={load}><Consumer /><CoverageLabelSelect record={{}} id="a" onChange={() => {}} /><CoverageLabelSelect record={{}} id="b" onChange={() => {}} /></CoverageLabelsProvider>);
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toBeEnabled());
    view.rerender(<CoverageLabelsProvider load={load}><Consumer /><CoverageLabelSelect record={{}} id="a" onChange={() => {}} /></CoverageLabelsProvider>);
    expect(load).toHaveBeenCalledOnce();
  });
  it("hides retired choices from new Posts but retains and previews the current retired label", async () => {
    const load = async () => registry;
    const view = render(<CoverageLabelsProvider load={load}><CoverageLabelSelect record={{}} id="a" onChange={() => {}} /></CoverageLabelsProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(screen.queryByRole("option", { name: /Past coverage/ })).not.toBeInTheDocument();
    view.rerender(<CoverageLabelsProvider load={load}><CoverageLabelSelect record={{ coverageLabelId: "past-coverage" }} id="a" onChange={() => {}} /></CoverageLabelsProvider>);
    expect(screen.getByRole("option", { name: "Past coverage (retired)" })).toBeVisible();
    expect(screen.getByLabelText("Coverage label preview")).toHaveTextContent("Past coverage");
  });
  it("derives the legacy live-blog choice and emits None without an invented id", async () => {
    const onChange = vi.fn();
    render(<CoverageLabelsProvider load={async () => registry}><CoverageLabelSelect record={{ liveBlog: { branding: "nj-decides-2026" } }} id="a" onChange={onChange} /></CoverageLabelsProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(screen.getByRole("combobox")).toHaveValue("nj-decides-2026");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
  it("keeps unknown assignments visible without manufacturing a pill and respects a read lock", async () => {
    render(<CoverageLabelsProvider load={async () => registry}><CoverageLabelSelect record={{ coverageLabelId: "missing" }} id="a" disabled onChange={() => {}} /></CoverageLabelsProvider>);
    await screen.findByRole("option", { name: "NJ Decides 2026" });
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveValue("missing");
    expect(screen.queryByLabelText("Coverage label preview")).not.toBeInTheDocument();
  });
  it("refuses stale loader responses and retries a failed published read", async () => {
    let resolve!: (value: CoverageLabelsBuildData) => void;
    const old = vi.fn(() => new Promise<CoverageLabelsBuildData>(done => { resolve = done; }));
    const fresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(registry);
    const view = render(<CoverageLabelsProvider load={old}><CoverageLabelSelect record={{}} id="a" onChange={() => {}} /></CoverageLabelsProvider>);
    view.rerender(<CoverageLabelsProvider load={fresh}><CoverageLabelSelect record={{}} id="a" onChange={() => {}} /></CoverageLabelsProvider>);
    await screen.findByRole("button", { name: "Retry coverage labels" });
    await act(async () => resolve(registry));
    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry coverage labels" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(fresh).toHaveBeenCalledTimes(2);
  });
  it("explains a saved artwork mismatch without rewriting it", async () => {
    const onChange = vi.fn(), record = { coverageLabelId: "past-coverage", liveBlog: { branding: "nj-decides-2026" } };
    render(<CoverageLabelsProvider load={async () => registry}><CoverageLabelSelect record={record} id="a" onChange={onChange} /></CoverageLabelsProvider>);
    expect(await screen.findByText(/saved coverage label and live-blog artwork differ/)).toBeVisible();
    expect(record.liveBlog.branding).toBe("nj-decides-2026");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("announces incomplete Home label previews and exposes a shared retry", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(registry);
    render(<CoverageLabelsProvider load={load}><Consumer /><CoverageLabelPreviewStatus /></CoverageLabelsProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Retry coverage labels" }));
    await waitFor(() => expect(screen.queryByText(/unavailable in this layout preview/)).not.toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });
});
