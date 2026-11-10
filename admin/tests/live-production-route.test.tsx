import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import { LiveProductionProvider } from "../src/context/LiveProductionContext";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { banners, commissioning, fakeClient, session, sessionView } from "./live-production-fixtures";
import type { LiveProductionClient } from "../src/lib/live-production-workspace";
import { commandRequest } from "../src/lib/live-production-workspace";
type BannerPage = Awaited<ReturnType<LiveProductionClient["banners"]>>;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function open(client: LiveProductionClient = fakeClient()) {
  render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={client} /> }])} /></ExitGuardProvider>);
  await screen.findByRole("option", { name: /Studio rehearsal/ });
  fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
  await screen.findByRole("button", { name: /Headline · v1/ });
  fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
  return client;
}
async function headline() { fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ })); await screen.findByLabelText("Headline"); }
function hostRouter(client: LiveProductionClient) {
  // Distinct hosts force the same remount as the production route tree.
  return createMemoryRouter([
    { path: "/live-production", element: <div key="boardwalk"><LiveProductionWorkspace client={client} /></div> },
    { path: "/live-production/studio", element: <main key="studio"><LiveProductionWorkspace client={client} variant="studio" /></main> },
  ], { initialEntries: ["/live-production"] });
}
async function chooseHeadline() {
  await screen.findByRole("option", { name: /Studio rehearsal/ });
  fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
  fireEvent.click(await screen.findByRole("button", { name: /Headline · v1/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled());
}
describe("iPad producer actions", () => {
  it("keeps all twenty loaded Show rows available without paging or sending commands", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    const template = banners()[1];
    client.banners = async () => ({ banners: Array.from({ length: 20 }, (_, index) => ({ ...template, order: index,
      record: { ...template.record, id: `banner-${index}`, draft: { ...template.record.draft,
        text: { templateId: "headline" as const, headline: `Sample banner ${index + 1}` } } } })), nextCursor: null });
    render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={client} /> }])} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    const last = await screen.findByRole("button", { name: /Sample banner 20/ });
    expect(within(screen.getByRole("list", { name: "Ordered banners" })).getAllByRole("button")).toHaveLength(20);
    expect(screen.queryByRole("button", { name: "Next banners" })).toBeNull();
    fireEvent.click(last);
    expect(screen.getByRole("heading", { name: "Next banner" }).closest(".live-next")).toHaveTextContent("Sample banner 20");
    expect(client.command).not.toHaveBeenCalled();
  });
  it("keeps a banner selected from a later page when the host reloads page one", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    let archived = false;
    const extra = { ...banners()[1], record: { ...banners()[1].record, id: "later-archived", draft: { ...banners()[1].record.draft, version: 2 } } };
    client.banners = async (_id, cursor) => cursor ? { banners: [banners()[0]], nextCursor: null }
      : { banners: archived ? [banners()[1]] : [banners()[1], extra], nextCursor: "page-two" };
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    fireEvent.click(await screen.findByRole("button", { name: /Name and title · v1/ }));
    expect([...screen.getByRole("list", { name: "Ordered banners" }).querySelectorAll(".live-banner-number")].map(element => element.textContent)).toEqual(["1", "2", "3"]);
    archived = true;
    for (const link of ["Studio mode", "Boardwalk"]) {
      fireEvent.click(screen.getByRole("link", { name: link }));
      await screen.findByRole("link", { name: link === "Boardwalk" ? "Studio mode" : "Boardwalk" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh studio" })).toBeEnabled());
      expect(screen.getByRole("button", { name: /Name and title · v1/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByRole("heading", { name: "Next banner" }).closest(".live-next")).toHaveTextContent("JULIE O’CONNOR");
      expect(screen.getByRole("list")).toHaveTextContent("Next");
      expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(2);
    }
    expect(client.command).not.toHaveBeenCalled();
  });
  it("clears a restored selection that was archived while the workspace was closed", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    client.banners = async () => ({ banners: [banners()[0]], nextCursor: null });
    fireEvent.click(screen.getByRole("link", { name: "Studio mode" }));
    await screen.findByRole("link", { name: "Boardwalk" });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Headline · v1/ })).toBeNull());
    expect(screen.getByRole("heading", { name: "Next banner" }).closest(".live-next")).toHaveTextContent("Select the next banner");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(client.command).not.toHaveBeenCalled();
  });
  it("discards an unsaved edit when the producer confirms a host change", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command); client.save = vi.fn(client.save);
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Discarded edit" } });
    fireEvent.click(screen.getByRole("link", { name: "Studio mode" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await screen.findByRole("link", { name: "Boardwalk" });
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY");
    fireEvent.click(screen.getByRole("link", { name: "Boardwalk" }));
    await screen.findByRole("link", { name: "Studio mode" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.command).not.toHaveBeenCalled();
    expect(client.save).not.toHaveBeenCalled();
  });
  it("keeps a newer uncertain Clear when an earlier Take settles after a host change", async () => {
    const client = fakeClient(), original = client.command;
    let finishTake!: (command: Awaited<ReturnType<LiveProductionClient["command"]>>) => void;
    client.command = vi.fn(request => request.commandAction === "take"
      ? new Promise<Awaited<ReturnType<LiveProductionClient["command"]>>>(resolve => { finishTake = resolve; }) : Promise.reject(new Error("Clear receipt lost")));
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    fireEvent.click(screen.getByRole("link", { name: "Studio mode" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await screen.findByRole("link", { name: "Boardwalk" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear Overlay 1" }));
    await screen.findByText("Clear Overlay 1 requested; receipt unavailable");
    const take = await original((client.command as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    await act(async () => finishTake(take));
    expect(screen.getByText("Clear Overlay 1 requested; receipt unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(client.command).toHaveBeenCalledTimes(2);
  });
  it("keeps the session, banner and accepted request through both host changes without sending a command", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    expect(screen.queryByText(/\bdemo\b/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText("Awaiting observation");
    for (const link of ["Studio mode", "Boardwalk"]) {
      fireEvent.click(screen.getByRole("link", { name: link }));
      await screen.findByRole("link", { name: link === "Boardwalk" ? "Studio mode" : "Boardwalk" });
      expect(screen.queryByText(/\bdemo\b/i)).toBeNull();
      expect(screen.getByLabelText("Production session")).toHaveValue("rehearsal");
      expect(screen.getByRole("button", { name: /Headline · v1/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Awaiting observation")).toBeInTheDocument();
      expect(client.command).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps current and other-session unknown outcomes through Boardwalk and Studio", async () => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue(new Error("Receipt lost"));
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other show" }], nextCursor: null });
    client.banners = async id => ({ banners: banners().map(row => ({ ...row, record: { ...row.record, sessionId: id } })), nextCursor: null });
    render(<LiveProductionProvider><ExitGuardProvider><RouterProvider router={hostRouter(client)} /></ExitGuardProvider></LiveProductionProvider>);
    await chooseHeadline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText("Take requested; receipt unavailable");
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    await screen.findByText(/Unresolved Take outcome in Studio rehearsal/);
    fireEvent.click(await screen.findByRole("button", { name: /Headline · v1/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText("Take requested; receipt unavailable");
    for (const link of ["Studio mode", "Boardwalk"]) {
      fireEvent.click(screen.getByRole("link", { name: link }));
      await screen.findByRole("link", { name: link === "Boardwalk" ? "Studio mode" : "Boardwalk" });
      expect(screen.getByLabelText("Production session")).toHaveValue("other");
      expect(screen.getByRole("button", { name: /Headline · v1/ })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Take requested; receipt unavailable")).toBeInTheDocument();
      expect(screen.getByText(/Unresolved Take outcome in Studio rehearsal/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled());
      expect(client.command).toHaveBeenCalledTimes(2);
    }
  });
  it.each(["sign out", "change account"])("clears retained state on %s", async boundary => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue(new Error("Receipt lost"));
    const router = hostRouter(client);
    const signedIn = (uid: string) => <LiveProductionProvider key={uid}><ExitGuardProvider><RouterProvider router={router} /></ExitGuardProvider></LiveProductionProvider>;
    const view = render(signedIn("producer-a"));
    await chooseHeadline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText("Take requested; receipt unavailable");
    if (boundary === "sign out") view.rerender(<p>Signed out</p>);
    view.rerender(signedIn(boundary === "sign out" ? "producer-a" : "producer-b"));
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    expect(screen.getByLabelText("Production session")).toHaveValue("");
    expect(screen.queryByText("Take requested; receipt unavailable")).toBeNull();
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("keeps selection, a saved Next preview and unsaved Prepare edits separate in Show", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command); client.save = vi.fn(client.save);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }));
    const next = () => screen.getByRole("heading", { name: "Next banner" }).closest(".live-next") as HTMLElement;
    expect(next()).toHaveTextContent("POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY");
    expect(screen.queryByLabelText("Headline")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(client.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit banner" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Unsent producer edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(next()).toHaveTextContent("POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY");
    expect(next()).not.toHaveTextContent("Unsent producer edit");
    expect(next()).toHaveTextContent("Take is unavailable until you save or discard");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Unsent producer edit");
    expect(client.command).not.toHaveBeenCalled();
    expect(client.save).not.toHaveBeenCalled();
  });
  it("expands an uncertain Show request without enabling another Take or hiding Clear", async () => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue(new Error("Receipt lost"));
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }));
    const request = () => screen.getByRole("heading", { name: "Requested action" }).closest(".live-requested") as HTMLElement;
    expect(request()).toHaveClass("live-requested--idle");
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText("Take requested; receipt unavailable");
    expect(request()).toHaveClass("live-requested--active");
    expect(request()).toHaveTextContent("Outcome unknown");
    expect(within(request()).getByRole("button", { name: "Use fresh observed state" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(request()).toHaveTextContent("Outcome unknown");
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("identifies operator-confirmed title files in the observed setup card", async () => {
    const client = fakeClient(); client.session = async () => ({ ...sessionView(), commissioning });
    await open(client);
    expect(screen.getByText(/Setup verified · title files operator-confirmed/)).toBeInTheDocument();
  });
  it("keeps an uncertain Take visible across session changes and blocks an unacknowledged retry on return", async () => {
    const client = fakeClient();
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other show" }], nextCursor: null });
    client.command = vi.fn().mockRejectedValue(new Error("Connection lost"));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText(/Request outcome unknown/);
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    await screen.findByText(/Unresolved Take outcome in Studio rehearsal/);
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    await screen.findByRole("button", { name: /Headline · v1/ });
    await headline();
    await screen.findByText("Take requested; receipt unavailable");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use fresh observed state" })).toBeDisabled();
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it.each(["online", "pageshow", "manual"])("recovers a failed initial session list through %s", async trigger => {
    const client = fakeClient();
    client.sessions = vi.fn().mockRejectedValueOnce(new Error("Session list offline"))
      .mockResolvedValue({ sessions: [session], nextCursor: null });
    render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={client} /> }])} /></ExitGuardProvider>);
    await screen.findByText("Session list offline");
    if (trigger === "manual") fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    else fireEvent(window, new Event(trigger));
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    expect(screen.queryByText("Session list offline")).toBeNull();
  });
  it("fast-polls a pending Take restored from the selected banner", async () => {
    const client = fakeClient();
    const acceptedCommand = await client.command(commandRequest({ ...sessionView(), requestStartedAt: 0 }, "take", banners()[1]));
    client.banners = async () => ({ banners: banners().map(row => row.record.id === "headline-banner"
      ? { ...row, record: { ...row.record, acceptedCommand } } : row), nextCursor: null });
    client.session = vi.fn(client.session);
    await open(client);
    vi.useFakeTimers({ shouldClearNativeTimers: true });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ })); });
    const before = (client.session as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect((client.session as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByRole("heading", { name: "Requested action" }).parentElement!.parentElement).toHaveTextContent("Awaiting observation");
  });
  it("keeps paged-in sessions selected after Safari resume and manual refresh", async () => {
    const client = fakeClient();
    client.banners = async id => ({ banners: banners().map(row => ({ ...row, record: { ...row.record, sessionId: id } })), nextCursor: null });
    client.sessions = vi.fn(async cursor => cursor ? { sessions: [{ ...session, id: "page-two", title: "Second page show" }], nextCursor: null }
      : { sessions: [session], nextCursor: "page-two" });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "More sessions" }));
    await screen.findByRole("option", { name: /Second page show/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "page-two" } });
    await screen.findByRole("button", { name: /Headline · v1/ });
    await act(async () => { fireEvent(window, new Event("pageshow")); });
    expect(screen.getByRole("option", { name: /Second page show/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh studio" })).toBeEnabled());
    expect(screen.getByLabelText("Production session")).toHaveValue("page-two");
    expect(screen.getByRole("option", { name: /Second page show/ })).toBeInTheDocument();
  });
  it("keeps a fresh observation while selecting a restored command and fast-polls its first status result", async () => {
    const client = fakeClient();
    const acceptedCommand = await client.command(commandRequest({ ...sessionView(), requestStartedAt: 0 }, "take", banners()[1]));
    client.banners = async () => ({ banners: banners().map(row => row.record.id === "headline-banner"
      ? { ...row, record: { ...row.record, acceptedCommand } } : row), nextCursor: null });
    await open(client);
    let finish!: (view: ReturnType<typeof sessionView>) => void;
    client.session = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(sessionView());
    vi.useFakeTimers({ shouldClearNativeTimers: true });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ })); });
    expect(screen.getByRole("heading", { name: "Observed output" }).parentElement!.parentElement).toHaveTextContent("Clear");
    await act(async () => finish(sessionView()));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(client.session).toHaveBeenCalledTimes(2);
  });
  it("isolates a rejected old pagination request from the next session's loading state", async () => {
    const client = fakeClient();
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other show" }], nextCursor: null });
    let rejectOld!: (error: Error) => void;
    let finishNew!: (value: Awaited<ReturnType<LiveProductionClient["banners"]>>) => void;
    client.banners = vi.fn((id, cursor) => id === "other" ? new Promise<BannerPage>(resolve => { finishNew = resolve; })
      : cursor ? new Promise<BannerPage>((_, reject) => { rejectOld = reject; }) : Promise.resolve({ banners: banners(), nextCursor: "page2" }));
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    await act(async () => rejectOld(new Error("Old session page failed")));
    expect(screen.queryByText("Old session page failed")).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh studio" })).toBeDisabled();
    await act(async () => finishNew({ banners: [], nextCursor: null }));
    expect(screen.getByRole("button", { name: "Refresh studio" })).toBeEnabled();
  });
  it("retains a successful edit when a pre-save refresh returns an older banner page", async () => {
    const client = fakeClient();
    await open(client); await headline();
    let finish!: (value: Awaited<ReturnType<LiveProductionClient["banners"]>>) => void;
    client.banners = vi.fn(() => new Promise<BannerPage>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Just saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    await act(async () => finish({ banners: banners(), nextCursor: null }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Just saved");
    expect(screen.getByText("Saved v2")).toBeInTheDocument();
  });
  it("preserves rundown order and keeps edits, Save, and Take separate", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command); client.save = vi.fn(client.save);
    await open(client);
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("button")[0]).toHaveTextContent("Headline");
    await headline();
    const text = "  長い headline & café\n" + "no truncation ".repeat(100);
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: text } });
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(client.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 1, text: { templateId: "headline", headline: text } }));
    expect(client.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledTimes(1));
    expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ commandAction: "take", baseVersion: 2, bannerId: "headline-banner" }));
    expect(screen.getByRole("heading", { name: "Observed output" }).parentElement?.parentElement).toHaveTextContent("Clear");
  });
  it("numbers visible positions across order gaps and filters without changing command identity", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    client.banners = async () => ({ banners: banners().map((item, index) => ({ ...item, order: index ? 100 : 5000 })), nextCursor: null });
    await open(client);
    const list = screen.getByRole("list", { name: "Ordered banners" });
    const numbers = () => [...list.querySelectorAll(".live-banner-number")].map(element => element.textContent);
    expect(numbers()).toEqual(["1", "2"]);
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    expect(screen.getByLabelText("Order number")).toHaveValue("5001");
    const controls = screen.getByRole("group", { name: "Show controls" });
    expect(controls).toHaveTextContent("2 · Saved v1");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "POLL" } });
    expect(numbers()).toEqual(["1"]);
    expect(controls).toHaveTextContent("Outside current filters · Saved v1");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(numbers()).toEqual(["1", "2"]);
    expect(screen.getByRole("heading", { name: "Next banner" }).closest(".live-next")).toHaveTextContent("2 · Name and title · Saved v1");
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledTimes(1));
    expect(client.command).toHaveBeenLastCalledWith(expect.objectContaining({ commandAction: "take", bannerId: "name-banner", baseVersion: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Clear Overlay 1" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledTimes(2));
    expect(client.command).toHaveBeenLastCalledWith(expect.objectContaining({ commandAction: "clear", target: { kind: "managed_overlay" } }));
  });
  it("keeps a lost Take outcome unknown and never retries on refresh or resume", async () => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue(new Error("Connection lost"));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText(/Request outcome unknown/);
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled());
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("shows an explicit admission refusal without claiming an unknown native outcome", async () => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue({ status: 409 });
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText(/Request refused/);
    expect(screen.getByText("Take refused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use fresh observed state" })).toBeNull();
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("shows the backend pending-Clear refusal plainly and never retries it", async () => {
    const client = fakeClient();
    client.command = vi.fn().mockRejectedValue(Object.assign(new Error("Clear is still pending; use Take to put a banner back on air"), { status: 409 }));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText(/Request refused. Clear is still pending; use Take to put a banner back on air/);
    fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled());
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("requires a newer observed sample and a deliberate acknowledgment after a lost response", async () => {
    const client = fakeClient(); client.command = vi.fn().mockRejectedValue(new Error("Connection lost"));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await screen.findByText(/Request outcome unknown/);
    expect(screen.getByRole("button", { name: "Use fresh observed state" })).toBeDisabled();
    const view = sessionView();
    client.session = async () => ({ ...view, observed: { ...view.observed, report: { ...view.observed.report!, sequence: 4 } } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use fresh observed state" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Use fresh observed state" }));
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(client.command).toHaveBeenCalledTimes(1);
  });
  it("allows deliberate Clear while a Take request is still in flight", async () => {
    const client = fakeClient(); const original = client.command;
    let finish!: (value: Awaited<ReturnType<typeof original>>) => void;
    client.command = vi.fn(request => request.commandAction === "take" ? new Promise<Awaited<ReturnType<typeof original>>>(resolve => { finish = resolve; }) : original(request));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Overlay 1" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledTimes(2));
    const take = await original((client.command as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    await act(async () => finish(take));
    const requested = screen.getByRole("heading", { name: "Requested action" }).parentElement!.parentElement!;
    expect(requested).toHaveTextContent("Clear Overlay 1");
    expect(requested).not.toHaveTextContent("Take · saved version");
  });
  it("follows a newer saved version when this producer has not edited the selection", async () => {
    const client = fakeClient();
    await open(client); await headline();
    client.banners = async () => ({ banners: banners().map(row => row.record.id !== "headline-banner" ? row : { ...row,
      record: { ...row.record, draft: { ...row.record.draft, version: 2, text: { templateId: "headline", headline: "New saved wording" } } } }), nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    await waitFor(() => expect(screen.getByLabelText("Headline")).toHaveValue("New saved wording"));
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use saved text" })).toBeNull();
  });
  it.each(["Clear refuses first", "Take loses response first"])("retains Take uncertainty when %s", async order => {
    const client = fakeClient();
    let rejectTake!: (error: unknown) => void, rejectClear!: (error: unknown) => void;
    client.command = vi.fn(request => new Promise<Awaited<ReturnType<LiveProductionClient["command"]>>>((_, reject) => {
      if (request.commandAction === "take") rejectTake = reject; else rejectClear = reject;
    }));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Overlay 1" }));
    if (order === "Clear refuses first") {
      await act(async () => rejectClear({ status: 409 }));
      await act(async () => rejectTake(new Error("Take receipt lost")));
    } else {
      await act(async () => rejectTake(new Error("Take receipt lost")));
      await act(async () => rejectClear({ status: 409 }));
    }
    expect(screen.getByText("Take requested; receipt unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use fresh observed state" })).toBeInTheDocument();
  });
  it("clears a transient polling error after a successful automatic status poll", async () => {
    const client = fakeClient();
    await open(client); await headline();
    vi.useFakeTimers({ shouldClearNativeTimers: true });
    client.session = vi.fn().mockRejectedValueOnce(new Error("Studio read failed")).mockResolvedValue(sessionView());
    await act(async () => { fireEvent(window, new Event("pageshow")); });
    expect(screen.getByText("Studio read failed")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(screen.queryByText("Studio read failed")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
  });
  it("edits name and an empty title as a staged draft", async () => {
    const client = fakeClient(); client.save = vi.fn(client.save); client.command = vi.fn(client.command);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  李 & Zoë  " } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ baseVersion: 1,
      text: { templateId: "name_title", name: "  李 & Zoë  ", title: "" } }));
    expect(client.command).not.toHaveBeenCalled();
  });
  it("retains an edit on conflict and compares the newly saved text", async () => {
    const client = fakeClient(); client.save = vi.fn().mockRejectedValue(Object.assign(new Error("The record changed. Reload before saving."), { status: 409 }));
    await open(client); await headline();
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "My unsaved wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/saved version or studio state changed/);
    client.banners = async () => ({ banners: banners().map(row => row.record.id !== "headline-banner" ? row : { ...row,
      record: { ...row.record, draft: { ...row.record.draft, version: 2, text: { templateId: "headline", headline: "Another producer's text" } } } }), nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    await screen.findByText("A newer draft is saved. Compare it below. Copy your edits before choosing to use the saved version.");
    expect(screen.getByLabelText("Headline")).toHaveValue("My unsaved wording");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
  });
  it("keeps Clear available for unknown output while Take stays disabled, and reconciles after Safari is hidden", async () => {
    const client = fakeClient(); const view = sessionView();
    client.session = async () => ({ ...view, observed: { ...view.observed, state: "unknown", report: null } });
    await open(client); await headline();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(within(screen.getByRole("group", { name: "Show controls" })).getByText(/Reconnect and refresh/)).toBeInTheDocument();
  });
  it("sends Clear with observation sequence zero when no agent sample exists", async () => {
    const client = fakeClient(); client.command = vi.fn(client.command);
    const view = sessionView(); client.session = async () => ({ ...view, observed: { ...view.observed, state: "unknown", report: null } });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Clear Overlay 1" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ commandAction: "clear", expectedObservationSequence: 0 })));
  });
  it("asks before abandoning unsaved text for another banner", async () => {
    await open(); await headline();
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Unsaved");
  });
});
