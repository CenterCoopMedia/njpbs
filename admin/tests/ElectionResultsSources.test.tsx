import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ElectionResultsEditor, ElectionResultsSourceControls } from "../src/components/ElectionResultsEditor";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { BlockEditor } from "../src/components/BlockEditor";
import { RecordForm } from "../src/components/RecordForm";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { ContentQuickActionsBoundary, useContentQuickEditGuard } from "../src/context/ContentQuickActionsContext";
import { ElectionResultsSourceHost, type ElectionSourceHost } from "../src/context/ElectionResultsSourceHost";
import type { ElectionSourceApi, ElectionSourceConfig, ElectionSourceConnection, ElectionSourceState } from "../src/lib/election-sources";
import { HttpError } from "../src/lib/functions";
import { electionBlock, electionRace } from "../../tests/fixtures/election-results";
import rosterFixture from "../../tests/fixtures/election-sources/roster.json";
import type { ElectionRoster } from "../../packages/content-core/src/election-result-sources";

afterEach(cleanup);
const roster = rosterFixture as ElectionRoster;
const config: ElectionSourceConfig = { source: { kind: "repo" }, raceIds: ["us-senate"], mode: "approve-once", maxAgeSeconds: 300 };
function connected(patch: Partial<ElectionSourceConnection> = {}): ElectionSourceConnection {
  return { config, version: 1, configRevision: 1, authorizedConfigRevision: null, paused: false,
    lastCheckAt: "2026-11-04T03:00:00Z", lastSourceSuccessAt: "2026-11-04T03:00:00Z", lastGoodAt: null,
    lastGoodData: null, lastGoodDigest: null, lastHoldReason: null, pendingStatuses: [], pendingDigest: null, pendingData: null, ...patch };
}
function transport(initial: Partial<ElectionSourceState> = {}) {
  let state: ElectionSourceState = { connection: null, canManage: true, canConnect: true, ...initial };
  const api = {
    get: vi.fn(async (_target, includeRoster, _signal?: AbortSignal) => ({ ...state, ...(includeRoster ? { roster } : {}) })),
    mutate: vi.fn(async (_target, request) => {
      const previous = state.connection ?? connected();
      const connection = connected({ ...previous, version: previous.version + 1,
        ...(request.action === "connect" ? { config: request.config } : {}),
        ...(request.action === "pause" ? { paused: true } : request.action === "resume" ? { paused: false } : {}) });
      state = { ...state, connection }; return { connection };
    }),
  } satisfies ElectionSourceApi;
  return { api, change: (patch: Partial<ElectionSourceState>) => { state = { ...state, ...patch }; } };
}
const host = (api: ElectionSourceApi, patch: Partial<ElectionSourceHost> = {}): ElectionSourceHost => ({ api,
  collection: "cmsPages", documentId: "contact", version: 7, canPublish: true, locked: false, hasUnsavedWork: () => false, ...patch });
function GuardProbe() {
  const guard = useContentQuickEditGuard();
  const [result, setResult] = useState("");
  return <><output aria-label="Source draft dirty">{String(guard.dirty)}</output><button onClick={async () => setResult((await guard.save()).status)}>Exit save</button><output aria-label="Exit outcome">{result}</output></>;
}
function editor(api: ElectionSourceApi, options: { readOnly?: boolean; host?: Partial<ElectionSourceHost>; blocks?: ReturnType<typeof electionBlock>[] } = {}) {
  return render(<MemoryRouter><WorkspaceActionsProvider target={null}><ContentQuickActionsBoundary value={null}>
    <BlockEditor section="genericPage" commandsInline initialBlocks={options.blocks ?? [electionBlock()]} readOnly={options.readOnly}
      electionSourceHost={host(api, options.host)} showSaveAction={false} />
    <GuardProbe />
  </ContentQuickActionsBoundary></WorkspaceActionsProvider></MemoryRouter>);
}
const refresh = async () => { fireEvent.click(await screen.findByRole("button", { name: "Refresh connection" })); };
async function openConfig() { fireEvent.click(await screen.findByRole("button", { name: /^(Connect a source|Edit connection)$/ })); await screen.findByRole("combobox", { name: "Results source" }); }
function chooseRace() { fireEvent.click(screen.getByLabelText("Include New Jersey")); }

