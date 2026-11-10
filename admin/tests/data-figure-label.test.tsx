import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { InlineDataFigure } from "../src/components/InlineDataFigure";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { outlineSummary } from "../src/lib/content-outline";
import type { AdminBlock } from "../src/lib/block-factory";
import type { DatasetPublicProjection } from "../../packages/content-core/src/data-figure";

const { figure, getIdToken } = vi.hoisted(() => ({ figure: vi.fn(), getIdToken: async () => "fixture-token" }));
vi.mock("../src/lib/datasets", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/datasets")>(), datasetApi: () => ({ figure }),
}));
vi.mock("../src/routes/ShellContext", async importOriginal => ({
  ...await importOriginal<typeof import("../src/routes/ShellContext")>(), useOptionalShell: () => ({ getIdToken }),
}));
const id = "5304fee0598a1cf13c76c8c173e148e5";
const title = "New Jersey minimum hourly wage";
const block: AdminBlock = { id: "wage-figure", type: "data_figure", order: 0, visible: true,
  data: { datasetId: id, version: { mode: "pinned", releaseId: "wage-2026" }, display: "expanded" } };
const projection: DatasetPublicProjection = {
  datasetId: id, releaseId: "wage-2026", revision: 1, digest: "a".repeat(64), approvedAt: "2026-10-20T14:00:00.000Z",
  release: { label: title, unit: "usd_hour", value: 15.92,
    period: { start: "2026-01-01", end: "2026-12-31", label: "2026" },
    geography: { level: "state", code: "NJ", label: "New Jersey" }, adjustment: "not_applicable",
    points: [{ period: "2020-01-01", value: 11 }, { period: "2026-01-01", value: 15.92 }],
    chartText: "The annual rate rises from $11 to $15.92 per hour.", methodNote: "Synthetic annual fixture.", comparators: [],
    source: { publisher: "Example labor agency", title: "Wages", url: "https://example.test/wages" },
    releasedOn: "2026-10-15", verifiedOn: "2026-10-16", changeKind: "new_release", changeNote: "",
    reuse: { display: "allowed", exports: "denied", note: "" } },
};
beforeEach(() => { figure.mockReset().mockResolvedValue(structuredClone(projection)); });
afterEach(cleanup);

it.each(["page", "post"] as const)("names the %s card, edit control and actions with the approved dataset title", async kind => {
  const { container } = render(<EditorWorkspaceViewProvider kind={kind}>
    <BlockEditor section="post" initialBlocks={[structuredClone(block)]} allowIncomplete />
  </EditorWorkspaceViewProvider>);
  const edit = screen.getByRole("button", { name: "Edit Data figure 1" });
  fireEvent.click(edit);
  await screen.findByRole("button", { name: `Edit ${title} 1` });
  expect(screen.getByRole("button", { name: `${title} 1 actions` })).toBeInTheDocument();
  expect(container.querySelector(".block-card-kind")).toHaveTextContent(title);
  expect(container.querySelector(".block-preview")).toHaveTextContent(title);
  expect(container.textContent).not.toContain(id);
  expect(figure).toHaveBeenCalledTimes(1);
});

it.each(["page", "post"] as const)("keeps the empty %s figure's controls named for the figure", kind => {
  const empty = { ...structuredClone(block), data: { datasetId: "", version: { mode: "pinned", releaseId: "" }, display: "expanded" } };
  const { container } = render(<EditorWorkspaceViewProvider kind={kind}>
    <BlockEditor section="post" initialBlocks={[empty]} allowIncomplete />
  </EditorWorkspaceViewProvider>);
  expect(screen.getByRole("button", { name: "Edit Data figure 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Data figure 1 actions" })).toBeInTheDocument();
  expect(container.querySelector(".block-card-kind")).toHaveTextContent("Data figure");
  expect(screen.queryByRole("button", { name: /Edit Choose/ })).not.toBeInTheDocument();
  expect(figure).not.toHaveBeenCalled();
});

it("distinguishes repeated figures before and after their dataset titles load", async () => {
  render(<EditorWorkspaceViewProvider kind="post">
    <BlockEditor section="post" initialBlocks={[structuredClone(block), { ...structuredClone(block), id: "another-wage-figure", order: 1 }]} allowIncomplete />
  </EditorWorkspaceViewProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Edit Data figure 2" }));
  await screen.findByRole("button", { name: `Edit ${title} 2` });
  fireEvent.click(screen.getByRole("button", { name: "Edit Data figure 1" }));
  await screen.findByRole("button", { name: `Edit ${title} 1` });
  expect(screen.getByRole("button", { name: `${title} 1 actions` })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${title} 2 actions` })).toBeInTheDocument();
  expect(figure).toHaveBeenCalledTimes(2);
});

it("clears the title for changed or mismatched releases without changing saved block data", async () => {
  const onResolvedLabel = vi.fn();
  const onChange = vi.fn();
  const view = (value: AdminBlock) => <InlineDataFigure block={value} onChange={onChange} onResolvedLabel={onResolvedLabel} />;
  const rendered = render(view(block));
  await waitFor(() => expect(onResolvedLabel).toHaveBeenLastCalledWith(title));
  let resolve!: (value: DatasetPublicProjection) => void;
  figure.mockReturnValueOnce(new Promise<DatasetPublicProjection>(done => { resolve = done; }));
  const next = { ...block, data: { ...block.data, version: { mode: "pinned", releaseId: "wage-2025" } } };
  rendered.rerender(view(next));
  await waitFor(() => expect(onResolvedLabel).toHaveBeenLastCalledWith(null));
  expect(screen.queryByText(title)).not.toBeInTheDocument();
  await act(async () => resolve(projection)); // Old release must not name a new selection.
  expect(onResolvedLabel).toHaveBeenLastCalledWith(null);
  expect(await screen.findByRole("alert")).toHaveTextContent("did not match");
  expect(onChange).not.toHaveBeenCalled();
  expect(block.data).toEqual({ datasetId: id, version: { mode: "pinned", releaseId: "wage-2026" }, display: "expanded" });
});

it("keeps opaque pointers out of unresolved outline summaries", () => {
  expect(outlineSummary(block)).toBe("Data figure");
  expect(outlineSummary({ ...block, data: { ...block.data, datasetId: "" } })).toBe("Choose an approved dataset");
});
