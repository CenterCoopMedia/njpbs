import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DataHubReportingEditor, type ReportingEditorTransport } from "../src/components/DataHubReportingEditor";
import { emptyDataHubReporting, emptyReportingMapping, type DataHubReporting, type ReportingStory } from "../../packages/content-core/src/data-hub-reporting";
import type { DataHubFigure } from "../../packages/content-core/src/data-hub-reporting";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const now = "2026-10-22T12:00:00Z";
const stories: ReportingStory[] = ["a", "b", "c", "d"].map(id => ({ source: "posts", id, href: `https://njpbs.org/posts/story-${id}/`,
  title: `Published story ${id}`, publishedAt: "2026-10-20T00:00:00Z", tags: ["wages"], categories: [] }));
function fixture({ failure = false, stale = false, disabled = false, empty = false, missingPins = false, retryPending = false, invalidCanonical = false, initiallyHidden = false } = {}) {
  const calls = { preview: 0, terms: 0, vocabulary: 0 };
  // These are the authenticated network boundaries; selection/validation/UI remain real.
  const transport: ReportingEditorTransport = {
    preview: async (mapping, signal) => { calls.preview++; if (retryPending && calls.preview > 1) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); if (failure) throw new Error("network"); return { stories: empty ? [] : invalidCanonical ? stories.map(story => ({ ...story, canonicalHref: "https://www.njspotlightnews.org/video/not-an-approved-story/" })) : stories.filter(story => !mapping.hidden.some(hidden => hidden.source === story.source && hidden.id === story.id)), checkedAt: stale ? null : now, failed: stale, cutoffAt: now }; },
    terms: async () => { calls.terms++; return [{ id: 25890, slug: "minimum-wage", label: "Minimum wage" }]; },
    vocabulary: async () => { calls.vocabulary++; return { tags: ["wages"], categories: ["Business"] }; },
  };
  let latest: DataHubReporting;
  function Editor() {
    const [value, setValue] = useState({ ...emptyDataHubReporting(), figures: { minimumwage: { ...emptyReportingMapping(), posts: { tags: ["wages"], categories: [] }, hidden: initiallyHidden ? [{ source: "posts" as const, id: "a" }] : [], pins: missingPins ? ["missing1", "missing2", "missing3"].map(id => ({ source: "posts" as const, id })) : [] } } });
    latest = value;
    return <DataHubReportingEditor value={value} onChange={next => { latest = next; setValue(next as typeof value); }} transport={transport} disabled={disabled} />;
  }
  render(<Editor />);
  return { calls, value: () => latest! };
}
async function open() { fireEvent.click(screen.getByText("Related reporting")); await screen.findByRole("heading", { name: "Stories that would show" }); }

