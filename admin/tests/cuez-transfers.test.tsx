import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { CuezTransferWorkspace } from "../src/components/cuez-transfer-workspace";
import { createCuezFixtureApi } from "../src/dev/cuez-fixtures";
import { canUseCuez } from "../src/lib/cuez-access";
import { eligibleNavDestinations } from "../src/lib/nav-destinations";
import type { CuezApi, CuezOperation, CuezOperationPage } from "../src/lib/cuez-transfers";

afterEach(cleanup);
function mount(api: CuezApi = createCuezFixtureApi()) {
  render(<MemoryRouter><CuezTransferWorkspace api={api} /></MemoryRouter>);
  return api;
}
async function chooseFirst() {
  const radio = await screen.findByRole("radio", { name: /Community reporting in New Jersey/ });
  fireEvent.click(radio);
}
function transferPage(operations: CuezOperation[], nextCursor: string | null,
  boundary: CuezOperationPage["boundary"] = operations.at(-1) ?? null): CuezOperationPage {
  return { operations, nextCursor, boundary };
}
describe("StoryDesk staff workflow", () => {
  it.each(["clip", "transcript"] as const)("loads later %s output pages after an empty first page", async kind => {
    const api = createCuezFixtureApi(), resources = api.resources;
    const load = vi.spyOn(api, "resources").mockImplementation(async (requestedKind, assetId, cursor) => {
      if (!assetId) return resources(requestedKind, assetId, cursor);
      if (!cursor) return { items: [], nextCursor: "first-page" };
      return { items: [{ resource: { kind, id: assetId, jobId: cursor === "first-page" ? "a".repeat(64) : "b".repeat(64) },
        label: cursor === "first-page" ? "First ready output" : "Later ready output", detail: "Ready" }],
      nextCursor: cursor === "first-page" ? "second-page" : null };
    });
    const prepare = vi.spyOn(api, "prepare");
    mount(api);
    fireEvent.change(await screen.findByLabelText("Send a"), { target: { value: kind } });
    await chooseFirst();
    fireEvent.click(await screen.findByRole("button", { name: "More outputs" }));
    await screen.findByRole("option", { name: /First ready output/ });
    const output = screen.getByLabelText(kind === "clip" ? "Ready clip" : "Cached transcript");
    fireEvent.change(output, { target: { value: "a".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "More outputs" }));
    await screen.findByRole("option", { name: /Later ready output/ });
    expect(output).toHaveValue("a".repeat(64));
    expect(screen.getByRole("option", { name: /First ready output/ })).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(kind, "sample-item-1", "second-page");
    expect(screen.queryByRole("button", { name: "More outputs" })).not.toBeInTheDocument();
    fireEvent.change(output, { target: { value: "b".repeat(64) } });
    fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
    await screen.findByRole("button", { name: "Send to StoryDesk" });
    expect(prepare).toHaveBeenCalledWith({ kind, id: "sample-item-1", jobId: "b".repeat(64) }, { kind: "new-story" });
  });
  it("keeps preparation busy across tab loads and discards the abandoned response", async () => {
    const api = createCuezFixtureApi();
    const first = await api.prepare({ kind: "video", id: "sample-item-1" }, { kind: "new-story" });
    let resolve!: (value: typeof first) => void;
    const prepare = vi.spyOn(api, "prepare").mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const send = vi.spyOn(api, "send");
    mount(api); await chooseFirst();
    fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
    await screen.findByRole("status", { name: "Checking the selected version" });
    fireEvent.click(screen.getByRole("tab", { name: "Import" }));
    fireEvent.click(screen.getByRole("tab", { name: "Send" }));
    await act(async () => {});
    expect(screen.getByRole("radio", { name: /Statehouse interview/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review transfer" })).toBeDisabled();
    await act(async () => { resolve(first); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Review transfer" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Send to StoryDesk" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Statehouse interview/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to StoryDesk" }));
    await screen.findByText("The transfer is done.");
    expect(prepare).toHaveBeenLastCalledWith({ kind: "video", id: "sample-item-2" }, { kind: "new-story" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalledWith(first.operation.operationId);
  });
  it("offers the destination only to staff who can use media or content", () => {
    const editor = { id: "editor", grants: [{ role: "editor" as const }] };
    const none = { id: "no-grants", grants: [] };
    expect(canUseCuez(editor)).toBe(true);
    expect(eligibleNavDestinations(editor).map(item => item.id)).toContain("cuez-storydesk");
    expect(canUseCuez(none)).toBe(false);
    expect(eligibleNavDestinations(none).map(item => item.id)).not.toContain("cuez-storydesk");
  });
  it("shows off state and makes no list or transfer requests until enabled", async () => {
    const api = createCuezFixtureApi("off");
    const resources = vi.spyOn(api, "resources"), send = vi.spyOn(api, "send"), status = vi.spyOn(api, "status");
    mount(api);
    expect(await screen.findByRole("heading", { name: "Transfers are turned off" })).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(resources).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh StoryDesk availability" }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });
  it("requires a selected item and separate review before an explicit send", async () => {
    const api = createCuezFixtureApi(), send = vi.spyOn(api, "send");
    mount(api);
    await screen.findByRole("tab", { name: "Send" });
    expect(screen.getByRole("button", { name: "Review transfer" })).toBeDisabled();
    await chooseFirst();
    fireEvent.click(screen.getByRole("button", { name: "Review transfer" }));
    const confirm = await screen.findByRole("button", { name: "Send to StoryDesk" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(await screen.findByText("The transfer is done.")).toBeVisible();
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "Transfers" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Your transfers" })).toHaveFocus();
  });
  it("requires an explicit cached output selection for clips", async () => {
    mount();
    const kind = await screen.findByLabelText("Send a");
    fireEvent.change(kind, { target: { value: "clip" } });
    await chooseFirst();
    const clip = await screen.findByLabelText("Ready clip");
    await screen.findByRole("option", { name: /Clip 5–12 seconds/ });
    expect(screen.getByRole("button", { name: "Review transfer" })).toBeDisabled();
    fireEvent.change(clip, { target: { value: "a".repeat(64) } });
    expect(screen.getByRole("button", { name: "Review transfer" })).toBeEnabled();
  });
  it("previews separate documents and omissions before confirming a private draft", async () => {
    const api = createCuezFixtureApi(), confirm = vi.spyOn(api, "confirm");
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Import" }));
    const panel = screen.getByRole("tabpanel", { name: "Import" });
    fireEvent.click(within(panel).getByRole("button", { name: /^Search$/ }));
    fireEvent.click(await within(panel).findByRole("button", { name: /Preview import/ }));
    const button = await within(panel).findByRole("button", { name: "Confirm private draft import" });
    expect(button).toBeDisabled(); expect(confirm).not.toHaveBeenCalled();
    expect(within(panel).getByRole("heading", { name: "Brief" })).toBeVisible();
    expect(within(panel).getByRole("heading", { name: "Interview notes" })).toBeVisible();
    fireEvent.click(within(panel).getByLabelText("I reviewed these omissions."));
    fireEvent.click(button);
    await screen.findByText("The private draft is ready to review.");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("link", { name: "Open private draft" }).every(link => link.getAttribute("href") === "/content/post/sample-private-draft/edit")).toBe(true);
  });
  it("explains the description limit without blocking existing-story selection", async () => {
    const api = createCuezFixtureApi();
    vi.spyOn(api, "stories").mockImplementation(async (_search, page) => ({ stories: [{ id: "long-story", title: "Long source story",
      description: "", descriptionTooLong: true, link: "https://storydesk.example.test/long-story" }], page, totalPages: 1 }));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Import" }));
    const importPanel = screen.getByRole("tabpanel", { name: "Import" });
    fireEvent.click(within(importPanel).getByRole("button", { name: /^Search$/ }));
    expect(await within(importPanel).findByText(/longer than Boardwalk's 10,000-character import limit/)).toBeVisible();
    expect(within(importPanel).getByRole("button", { name: /Preview import: Long source story/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("tab", { name: "Send" }));
    await chooseFirst();
    fireEvent.click(screen.getByLabelText("Existing story"));
    const sendPanel = screen.getByRole("tabpanel", { name: "Send" });
    fireEvent.click(within(sendPanel).getByRole("button", { name: /^Search$/ }));
    const select = await within(sendPanel).findByRole("button", { name: /Select story: Long source story/ });
    expect(select).toBeEnabled();
    fireEvent.click(select);
    expect(within(sendPanel).getByRole("link", { name: "Long source story" })).toBeVisible();
  });
  it("loads older transfers and keeps them after the newest page refreshes", async () => {
    const api = createCuezFixtureApi();
    const newest = await api.operations();
    newest.operations[0] = { ...newest.operations[0], label: "Access removed transfer", updatedAt: "2026-10-30T17:00:00Z" };
    const older: CuezOperation = { ...newest.operations[0], operationId: "a".repeat(64), label: "Older needs-review transfer",
      state: "reconciliation", errorCode: "outcome_unknown", message: "The result needs review. Check StoryDesk before taking another action.",
      updatedAt: "2026-10-28T17:00:00Z" };
    let newestPage = newest.operations;
    const operations = vi.spyOn(api, "operations").mockImplementation(async cursor => cursor
      ? transferPage([older], null)
      : transferPage(newestPage, "b".repeat(64)));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    expect(await screen.findByText("Access removed transfer")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "More transfers" }));
    expect(await screen.findByText("Older needs-review transfer")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your transfers" })).toHaveFocus());
    newestPage = newest.operations.slice(1);
    const calls = operations.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh transfer status" }));
    await waitFor(() => expect(operations).toHaveBeenCalledTimes(calls + 1));
    expect(operations).toHaveBeenLastCalledWith(undefined);
    await waitFor(() => expect(screen.queryByText("Access removed transfer")).not.toBeInTheDocument());
    expect(screen.getByText("Older needs-review transfer")).toBeVisible();
    expect(operations).toHaveBeenCalledWith("b".repeat(64));
  });
  it("clears a failed older-page alert when retry succeeds", async () => {
    const api = createCuezFixtureApi();
    const newest = await api.operations();
    const older = { ...newest.operations[0], operationId: "a".repeat(64), label: "Recovered older transfer" };
    let attempts = 0;
    vi.spyOn(api, "operations").mockImplementation(async cursor => {
      if (!cursor) return transferPage(newest.operations, "b".repeat(64));
      if (attempts++ === 0) throw new Error("Older transfers could not load.");
      return transferPage([older], null);
    });
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    fireEvent.click(await screen.findByRole("button", { name: "More transfers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Older transfers could not load.");
    fireEvent.click(screen.getByRole("button", { name: "More transfers" }));
    expect(await screen.findByText("Recovered older transfer")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
  it("keeps an authorized transfer that new work displaces from the newest page", async () => {
    const api = createCuezFixtureApi();
    const newest = await api.operations();
    const displaced = { ...newest.operations.at(-1)!, label: "Displaced needs-review transfer", updatedAt: "2026-10-28T17:00:00Z" };
    newest.operations[newest.operations.length - 1] = displaced;
    let newestPage = newest.operations;
    vi.spyOn(api, "operations").mockImplementation(async () => transferPage(newestPage, newestPage.at(-1)!.operationId));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    expect(await screen.findByText("Displaced needs-review transfer")).toBeVisible();
    const added = { ...newest.operations[0], operationId: "c".repeat(64), label: "Newest transfer", updatedAt: "2026-11-06T20:00:00Z" };
    newestPage = [added, ...newest.operations.slice(0, -1)];
    fireEvent.click(screen.getByRole("button", { name: "Refresh transfer status" }));
    expect(await screen.findByText("Newest transfer")).toBeVisible();
    expect(screen.getByText("Displaced needs-review transfer")).toBeVisible();
  });
  it("removes a filtered cursor row from the newest page", async () => {
    const api = createCuezFixtureApi();
    const newest = await api.operations();
    const filtered = { ...newest.operations.at(-1)!, label: "Filtered cursor transfer" };
    newest.operations[newest.operations.length - 1] = filtered;
    let newestPage = newest.operations;
    vi.spyOn(api, "operations").mockImplementation(async () => transferPage(newestPage, filtered.operationId, filtered));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    expect(await screen.findByText("Filtered cursor transfer")).toBeVisible();
    newestPage = newest.operations.slice(0, -1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh transfer status" }));
    await waitFor(() => expect(screen.queryByText("Filtered cursor transfer")).not.toBeInTheDocument());
  });
  it("uses the refreshed cursor timestamp when it preserves displaced rows", async () => {
    const api = createCuezFixtureApi();
    const newest = await api.operations();
    const displaced = { ...newest.operations[0], operationId: "d".repeat(64), label: "Authorized displaced transfer", updatedAt: "2026-11-06T19:15:00Z" };
    const cursor = { ...newest.operations[1], operationId: "e".repeat(64), label: "Updated cursor transfer", updatedAt: "2026-11-06T19:10:00Z" };
    let newestPage = [displaced, cursor];
    vi.spyOn(api, "operations").mockImplementation(async () => transferPage(newestPage, cursor.operationId));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    expect(await screen.findByText("Authorized displaced transfer")).toBeVisible();
    newestPage = [{ ...newest.operations[2], operationId: "f".repeat(64), label: "New work", updatedAt: "2026-11-06T19:21:00Z" },
      { ...cursor, updatedAt: "2026-11-06T19:20:00Z" }];
    fireEvent.click(screen.getByRole("button", { name: "Refresh transfer status" }));
    expect(await screen.findByText("New work")).toBeVisible();
    expect(screen.getByText("Authorized displaced transfer")).toBeVisible();
  });
  it("focuses the heading when a gap rejoins fully loaded history", async () => {
    const api = createCuezFixtureApi();
    const sample = (await api.operations()).operations[0];
    const row = (id: string, updatedAt: string) => ({ ...sample, operationId: id, label: id, state: "complete" as const, updatedAt });
    const old = row("Loaded history", "2026-10-28T17:00:00Z");
    const newest = row("New burst", "2026-10-30T17:00:00Z");
    vi.spyOn(api, "operations").mockResolvedValueOnce(transferPage([old], null))
      .mockResolvedValueOnce(transferPage([newest], "gap"))
      .mockResolvedValueOnce(transferPage([old], "unused-deeper-cursor"));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    await screen.findByText("Loaded history");
    fireEvent.click(screen.getByRole("button", { name: "Refresh transfer status" }));
    await screen.findByText("New burst");
    const more = screen.getByRole("button", { name: "More transfers" });
    more.focus(); fireEvent.click(more);
    await waitFor(() => expect(screen.queryByRole("button", { name: "More transfers" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Your transfers" })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Send" }));
    const transfersTab = screen.getByRole("tab", { name: "Transfers" });
    transfersTab.focus(); fireEvent.click(transfersTab);
    await act(async () => {});
    expect(transfersTab).toHaveFocus();
  });
  it("shows an error when an older-page cursor repeats", async () => {
    const api = createCuezFixtureApi();
    const sample = (await api.operations()).operations[0];
    vi.spyOn(api, "operations").mockResolvedValue(transferPage([sample], "repeated"));
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    fireEvent.click(await screen.findByRole("button", { name: "More transfers" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Older transfers could not advance");
    expect(screen.getByRole("button", { name: "More transfers" })).toBeEnabled();
  });
  it("keeps polling from overlapping history or clearing a refused action alert", async () => {
    const api = createCuezFixtureApi();
    const sample = (await api.operations()).operations[1];
    let finish!: (page: CuezOperationPage) => void;
    const retryable = { ...sample, operationId: "b".repeat(64), state: "failed" as const, canRetry: true };
    vi.spyOn(api, "retry").mockRejectedValue(new Error("The retry was refused. Refresh and review the result."));
    const operations = vi.spyOn(api, "operations").mockResolvedValueOnce(transferPage([sample, retryable], "history"))
      .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.useFakeTimers();
    try {
      await act(async () => { mount(api); });
      await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Transfers" })); });
      fireEvent.click(screen.getByRole("button", { name: "More transfers" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(operations).toHaveBeenCalledTimes(2);
      await act(async () => { finish(transferPage([], "next-history")); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry transfer" })); });
      expect(screen.getByRole("alert")).toHaveTextContent("The retry was refused");
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(operations).toHaveBeenCalledTimes(3);
      const more = screen.getByRole("button", { name: "More transfers" });
      const refresh = screen.getByRole("button", { name: "Refresh transfer status" });
      expect(more).toHaveAttribute("aria-disabled", "true");
      expect(refresh).toHaveAttribute("aria-disabled", "true");
      expect(more).toBeEnabled(); expect(refresh).toBeEnabled();
      fireEvent.click(more); fireEvent.click(refresh);
      expect(operations).toHaveBeenCalledTimes(3);
      await act(async () => { finish(transferPage([sample, retryable], "history")); });
      expect(more).not.toHaveAttribute("aria-disabled");
      expect(refresh).not.toHaveAttribute("aria-disabled");
      expect(screen.getByRole("alert")).toHaveTextContent("The retry was refused");
    } finally { vi.useRealTimers(); }
  });
  it("keeps unknown outcomes out of retry and requires acknowledgment before receipt recovery", async () => {
    const api = createCuezFixtureApi(), reconcile = vi.spyOn(api, "reconcile");
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    const badge = await screen.findByText("Needs review", { exact: true });
    const row = badge.closest("li")!;
    expect(within(row).queryByRole("button", { name: "Retry transfer" })).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Review outcome" }));
    expect(reconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I checked StoryDesk" }));
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Needs review", { exact: true })).toBeVisible();
  });
  it("restores focus when clearing the selected item and exposes recoverable errors", async () => {
    mount(); await chooseFirst();
    fireEvent.click(screen.getByRole("button", { name: "Clear the selected Boardwalk item" }));
    expect(screen.getByRole("radio", { name: /Community reporting in New Jersey/ })).toHaveFocus();
    cleanup(); mount(createCuezFixtureApi("error"));
    expect(await screen.findByRole("alert")).toHaveTextContent("StoryDesk is unavailable");
    expect(screen.getByRole("button", { name: "Try status again" })).toBeEnabled();
  });
  it("requires explicit closure of a confirmed partial story and keeps the original failure visible", async () => {
    const api = createCuezFixtureApi(), reconcile = vi.spyOn(api, "reconcile");
    mount(api);
    fireEvent.click(await screen.findByRole("tab", { name: "Transfers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark as done with what was sent" }));
    expect(screen.getByRole("heading", { name: "Review the partial transfer" })).toBeVisible();
    expect(reconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep what was sent" }));
    await screen.findByText("Marked as done with what was sent. Later revised exports will reuse the confirmed story.");
    expect(reconcile).toHaveBeenCalledWith("4".repeat(64), true);
    expect(screen.getByText("Conflict", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Mark as done with what was sent" })).not.toBeInTheDocument();
  });
  it("keeps existing-story search and import unavailable without Post-create permission", async () => {
    const api = createCuezFixtureApi("reader"), stories = vi.spyOn(api, "stories");
    mount(api);
    expect(await screen.findByRole("tab", { name: "Import" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Existing story" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Create or update a story" })).toBeChecked();
    expect(stories).not.toHaveBeenCalled();
  });
  it("keeps another tab usable when a local item request is still pending", async () => {
    const api = createCuezFixtureApi();
    let resolveItems!: (value: { items: []; nextCursor: null }) => void;
    api.resources = () => new Promise(resolve => { resolveItems = resolve; });
    mount(api);
    await screen.findByRole("status", { name: "Loading Boardwalk items" });
    fireEvent.click(screen.getByRole("tab", { name: "Import" }));
    expect(within(screen.getByRole("tabpanel", { name: "Import" })).getByRole("button", { name: /^Search$/ })).toBeEnabled();
    resolveItems({ items: [], nextCursor: null });
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading Boardwalk items" })).not.toBeInTheDocument());
  });
});