describe("shared election source controls", () => {
  it.each([
    { estimate: 0.85, reporting: null, label: "Est. 85% of expected vote counted" },
    { estimate: 0, reporting: null, label: "Est. 0% of expected vote counted" },
    { estimate: undefined, reporting: 75.5, label: "Reporting 75.5%" },
    { estimate: undefined, reporting: null, label: "Reporting share unavailable" },
  ])("shows the exact counted figure for staff review: $label", async ({ estimate, reporting, label }) => {
    const race = electionRace({ reportingShare: reporting, ...(estimate === undefined ? {} : { expectedVoteShare: estimate }) });
    const { api } = transport({ connection: connected({ pendingData: { races: [race] } }) });
    editor(api);
    expect(await screen.findByText(text => text.includes(label))).toBeVisible();
    expect(screen.queryByText(/Reporting unknown%/)).toBeNull();
  });
  it.each([0, 0.85])("leaves estimate %s with the source when copying accepted counts to a manual correction", async expectedVoteShare => {
    const accepted = { races: [electionRace({ expectedVoteShare, reportingShare: null })] };
    const { api } = transport({ connection: connected({ paused: true, lastGoodData: accepted }) });
    function ManualCopyDraft() {
      const [block, setBlock] = useState(electionBlock());
      const value = { ...host(api), connectionStates: new Map([[block.id, false]]), onConnectedChange: vi.fn() };
      const change = (data: Record<string, unknown>) => setBlock({ ...block, data: data as typeof block.data });
      return <ElectionResultsSourceHost.Provider value={value}>
        <ElectionResultsSourceControls block={block} onChange={change} />
        <ElectionResultsEditor block={block} onChange={change} />
        <output aria-label="Manual correction">{JSON.stringify(block.data)}</output>
      </ElectionResultsSourceHost.Provider>;
    }
    render(<MemoryRouter><ContentQuickActionsBoundary value={null}><ManualCopyDraft /></ContentQuickActionsBoundary></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Copy accepted values to manual draft" }));
    const copied = () => JSON.parse(screen.getByLabelText("Manual correction").textContent!);
    expect(copied().races[0]).not.toHaveProperty("expectedVoteShare");
    expect(copied().races[0].candidates).toEqual(accepted.races[0].candidates);
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Reporting share \(%\)/ }), { target: { value: "40" } });
    expect(renderElectionResults("manual", copied())).toContain("40% reporting");
    expect(renderElectionResults("manual", copied())).not.toContain("expected vote counted");
    expect(accepted.races[0].expectedVoteShare).toBe(expectedVoteShare);
    expect(api.mutate).not.toHaveBeenCalled();
  });

  it("mounts before manual visitation in a locked editor and reads only this connection", async () => {
    const { api } = transport({ connection: connected() }); editor(api, { readOnly: true });
    expect(await screen.findByText(/nj-decides public results/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause updates" })).toBeEnabled();
    expect(api.get).toHaveBeenCalledExactlyOnceWith({ collection: "cmsPages", documentId: "contact", blockId: "results-block" }, false, expect.any(AbortSignal));
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it("does not request a connection for an unsaved target", async () => {
    const { api } = transport(); editor(api, { host: { version: undefined } });
    expect(await screen.findByText("Save and publish this results section before connecting a source.")).toBeVisible();
    expect(api.get).not.toHaveBeenCalled();
  });
  it("lets readers inspect holds without mutation controls", async () => {
    const { api } = transport({ canManage: false, connection: connected({ lastHoldReason: { code: "ap-disabled", message: "AP is not configured.", at: "2026-11-04T03:00:00Z" } }) });
    editor(api, { host: { canPublish: false } });
    expect(await screen.findByText("AP is not configured.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Pause updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit connection" })).toBeNull();
  });
  it.each(["approve-once", "counts-auto", "automatic"] as const)("connects explicit roster selection in %s mode without changing the manual draft", async mode => {
    const { api } = transport(); editor(api); await openConfig(); chooseRace();
    fireEvent.change(screen.getByRole("combobox", { name: "Publish mode" }), { target: { value: mode } });
    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ collection: "cmsPages", documentId: "contact", blockId: "results-block" }, { action: "connect", baseVersion: 0, contentVersion: 7,
      config: { ...config, mode, photos: {} } }));
  });
  it("keeps source settings in the exit guard without auto-connecting", async () => {
    const { api } = transport(); editor(api); await openConfig(); chooseRace();
    expect(screen.getByLabelText("Source draft dirty")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "Exit save" }));
    await waitFor(() => expect(screen.getByLabelText("Exit outcome")).toHaveTextContent("unsaved-elsewhere"));
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard source settings" }));
    expect(screen.getByLabelText("Source draft dirty")).toHaveTextContent("false");
  });
  it("requires explicit Sheet and AP mappings and never asks for an API key", async () => {
    const { api } = transport(); editor(api); await openConfig(); chooseRace();
    fireEvent.change(screen.getByRole("combobox", { name: "Results source" }), { target: { value: "sheet" } });
    expect(screen.getByLabelText("Spreadsheet ID")).toHaveValue("");
    expect(screen.getByLabelText("Sheet tab")).toHaveValue("Results");
    expect(screen.getByLabelText("candidate_id")).toHaveValue("candidate_id");
    fireEvent.change(screen.getByRole("combobox", { name: "Results source" }), { target: { value: "ap" } });
    expect(screen.getByLabelText("AP race ID for New Jersey")).toHaveValue("");
    expect(screen.getByLabelText("AP candidate ID for Cory Booker")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AP race ID for New Jersey"), { target: { value: "100" } });
    expect(screen.getByLabelText("AP candidate ID for Cory Booker")).toBeEnabled();
    expect(screen.queryByRole("textbox", { name: /API key/i })).toBeNull();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it("gives a blank new race a descriptive source heading", async () => {
    const { api } = transport(); editor(api, { blocks: [electionBlock(electionRace({ office: "", district: "" }))] });
    expect(await screen.findByRole("region", { name: "Election source: Race 1" })).toBeVisible();
  });
  it("names the source region and reveals an invalid AP field inside a collapsed race", async () => {
    const { api } = transport(); editor(api); await openConfig(); chooseRace();
    expect(screen.getByRole("region", { name: "Election source: U.S. House: District 7" })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Results source" }), { target: { value: "ap" } });
    fireEvent.change(screen.getByLabelText("AP race ID for New Jersey"), { target: { value: "100" } });
    const candidate = screen.getByLabelText("AP candidate ID for Cory Booker");
    const race = candidate.closest("details")!; race.open = false;
    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Complete AP candidate ID for Cory Booker before connecting this source.");
    expect(race.open).toBe(true); expect(candidate).toHaveFocus();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it("stages AP IDs through transient duplicates and race-ID corrections, then validates the submitted map", async () => {
    const candidates = roster.candidates.filter(candidate => candidate.raceId === "us-senate");
    const initial = { ...config, source: { kind: "ap" as const, mapping: { "100": { raceId: "us-senate", candidateIds: Object.fromEntries(candidates.map((candidate, index) => [String(index + 1), candidate.id])) } } } };
    const { api } = transport({ connection: connected({ config: initial }) }); editor(api); await openConfig();
    expect(screen.getByLabelText("Source draft dirty")).toHaveTextContent("false");
    const cory = screen.getByLabelText("AP candidate ID for Cory Booker");
    const justin = screen.getByLabelText("AP candidate ID for Justin Murphy");
    fireEvent.change(cory, { target: { value: "8639" } });
    for (const value of ["8", "86", "863", "8639"]) {
      fireEvent.change(justin, { target: { value } }); expect(justin).toHaveValue(value);
    }
    expect(screen.getByLabelText("Source draft dirty")).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(screen.getByRole("alert")).toHaveTextContent("AP candidate IDs must be unique within New Jersey.");
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.change(justin, { target: { value: "86390" } });
    const race = screen.getByLabelText("AP race ID for New Jersey");
    fireEvent.change(race, { target: { value: "" } });
    expect(cory).toHaveValue("8639"); expect(justin).toHaveValue("86390");
    fireEvent.change(race, { target: { value: "303" } });
    expect(cory).toHaveValue("8639"); expect(justin).toHaveValue("86390");
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(1));
    const request = api.mutate.mock.calls[0][1];
    expect(request).toMatchObject({ action: "connect", config: { source: { mapping: { "303": { raceId: "us-senate",
      candidateIds: { "8639": candidates.find(candidate => candidate.name === "Cory Booker")!.id, "86390": candidates.find(candidate => candidate.name === "Justin Murphy")!.id } } } } } });
    if (request.action === "connect" && request.config.source.kind === "ap") expect(Object.keys(request.config.source.mapping)).toEqual(["303"]);
  });
  it("does not rebase an open settings draft onto a newer unseen connection version", async () => {
    const service = transport({ connection: connected() }); editor(service.api); await openConfig();
    fireEvent.change(screen.getByRole("combobox", { name: "Publish mode" }), { target: { value: "automatic" } });
    service.change({ connection: connected({ version: 2, config: { ...config, mode: "counts-auto" } }) });
    await refresh();
    expect(await screen.findByText(/Another publisher changed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save connection" })).toBeDisabled();
    expect(service.api.mutate).not.toHaveBeenCalled();
  });
  it("keeps staged mappings through a Page/Post conflict and explicitly reviews the newer public binding", async () => {
    const service = transport({ documentVersion: 7, publicData: { races: [electionRace()] } }); editor(service.api);
    await openConfig(); chooseRace();
    fireEvent.change(screen.getByRole("combobox", { name: "Results source" }), { target: { value: "sheet" } });
    fireEvent.change(screen.getByLabelText("Spreadsheet ID"), { target: { value: "synthetic-retained-sheet" } });
    service.api.mutate.mockRejectedValueOnce(new HttpError(409, "This Page/Post changed"));
    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
    await screen.findByText("This Page/Post changed");
    service.change({ documentVersion: 8, publicData: { races: [electionRace({ office: "Current public office" })] } });
    await refresh();
    expect(await screen.findByText(/Current public office/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect source" })).toBeDisabled();
    expect(screen.getByLabelText("Spreadsheet ID")).toHaveValue("synthetic-retained-sheet");
    fireEvent.click(screen.getByRole("button", { name: "Use saved Page/Post revision" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
    await waitFor(() => expect(service.api.mutate).toHaveBeenCalledTimes(2));
    expect(service.api.mutate.mock.calls[1][1]).toMatchObject({ contentVersion: 8, config: { source: { spreadsheetId: "synthetic-retained-sheet" } } });
  });
  it("keeps manual draft entry available when the optional connection read fails", async () => {
    const { api } = transport(); api.get.mockRejectedValue(new HttpError(500, "Connection unavailable")); editor(api);
    await screen.findByText("Connection unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Edit election results 1" }));
    expect(await screen.findByRole("textbox", { name: "Office" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add race" })).toBeEnabled();
    expect(screen.getByText(/connection has not been confirmed/)).toBeVisible();
    expect(api.mutate).not.toHaveBeenCalled();
  });
  it("locks manual fields and Add race only for a known enabled source", async () => {
    const { api } = transport({ connection: connected() }); editor(api);
    await screen.findByRole("button", { name: "Pause updates" });
    fireEvent.click(screen.getByRole("button", { name: "Edit election results 1" }));
    expect(await screen.findByRole("textbox", { name: "Office" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add race" })).toBeDisabled();
  });
  it("reviews the exact pending digest with complete attribution and exposes visible mutation progress", async () => {
    const before = electionRace(); const pending = electionRace({ status: "called", sourceKind: "ap", sourceLabel: "AP", sourceUrl: "https://apnews.com/", calledCandidateId: "ellis", apCallUrl: "https://apnews.com/call" });
    const { api } = transport({ connection: connected({ config: { ...config, mode: "counts-auto" }, authorizedConfigRevision: 1,
      lastGoodData: { races: [before] }, pendingData: { races: [pending] }, pendingStatuses: [pending.id], pendingDigest: "d".repeat(64) }) });
    let complete!: (value: { connection: ElectionSourceConnection }) => void;
    api.mutate.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    editor(api); const button = await screen.findByRole("button", { name: "Approve status changes" });
    expect(screen.getByRole("link", { name: "Pending AP call attribution" })).toHaveAttribute("href", "https://apnews.com/call");
    expect(screen.getByText(/Accepted status: counting; pending: called/)).toBeVisible();
    expect(screen.getAllByText(/Jordan Ellis: 620 \(62%\)/).some(element => element.closest("details")?.open)).toBe(true);
    fireEvent.click(button); fireEvent.click(button);
    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Saving the connection…")).toBeVisible();
    expect(api.mutate.mock.calls[0][1]).toEqual({ action: "status", baseVersion: 1, pendingDigest: "d".repeat(64) });
        const approved = connected({ ...connected({ config: { ...config, mode: "counts-auto" }, authorizedConfigRevision: 1,
      lastGoodData: { races: [before] }, pendingData: { races: [pending] }, pendingStatuses: [pending.id], pendingDigest: "d".repeat(64) }), version: 2 });
    await act(async () => complete({ connection: approved }));
    expect(screen.queryByRole("button", { name: "Approve status changes" })).toBeNull();
    expect(screen.getByText("Approved status changes awaiting the next source check")).toBeVisible();
    api.get.mockResolvedValue({ connection: approved, canConnect: true, canManage: true });
    await refresh();
    expect(screen.queryByRole("button", { name: "Approve status changes" })).toBeNull();
  });
  it("approves a reviewed link using the current configuration version even with an unrelated draft", async () => {
    const { api } = transport({ connection: connected({ pendingData: { races: [electionRace()] } }) });
    editor(api, { host: { hasUnsavedWork: () => true } });
    fireEvent.click(await screen.findByRole("button", { name: "Approve link" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledExactlyOnceWith({ collection: "cmsPages", documentId: "contact", blockId: "results-block" }, { action: "approve", baseVersion: 1 }));
  });
  it("keeps a failed mutation for explicit review and does not silently retry a conflict", async () => {
    const { api } = transport({ connection: connected() }); api.mutate.mockRejectedValueOnce(new HttpError(409, "Connection changed"));
    editor(api); fireEvent.click(await screen.findByRole("button", { name: "Pause updates" }));
    expect(await screen.findByText("Connection changed")).toBeVisible();
    expect(screen.getByText(/Refresh the connection and review/)).toBeVisible();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });
  it.each(["page", "post"] as const)("allows emergency pause when another editor holds the %s lock", async kind => {
    const { api } = transport({ connection: connected() });
    const lock = { surfaceKey: kind === "page" ? "cmsPages:contact" : "cmsPosts:post-lock", ownerId: "colleague", ownerName: "Colleague", sessionId: "remote", acquiredAtMs: Date.now(), heartbeatAtMs: Date.now(), observedAtMs: performance.now() };
    const locks = { subscribe: vi.fn((_key, onLock) => { onLock(lock); return () => {}; }), claim: vi.fn(async () => ({ status: "blocked" as const, lock })),
      heartbeat: vi.fn(async () => false), release: vi.fn(async () => {}), requestTakeover: vi.fn(async () => false), clearRequest: vi.fn(async () => {}) } satisfies import("../src/lib/editor-locks").EditorLockClient;
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><EditorWorkspace principal={{ id: "admin", grants: [{ role: "admin" }] }}
      editorLockActor={{ id: "admin", name: "Publisher" }} editorLockClient={locks}
      surface={kind === "page" ? { kind: "page", pageId: "contact", section: "genericPage" } : { kind: "record", record: "post", id: "post-lock" }} electionSources={api}
      loadRecord={async () => ({ status: "ready", record: { id: "post-lock", type: "post", section: "news", title: "Results", blocks: [electionBlock()], version: 7, status: "approved" } })}
      loadPage={async () => ({ blocks: [electionBlock()], version: 7, status: "approved", metadata: { title: "Contact" } })} /></WorkspaceActionsProvider></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Edit connection" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Pause updates" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledExactlyOnceWith({ collection: kind === "page" ? "cmsPages" : "cmsPosts", documentId: kind === "page" ? "contact" : "post-lock", blockId: "results-block" }, { action: "pause", baseVersion: 1 }));
    expect(await screen.findByRole("button", { name: "Resume updates" })).toBeDisabled();
    expect(screen.queryByRole("textbox", { name: "Page title" })).toBeNull();
    expect(locks.claim).not.toHaveBeenCalled();
  });
  it("allows emergency pause with unrelated unsaved work and blocks resume until that work is settled", async () => {
    const { api } = transport({ connection: connected() }); editor(api, { host: { hasUnsavedWork: () => true } });
    fireEvent.click(await screen.findByRole("button", { name: "Pause updates" }));
    expect(await screen.findByRole("button", { name: "Resume updates" })).toBeDisabled();
    expect(api.mutate).toHaveBeenCalledExactlyOnceWith({ collection: "cmsPages", documentId: "contact", blockId: "results-block" }, { action: "pause", baseVersion: 1 });
  });
  it("retains source controls for hidden and removed draft sections that remain public", async () => {
    const { api } = transport({ connection: connected() }); editor(api, { blocks: [], host: { publicBlocks: [electionBlock()] } });
    expect(await screen.findByText(/removed in the draft/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Pause updates" })).toBeEnabled();
  });
  it("uses the saved Page identity and version from its workspace owner", async () => {
    const { api } = transport();
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><EditorWorkspace principal={{ id: "admin", grants: [{ role: "admin" }] }}
      surface={{ kind: "page", pageId: "contact", section: "genericPage" }} electionSources={api}
      loadPage={async () => ({ blocks: [electionBlock()], version: 11, status: "approved", metadata: { title: "Contact" } })} /></WorkspaceActionsProvider></MemoryRouter>);
    await screen.findByRole("button", { name: "Connect a source" });
    let complete!: (result: { connection: ElectionSourceConnection }) => void;
    api.mutate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await openConfig(); chooseRace(); fireEvent.click(screen.getByRole("button", { name: "Connect source" }));
    expect(await screen.findByText("Updating the election source connection")).toBeVisible();
    expect(screen.queryByText("Restoring this version")).toBeNull();
    await waitFor(() => expect(api.mutate.mock.calls[0]?.[1]).toMatchObject({ contentVersion: 11 }));
    expect(api.get.mock.calls[0][0]).toEqual({ collection: "cmsPages", documentId: "contact", blockId: "results-block" });
    await act(async () => complete({ connection: connected() }));
  });
  it("retains a removed public connection after switching away from an unsaved metadata draft", async () => {
    const { api } = transport({ connection: connected() });
    function SwitchingWorkspace() {
      const [pageId, setPageId] = useState<"contact" | "about">("contact");
      return <><button onClick={() => setPageId("about")}>Other page</button><button onClick={() => setPageId("contact")}>Return to contact</button>
        <EditorWorkspace principal={{ id: "admin", grants: [{ role: "admin" }] }} surface={{ kind: "page", pageId, section: "genericPage" }} electionSources={api}
          loadPage={async id => ({ blocks: [], publishedElectionBlocks: id === "contact" ? [electionBlock()] : [], version: 7, status: "draft", metadata: { title: id } })} />
      </>;
    }
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><SwitchingWorkspace /></WorkspaceActionsProvider></MemoryRouter>);
    await screen.findByRole("button", { name: "Pause updates" });
    fireEvent.change(screen.getByRole("textbox", { name: "Page title" }), { target: { value: "Unsaved contact title" } });
    fireEvent.click(screen.getByRole("button", { name: "Other page" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Pause updates" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Return to contact" }));
    expect(await screen.findByRole("button", { name: "Pause updates" })).toBeEnabled();
    expect(screen.getByText(/removed in the draft/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Page title" })).toHaveValue("Unsaved contact title");
  });
  it("resumes the active Page source while a different Page retains an unsaved title", async () => {
    const { api } = transport({ connection: connected({ paused: true }) });
    function SwitchingWorkspace() {
      const [pageId, setPageId] = useState<"contact" | "about">("contact");
      return <><button onClick={() => setPageId("about")}>Other page</button><button onClick={() => setPageId("contact")}>Return to contact</button>
        <EditorWorkspace principal={{ id: "admin", grants: [{ role: "admin" }] }} surface={{ kind: "page", pageId, section: "genericPage" }} electionSources={api}
          loadPage={async id => ({ blocks: id === "about" ? [electionBlock()] : [], version: 7, status: "draft", metadata: { title: id } })} />
      </>;
    }
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><SwitchingWorkspace /></WorkspaceActionsProvider></MemoryRouter>);
    fireEvent.change(await screen.findByRole("textbox", { name: "Page title" }), { target: { value: "Unsaved contact title" } });
    fireEvent.click(screen.getByRole("button", { name: "Other page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume updates" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledExactlyOnceWith({ collection: "cmsPages", documentId: "about", blockId: "results-block" }, { action: "resume", baseVersion: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Return to contact" }));
    expect(await screen.findByRole("textbox", { name: "Page title" })).toHaveValue("Unsaved contact title");
  });
  it("uses the live saved Post identity while manual fields are lifecycle locked", async () => {
    const { api } = transport({ connection: connected() });
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><RecordForm kind="post" canSave initialIsClean readOnly
      initial={{ id: "post-canonical", version: 13, title: "Results", type: "post", section: "news", status: "approved", blocks: [electionBlock()] }}
      electionSourceHost={{ ...host(api), collection: "cmsPosts" }} /></WorkspaceActionsProvider></MemoryRouter>);
    expect(await screen.findByRole("button", { name: "Pause updates" })).toBeEnabled();
    expect(api.get.mock.calls[0][0]).toEqual({ collection: "cmsPosts", documentId: "post-canonical", blockId: "results-block" });
  });
  it("adopts the server-minted Post and block identities before reading a connection", async () => {
    const { api } = transport({ canConnect: false });
    const onSave = vi.fn(async (record: Record<string, unknown>) => ({ kind: "record-save-receipt" as const,
      document: { ...record, id: "post-adopted", version: 21, blocks: [{ ...electionBlock(), id: "results-adopted" }] },
      mintedIds: { "results-block": "results-adopted" } }));
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><RecordForm kind="post" canSave onSave={onSave}
      initial={{ title: "Election update", date: "2026-11-03", section: "news", tags: [], blocks: [electionBlock()] }}
      electionSourceHost={{ ...host(api), collection: "cmsPosts" }} /></WorkspaceActionsProvider></MemoryRouter>);
    await screen.findByText("Save and publish this results section before connecting a source.");
    expect(api.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith({ collection: "cmsPosts", documentId: "post-adopted", blockId: "results-adopted" }, false, expect.any(AbortSignal)));
    expect(api.get.mock.calls.every(([target]) => target.documentId === "post-adopted" && target.blockId === "results-adopted")).toBe(true);
  });
  it("aborts and ignores a late connection response for the previous document", async () => {
    const { api } = transport();
    let complete!: (value: ElectionSourceState) => void;
    api.get.mockImplementation((target) => target.documentId === "contact" ? new Promise(resolve => { complete = resolve; })
      : Promise.resolve({ connection: null, canManage: true, canConnect: true }));
    function ChangingTarget() {
      const [id, setId] = useState("contact");
      return <><button onClick={() => setId("about")}>Switch target</button><BlockEditor section="genericPage" initialBlocks={[electionBlock()]} commandsInline electionSourceHost={host(api, { documentId: id })} /></>;
    }
    render(<MemoryRouter><WorkspaceActionsProvider target={null}><ChangingTarget /></WorkspaceActionsProvider></MemoryRouter>);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    const oldSignal = api.get.mock.calls[0][2];
    fireEvent.click(screen.getByRole("button", { name: "Switch target" }));
    await screen.findByText(/No source connected/);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => complete({ connection: connected({ lastHoldReason: { code: "old", message: "Previous document hold", at: "2026-11-04T03:00:00Z" } }), canManage: true, canConnect: true }));
    expect(screen.queryByText("Previous document hold")).toBeNull();
    expect(screen.getByText(/No source connected/)).toBeVisible();
  });
});