describe("Data Hub reporting in the Page control", () => {
  it("clears settled and pending Spotlight term searches when the selected section changes", async () => {
    let finish!: (terms: Awaited<ReturnType<ReportingEditorTransport["terms"]>>) => void;
    let signal!: AbortSignal;
    const transport: ReportingEditorTransport = { preview: async () => ({ stories: [], checkedAt: null, failed: false, cutoffAt: now }),
      vocabulary: async () => ({ tags: [], categories: [] }), terms: async (_kind, _query, requestSignal) => {
        signal = requestSignal; return new Promise(resolve => { finish = resolve; });
      } };
    const props = { value: emptyDataHubReporting(), onChange: () => {}, transport };
    const { rerender } = render(<DataHubReportingEditor {...props} selectedFigure="minimumwage" />);
    await open();
    const find = () => {
      fireEvent.change(screen.getByLabelText("Term name"), { target: { value: "wages" } });
      fireEvent.click(screen.getByRole("button", { name: "Find terms" }));
    };
    const terms = [{ id: 25890, slug: "minimum-wage", label: "Minimum wage" }];
    find(); await act(async () => finish(terms));
    expect(screen.getByRole("button", { name: /Minimum wage/ })).toBeInTheDocument();
    rerender(<DataHubReportingEditor {...props} selectedFigure="snap" />);
    expect(screen.queryByRole("button", { name: /Minimum wage/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Term name")).toHaveValue("");
    find(); rerender(<DataHubReportingEditor {...props} selectedFigure="unemployment" />);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(terms));
    expect(screen.queryByRole("button", { name: /Minimum wage/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Terms could not be loaded/)).not.toBeInTheDocument();
  });

  it("returns to an unfinished term after controlled section selection without trapping later selection", async () => {
    const transport: ReportingEditorTransport = { preview: async () => ({ stories: [], checkedAt: null, failed: false, cutoffAt: now }),
      vocabulary: async () => ({ tags: [], categories: [] }), terms: async () => [] };
    function Editor() {
      const [figure, setFigure] = useState<DataHubFigure | "featured">("unemployment");
      const [drafts, setDrafts] = useState<Record<string,string>>({});
      const [reveal, setReveal] = useState(0);
      return <><button onClick={() => setFigure("featured")}>Select Featured section</button>
        <button onClick={() => setReveal(value => value + 1)}>Check reporting</button>
        <DataHubReportingEditor value={emptyDataHubReporting()} onChange={() => {}} transport={transport}
          selectedFigure={figure} drafts={drafts} onDraftsChange={setDrafts} revealRequest={reveal} onRevealFigure={setFigure} /></>;
    }
    render(<Editor />); await open();
    expect(screen.queryByLabelText("Figure")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Post tags" }), { target: { value: "unfinished" } });
    fireEvent.click(screen.getByRole("button", { name: "Select Featured section" }));
    expect(screen.getByRole("combobox", { name: "Post tags" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Check reporting" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Post tags" })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Post tags" })).toHaveValue("unfinished");
    fireEvent.change(screen.getByRole("combobox", { name: "Post tags" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Select Featured section" }));
    expect(screen.getByRole("combobox", { name: "Post tags" })).toBeDisabled();
  });
  it("defers network work until opening and shows the exact three matching stories", async () => {
    const { calls } = fixture(); expect(calls.preview).toBe(0); expect(calls.vocabulary).toBe(0);
    await open(); await screen.findByText("Published story a");
    expect(within(screen.getByRole("region", {name:"Stories that would show"})).getAllByRole("link")).toHaveLength(3);
    expect(screen.getByRole("link", {name:"View current reporting"})).toHaveAttribute("href","https://njpbs.org/data-hub/");
    expect(screen.queryByText("Published story d")).not.toBeInTheDocument();
    expect(screen.getByText(/Last Spotlight check:/)).toBeInTheDocument();
    fireEvent.focus(screen.getByRole("combobox", { name: "Post tags" }));
    await waitFor(() => expect(calls.vocabulary).toBe(1));
    fireEvent.focus(screen.getByRole("combobox", { name: "Post categories" }));
    expect(calls.vocabulary).toBe(1);
  });
  it("hides a story immediately, preserves focus and offers its replacement and undo", async () => {
    const { calls, value } = fixture(); await open(); await screen.findByText("Published story a");
    fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[0]);
    await screen.findByText("Published story d");
    expect(value().figures.minimumwage!.hidden).toEqual([{ source: "posts", id: "a", canonicalHref: "https://njpbs.org/posts/story-a/" }]);
    expect(screen.getByRole("heading", { name: "Stories that would show" })).toHaveFocus();
    expect(calls.preview).toBe(1);
    fireEvent.click(screen.getByText("Hidden stories (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(value().figures.minimumwage!.hidden).toEqual([]);
  });
  it("restores a saved hidden story through a fresh server selection", async () => {
    const { calls, value } = fixture({ initiallyHidden: true }); await open();
    await screen.findByText("Published story d");
    expect(screen.queryByText("Published story a")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Hidden stories (1)"));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    await screen.findByText("Published story a");
    expect(value().figures.minimumwage!.hidden).toEqual([]);
    expect(calls.preview).toBe(2);
  });
  it("finds explicit Spotlight terms and stores their IDs, not free text", async () => {
    const { calls, value } = fixture(); await open();
    fireEvent.change(screen.getByLabelText("Term name"), { target: { value: "minimum wage" } });
    fireEvent.click(screen.getByRole("button", { name: "Find terms" }));
    const add = await screen.findByRole("button", { name: /Minimum wage/ }); fireEvent.click(add);
    expect(calls.terms).toBe(1);
    expect(value().figures.minimumwage!.spotlight.tags).toEqual([{ id: 25890, slug: "minimum-wage", label: "Minimum wage" }]);
  });
  it("keeps inherited Featured controls read-only until staff chooses its own mapping", async () => {
    const { value } = fixture(); await open();
    fireEvent.change(screen.getByLabelText("Figure"), { target: { value: "featured" } });
    const inherit = screen.getByRole("checkbox", { name: /minimum-wage/ }); expect(inherit).toBeChecked();
    expect(screen.getByRole("button", { name: "Find terms" })).toBeDisabled();
    fireEvent.click(inherit); expect(value().featured.inheritFigure).toBe(false);
  });
  it("distinguishes empty, failed and stale source reads", async () => {
    fixture({ empty: true }); await open(); await screen.findByText(/No matching stories/); cleanup();
    fixture({ failure: true }); await open(); await screen.findByText(/Story preview could not be loaded/); cleanup();
    fixture({ stale: true }); await open(); await screen.findByText(/Reporting sources could not all be refreshed/);
    expect(screen.getByText("No successful Spotlight check yet.")).toBeInTheDocument();
  });
  it("rejects presentation markers without locking the rest of the editor", async () => {
    const { value } = fixture(); await open();
    const input = screen.getByRole("combobox", { name: "Post tags" });
    fireEvent.change(input, { target: { value: "format:interactive" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText(/Presentation tags beginning format:/);
    expect(value().figures.minimumwage!.posts.tags).toEqual(["wages"]);
    expect(input).not.toBeDisabled();
  });
  it("retains unfinished terms with their figure across selection and disclosure changes", async () => {
    fixture(); await open();
    fireEvent.change(screen.getByRole("combobox", { name: "Post tags" }), { target: { value: "unfinished term" } });
    await screen.findByText(/Draft terms stay with their figure/);
    fireEvent.change(screen.getByLabelText("Figure"), { target: { value: "snap" } });
    expect(screen.getByRole("combobox", { name: "Post tags" })).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Figure"), { target: { value: "minimumwage" } });
    expect(screen.getByRole("combobox", { name: "Post tags" })).toHaveValue("unfinished term");
    fireEvent.click(screen.getByText("Related reporting")); fireEvent.click(screen.getByText("Related reporting"));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Post tags" })).toHaveValue("unfinished term"));
  });
  it("lets staff remove every saved pin even when its source has withdrawn it", async () => {
    const { value } = fixture({ missingPins: true }); await open();
    await screen.findAllByText("This pinned story is unavailable");
    fireEvent.click(screen.getAllByRole("button", { name: /Remove.*unavailable NJ PBS pin/ })[0]);
    expect(value().figures.minimumwage!.pins).toHaveLength(2);
  });
  it("keeps a settled preview visible after its former network deadline", async () => {
    vi.useFakeTimers(); fixture();
    const details = screen.getByText("Related reporting").closest("details")!;
    await act(async () => { details.open = true; fireEvent(details, new Event("toggle")); });
    expect(screen.getByText("Published story a")).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(21_000); });
    expect(screen.getByText("Published story a")).toBeInTheDocument();
    expect(screen.queryByText(/Story preview could not be loaded/)).not.toBeInTheDocument();
  });
  it("announces loading while a requested retry is pending", async () => {
    fixture({ failure: true, retryPending: true }); await open(); await screen.findByText(/Story preview could not be loaded/);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(screen.getByText("Loading matching stories…")).toBeInTheDocument();
    expect(screen.queryByText(/Story preview could not be loaded/)).not.toBeInTheDocument();
  });
  it("normalizes Pin and Hide when an imported canonical hint is ineligible", async () => {
    const { value } = fixture({ invalidCanonical: true }); await open(); await screen.findByText("Published story a");
    fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[0]);
    expect(value().figures.minimumwage!.hidden).toMatchObject([{ id: "a", canonicalHref: "https://njpbs.org/posts/story-a/" }]);
    expect(screen.queryByText(/Presentation tags beginning format:/)).not.toBeInTheDocument();
  });
  it("honors the parent Page's disabled state", async () => {
    fixture({ disabled: true }); await open();
    expect(screen.getByLabelText("Figure")).toBeDisabled();
  });
});
