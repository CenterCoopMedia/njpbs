import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveProductionWorkspace } from "../src/routes/LiveProductionRoute";
import { ExitGuardProvider } from "../src/routes/ExitGuard";
import { banners, fakeClient, observation, session, sessionView } from "./live-production-fixtures";
import type { LiveProductionClient, OrderedBanner } from "../src/lib/live-production-workspace";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open(client = fakeClient()) {
  render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={client} /> }])} /></ExitGuardProvider>);
  await screen.findByRole("option", { name: /Studio rehearsal/ });
  fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
  await screen.findByRole("button", { name: /Headline · v1/ });
  fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
  return client;
}
async function headline() { fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ })); await screen.findByLabelText("Headline"); }
const csv = 'templateId,headline,name,title\nheadline,"  Literal, headline  ",,\nname_title,,Zoë & 李,';
function csvForm() { return within(screen.getByRole("heading", { name: "Import banner CSV" }).closest("form")!); }
function studioSetup() { fireEvent.click(screen.getByText("Studio setup")); }

describe("producer preparation without native control side effects", () => {
  it("adds literal name/title text and requires a separate saved-version Take", async () => {
    const client = fakeClient(); client.save = vi.fn(client.save); client.command = vi.fn(client.command);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Add banner" }));
    const form = within(screen.getByRole("heading", { name: "New banner" }).closest("form")!);
    fireEvent.change(form.getByLabelText("Banner template"), { target: { value: "name_title" } });
    const name = "  Zoë & 李\n第二行  ";
    fireEvent.change(form.getByLabelText("Name"), { target: { value: name } });
    fireEvent.change(form.getByLabelText("Order number"), { target: { value: "7" } });
    fireEvent.click(form.getByRole("button", { name: "Add banner" }));
    await screen.findByText(/Banner added\. Output has not changed/);
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ action: "save_banner", baseVersion: 0, order: 6, text: { templateId: "name_title", name, title: "" } }));
    expect((client.save as ReturnType<typeof vi.fn>).mock.calls[0][0].bannerId).toBeUndefined();
    expect(client.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ commandAction: "take", bannerId: "new-banner-1", baseVersion: 1 })));
  });
  it("owns order dirtiness with text and saves the exact order before Take", async () => {
    const client = fakeClient(); client.save = vi.fn(client.save); client.command = vi.fn(client.command);
    await open(client); await headline();
    fireEvent.change(screen.getByLabelText("Order number"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Order number"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    expect(client.save).toHaveBeenCalledWith(expect.objectContaining({ bannerId: "headline-banner", baseVersion: 1, order: 6, text: banners()[1].record.draft.text }));
    expect(screen.getByLabelText("Order number")).toHaveValue("7");
    const numberedRows = within(screen.getByRole("list", { name: "Ordered banners" })).getAllByRole("button");
    expect(numberedRows[0]).toHaveTextContent("Name and title");
    expect(numberedRows[0].querySelector(".live-banner-number")).toHaveTextContent("1");
    expect(numberedRows[1].querySelector(".live-banner-number")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(client.command).not.toHaveBeenCalled();
  });
  it("confirms archive, removes the row, restores focus and retains observed on-air text", async () => {
    const client = fakeClient(), view = sessionView();
    client.archive = vi.fn(client.archive); client.command = vi.fn(client.command);
    client.session = async () => ({ ...view, observed: { ...view.observed, state: "on_air", report: { ...observation,
      state: "on_air", inputKey: "headline-input", text: banners()[1].record.draft.text } } });
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Archive banner" }));
    let dialog = screen.getByRole("dialog", { name: "Archive this banner?" });
    expect(dialog).toHaveTextContent("An on-air graphic stays on air");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(client.archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Archive banner" }));
    dialog = screen.getByRole("dialog", { name: "Archive this banner?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive banner" }));
    await screen.findByText(/Banner archived\. An on-air graphic stays on air/);
    expect(screen.queryByRole("button", { name: /Headline · v1/ })).toBeNull();
    expect(screen.getByRole("list", { name: "Ordered banners" }).querySelector(".live-banner-number")).toHaveTextContent("1");
    const observed = screen.getByRole("heading", { name: "Observed output" }).parentElement!.parentElement!;
    expect(observed).toHaveTextContent(banners()[1].record.draft.text.templateId === "headline" ? "POLL: 3 IN 4" : "");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Rundown" })).toHaveFocus());
    expect(client.command).not.toHaveBeenCalled();
  });
  it("refreshes away banners archived by another producer without losing an unsaved selection", async () => {
    const client = fakeClient();
    await open(client); await headline();
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Keep this unsaved text" } });
    client.banners = async () => ({ banners: [banners()[0]], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Refresh studio" }));
    await screen.findByText(/This banner is outside the refreshed rundown/);
    expect(screen.queryByRole("button", { name: /Headline · v1/ })).toBeNull();
    expect(screen.getByLabelText("Headline")).toHaveValue("Keep this unsaved text");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByRole("heading", { name: "Next banner" }).closest(".live-next")).toHaveTextContent("Outside rundown");
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    expect(screen.getByLabelText("Name")).toHaveValue("JULIE O’CONNOR");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
  });
  it("previews and reports row errors locally, then appends the untouched CSV", async () => {
    const client = fakeClient(); client.importCsv = vi.fn(client.importCsv); client.command = vi.fn(client.command);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: "templateId,headline,name,title\nheadline,valid,,\nname_title,,," } });
    expect(csvForm().getByText(/CSV row 3: Enter a name/)).toBeInTheDocument();
    expect(csvForm().getByRole("button", { name: "Import banners" })).toBeDisabled();
    expect(client.importCsv).not.toHaveBeenCalled();
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    expect(csvForm().getByText("2 valid banner rows · Ready to import")).toBeInTheDocument();
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText("2 banners imported. Output has not changed.");
    expect(client.importCsv).toHaveBeenCalledWith(expect.objectContaining({ csv }));
    expect((client.importCsv as ReturnType<typeof vi.fn>).mock.calls[0][0].archiveExisting).toBeUndefined();
    expect(client.command).not.toHaveBeenCalled();
  });
  it("confirms all-page archive-first import and ignores a late old banner page", async () => {
    const client = fakeClient(), read = client.banners;
    let settle!: (value: { banners: OrderedBanner[]; nextCursor: string | null }) => void;
    client.banners = vi.fn().mockResolvedValueOnce({ banners: banners(), nextCursor: "old-page" })
      .mockImplementationOnce(() => new Promise(resolve => { settle = resolve; })).mockImplementation(read);
    client.importCsv = vi.fn(client.importCsv); client.command = vi.fn(client.command);
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByLabelText("Archive current banners first"));
    fireEvent.click(csvForm().getByRole("button", { name: "Review archive and import" }));
    const dialog = screen.getByRole("dialog", { name: "Archive current banners and import?" });
    expect(dialog).toHaveTextContent("including banners beyond loaded pages");
    expect(client.importCsv).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive current and import" }));
    await screen.findByText("2 banners imported; previous banners archived. Output has not changed.");
    await act(async () => { settle({ banners: banners(), nextCursor: "late-cursor" }); });
    expect(screen.queryByRole("button", { name: /Headline · v1.*POLL:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more banners" })).toBeNull();
    expect(client.importCsv).toHaveBeenCalledWith(expect.objectContaining({ archiveExisting: true, csv }));
    expect(client.command).not.toHaveBeenCalled();
  });
  it("reads a CSV file locally and protects an existing pasted source before replacing it", async () => {
    const client = fakeClient(); client.importCsv = vi.fn(client.importCsv);
    await open(client); fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    const original = "templateId,headline,name,title\nheadline,Keep my paste,,";
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: original } });
    const file = new File([csv], "rundown.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    fireEvent.change(csvForm().getByLabelText("CSV file"), { target: { files: [file] } });
    const dialog = await screen.findByRole("dialog", { name: "Replace the current CSV?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep current CSV" }));
    expect(csvForm().getByLabelText("CSV text")).toHaveValue(original);
    expect(client.importCsv).not.toHaveBeenCalled();
    fireEvent.change(csvForm().getByLabelText("CSV file"), { target: { files: [file] } });
    const replace = await screen.findByRole("dialog", { name: "Replace the current CSV?" });
    fireEvent.click(within(replace).getByRole("button", { name: "Replace CSV" }));
    await waitFor(() => expect(csvForm().getByLabelText("CSV text")).toHaveValue(csv));
    expect(csvForm().getByText("2 valid banner rows · Ready to import")).toBeInTheDocument();
    expect(client.importCsv).not.toHaveBeenCalled();
  });
  it("keeps a lost import result and retries the same idempotent request deliberately", async () => {
    const client = fakeClient(), importCsv = client.importCsv;
    let receipt: OrderedBanner[] | null = null;
    client.importCsv = vi.fn(async request => {
      if (receipt) return receipt;
      receipt = await importCsv(request); throw new Error("Connection lost after save");
    });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText(/Preparation outcome unknown/);
    expect(csvForm().getByLabelText("CSV text")).toHaveValue(csv);
    expect(csvForm().getByLabelText("CSV text")).toBeDisabled();
    fireEvent(window, new Event("pageshow"));
    expect(client.importCsv).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    await screen.findByText("2 banners imported. Output has not changed.");
    const calls = (client.importCsv as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
  });
  it.each(["banner", "session"])("protects uncertain CSV input before %s selection and a refused retry", async selection => {
    const client = fakeClient();
    client.importCsv = vi.fn().mockRejectedValueOnce(new Error("Connection lost"))
      .mockRejectedValueOnce(Object.assign(new Error("The original session ended."), { status: 409 }));
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other studio" }], nextCursor: null });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText(/Preparation outcome unknown/);
    const select = () => selection === "banner"
      ? fireEvent.click(screen.getByRole("button", { name: /Headline · v1/ }))
      : fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    select();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep editing" }));
    expect(csvForm().getByLabelText("CSV text")).toHaveValue(csv);
    expect(screen.getByLabelText("Production session")).toHaveValue("rehearsal");
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    await screen.findByText(/Preparation change refused.*The original session ended/);
    expect(csvForm().getByLabelText("CSV text")).toHaveValue(csv);
    expect(csvForm().getByLabelText("CSV text")).toBeEnabled();
    const calls = (client.importCsv as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
    select();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    expect(screen.queryByLabelText("CSV text")).toBeNull();
    if (selection === "banner") expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    else await screen.findByText("This session has no banners yet.");
  });
  it.each([false, true])("restarts paging after moving its cursor row, retaining selection and unsaved edit=%s", async editDuringRefresh => {
    const client = fakeClient();
    // Short network pages keep the cursor race; the store test covers 100-row pages.
    const pageSize = 3;
    let rows: OrderedBanner[] = [0, 1, 99, 100, 101, 199, 200].map(order => order === 99 ? { ...banners()[1], order }
      : { ...banners()[0], order, record: { ...banners()[0].record, id: `banner-${order}`,
        draft: { ...banners()[0].record.draft, text: { templateId: "name_title", name: `Banner ${order}`, title: "" } } } });
    let finishRefresh!: (page: { banners: OrderedBanner[]; nextCursor: string | null }) => void;
    let finishOldPage!: (page: { banners: OrderedBanner[]; nextCursor: string | null }) => void;
    let holdRefresh = false;
    client.banners = vi.fn(async (_id, cursor) => {
      const sorted = [...rows].sort((a, b) => a.order - b.order || a.record.id.localeCompare(b.record.id));
      const offset = cursor ? sorted.findIndex(row => row.record.id === cursor) + 1 : 0;
      const page = sorted.slice(offset, offset + pageSize);
      const result = { banners: page, nextCursor: offset + pageSize < sorted.length ? page.at(-1)!.record.id : null };
      if (cursor === "headline-banner") return new Promise<{ banners: OrderedBanner[]; nextCursor: string | null }>(resolve => { finishOldPage = resolve; });
      if (holdRefresh && !cursor) { holdRefresh = false; return new Promise<{ banners: OrderedBanner[]; nextCursor: string | null }>(resolve => { finishRefresh = resolve; }); }
      return result;
    });
    client.save = async request => {
      const prior = rows.find(row => row.record.id === request.bannerId)!;
      const saved = { ...prior, order: request.order, record: { ...prior.record,
        draft: { ...prior.record.draft, version: request.baseVersion + 1, text: request.text } } };
      rows = rows.map(row => row.record.id === saved.record.id ? saved : row);
      return saved;
    };
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    fireEvent.change(screen.getByLabelText("Order number"), { target: { value: "201" } });
    holdRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Draft saved. Output has not changed.");
    await waitFor(() => expect(client.banners).toHaveBeenCalledTimes(3));
    expect((client.banners as ReturnType<typeof vi.fn>).mock.calls[2][1]).toBeUndefined();
    if (editDuringRefresh) fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Keep this edit while paging resets" } });
    await act(async () => finishRefresh({ banners: rows.filter(row => row.order < 99 || row.order === 100), nextCursor: "banner-100" }));
    await act(async () => finishOldPage({ banners: [], nextCursor: "obsolete-cursor" }));
    const expectedText = editDuringRefresh ? "Keep this edit while paging resets" : "POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY";
    expect(screen.getByLabelText("Headline")).toHaveValue(expectedText);
    expect(screen.getByRole("button", { name: "Take saved banner" })).toHaveProperty("disabled", editDuringRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Load more banners" }));
    await screen.findByRole("button", { name: /Name and title · v1.*Banner 199/ });
    expect(screen.getByRole("button", { name: /Name and title · v1.*Banner 100/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Headline")).toHaveValue(expectedText);
    const calls = (client.banners as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4); expect(calls[3][1]).toBe("banner-100");
  });
  it("keeps unrelated saved-banner Take, selection and Cancel available after an uncertain import", async () => {
    const client = fakeClient();
    client.importCsv = vi.fn().mockRejectedValue(new Error("Connection lost"));
    client.command = vi.fn(client.command);
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other studio" }], nextCursor: null });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText(/Preparation outcome unknown/);
    expect(csvForm().getByRole("button", { name: "Cancel import" })).toBeEnabled();
    fireEvent.click(csvForm().getByRole("button", { name: "Cancel import" }));
    expect(screen.getByText("Unresolved preparation change")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add banner" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    await screen.findByText("This session has no banners yet.");
    expect(screen.getByText(/CSV import for Studio rehearsal/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    await screen.findByRole("button", { name: /Headline · v1/ });
    await headline();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ commandAction: "take", bannerId: "headline-banner", baseVersion: 1 })));
    expect(client.importCsv).toHaveBeenCalledTimes(1);
  });
  it("keeps unrelated Take and selection available while the same uncertain request is retried", async () => {
    const client = fakeClient();
    let finish!: (rows: OrderedBanner[]) => void;
    client.importCsv = vi.fn().mockRejectedValueOnce(new Error("Connection lost"))
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText(/Preparation outcome unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(csvForm().getByRole("button", { name: "Cancel import" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry same preparation request" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    expect(screen.getByLabelText("Name")).toHaveValue("JULIE O’CONNOR");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    await act(async () => finish(banners()));
    await waitFor(() => expect(screen.queryByText("Unresolved preparation change")).toBeNull());
  });
  it("retries an unresolved import for its original session after switching to another show", async () => {
    const client = fakeClient();
    client.importCsv = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(banners());
    client.sessions = async () => ({ sessions: [session, { ...session, id: "other", title: "Other studio" }], nextCursor: null });
    await open(client);
    fireEvent.click(screen.getByRole("button", { name: "Import CSV" }));
    fireEvent.change(csvForm().getByLabelText("CSV text"), { target: { value: csv } });
    fireEvent.click(csvForm().getByRole("button", { name: "Import banners" }));
    await screen.findByText(/Preparation outcome unknown/);
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "other" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    await screen.findByText("This session has no banners yet.");
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    await waitFor(() => expect(screen.queryByText("Unresolved preparation change")).toBeNull());
    expect(screen.getByLabelText("Production session")).toHaveValue("other");
    expect(screen.queryByRole("button", { name: /Headline · v1/ })).toBeNull();
    const calls = (client.importCsv as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
    expect(calls[1][0].sessionId).toBe("rehearsal");
  });
  it("holds only the archived banner after an uncertain archive and leaves Clear available", async () => {
    const client = fakeClient(); client.archive = vi.fn().mockRejectedValue(new Error("Connection lost"));
    await open(client); await headline();
    fireEvent.click(screen.getByRole("button", { name: "Archive banner" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive banner" }));
    await screen.findByText(/Preparation outcome unknown/);
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(screen.getByText("Unresolved preparation change")).toBeInTheDocument();
  });
  it("recovers a lost order-save response with the same request and saved version", async () => {
    const client = fakeClient(), save = client.save;
    let receipt: OrderedBanner | null = null;
    client.save = vi.fn(async request => {
      if (receipt) return receipt;
      receipt = await save(request); throw new Error("Connection lost after save");
    });
    client.command = vi.fn(client.command);
    await open(client); await headline();
    fireEvent.change(screen.getByLabelText("Order number"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Preparation outcome unknown/);
    expect(screen.getByLabelText("Order number")).toHaveValue("7");
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    await screen.findByText("Draft saved. Output has not changed.");
    const calls = (client.save as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
    expect(screen.getByText("Saved v2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeEnabled();
    expect(client.command).not.toHaveBeenCalled();
  });
  it("keeps the selected saved banner visible when another banner's uncertain save settles", async () => {
    const client = fakeClient(), save = client.save;
    let receipt: OrderedBanner | null = null;
    client.save = vi.fn(async request => {
      if (receipt) return receipt;
      receipt = await save(request); throw new Error("Connection lost after save");
    });
    client.command = vi.fn(client.command);
    await open(client); await headline();
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Updated headline A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Preparation outcome unknown/);
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Headline")).toHaveValue("Updated headline A");
    fireEvent.click(screen.getByRole("button", { name: /Name and title · v1/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard and leave" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry same preparation request" }));
    await screen.findByText("Draft saved. Output has not changed.");
    expect(screen.getByLabelText("Name")).toHaveValue("JULIE O’CONNOR");
    expect(screen.getByLabelText("Title")).toHaveValue("NJ PBS SPOTLIGHT SENIOR REPORTER");
    expect(screen.queryByLabelText("Headline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take saved banner" }));
    await waitFor(() => expect(client.command).toHaveBeenCalledWith(expect.objectContaining({ bannerId: "name-banner", baseVersion: 1 })));
  });
  it("keeps an in-flight first page and a banner added after that read began", async () => {
    const client = fakeClient();
    let finish!: (page: { banners: OrderedBanner[]; nextCursor: string | null }) => void;
    let signal: AbortSignal | undefined;
    client.banners = vi.fn(async (_id, _cursor, readSignal) => {
      signal = readSignal;
      return new Promise<{ banners: OrderedBanner[]; nextCursor: string | null }>(resolve => { finish = resolve; });
    });
    render(<ExitGuardProvider><RouterProvider router={createMemoryRouter([{ path: "/", element: <LiveProductionWorkspace client={client} /> }])} /></ExitGuardProvider>);
    await screen.findByRole("option", { name: /Studio rehearsal/ });
    fireEvent.change(screen.getByLabelText("Production session"), { target: { value: "rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add banner" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add banner" }));
    fireEvent.change(screen.getByLabelText("Headline"), { target: { value: "Added while the page loads" } });
    const form = within(screen.getByRole("heading", { name: "New banner" }).closest("form")!);
    fireEvent.click(form.getByRole("button", { name: "Add banner" }));
    await screen.findByText(/Banner added\. Output has not changed/);
    expect(signal?.aborted).toBe(false);
    await act(async () => finish({ banners: banners(), nextCursor: "next-page" }));
    expect(screen.getByRole("button", { name: /Headline · v1 Added while the page loads/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Name and title · v1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more banners" })).toBeInTheDocument();
    expect(screen.getByLabelText("Headline")).toHaveValue("Added while the page loads");
    expect(client.banners).toHaveBeenCalledTimes(1);
  });
  it("loads programs only for session creation, suggests an editable date/name and creates an unbound draft", async () => {
    const client = fakeClient(); client.programs = vi.fn(client.programs); client.createSession = vi.fn(client.createSession); client.command = vi.fn(client.command);
    await open(client); expect(client.programs).not.toHaveBeenCalled();
    studioSetup(); fireEvent.click(screen.getByRole("button", { name: "Create studio session" }));
    await screen.findByRole("option", { name: "NJ Spotlight News" });
    fireEvent.change(screen.getByLabelText("Program"), { target: { value: "spotlight" } });
    expect((screen.getByLabelText("Session name") as HTMLInputElement).value).toMatch(/^NJ Spotlight News - /);
    const title = "NJ Spotlight News - Oct 26, 2026";
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: "Create studio session" }));
    await screen.findByText(/Studio session created as a draft/);
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ title, productionProgramId: "spotlight", publicProgramId: "spotlight" }));
    expect(screen.getByLabelText("Production session")).toHaveValue("new-studio");
    await screen.findByText(/Studio setup needs verification|not active/);
    expect(client.command).not.toHaveBeenCalled();
  });
  it("ends permanently with confirmation and reconciles ended metadata without a Clear", async () => {
    const client = fakeClient(); client.endSession = vi.fn(client.endSession); client.command = vi.fn(client.command);
    await open(client); await headline(); studioSetup();
    fireEvent.click(screen.getByRole("button", { name: "End studio session" }));
    const dialog = screen.getByRole("dialog", { name: "End this studio session permanently?" });
    expect(dialog).toHaveTextContent("not an end-of-show action");
    expect(dialog).toHaveTextContent("Overlay 1 will not be cleared");
    fireEvent.click(within(dialog).getByRole("button", { name: "End studio session permanently" }));
    await screen.findByText(/Studio session ended permanently/);
    expect(client.endSession).toHaveBeenCalledWith(expect.objectContaining({ baseGeneration: 1, state: "ended" }));
    expect(screen.getByRole("button", { name: "Clear Overlay 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Take saved banner" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Observed output" }).parentElement!.parentElement!).toHaveTextContent("Unknown");
    expect(screen.queryByText(/needs reconciliation/)).toBeNull();
    expect(client.command).not.toHaveBeenCalled();
  });
});
