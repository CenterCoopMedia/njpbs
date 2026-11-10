import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { useSourceMediaBulkEditing } from "../src/components/SourceMediaBulkEditor";
import { MediaFavoriteButton } from "../src/components/MediaFavoriteButton";
import { useMediaFavorites } from "../src/lib/use-media-favorites";
import { useFavoriteUndo } from "../src/lib/use-favorite-undo";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { setPageSelection } from "../src/lib/media-selection";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";
import type { MediaSourceSummary, SourceMediaAssetSummary } from "../src/lib/source-media";

const source: MediaSourceSummary = { id: "video-library", label: "Videos", description: "", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false };
const records: SourceMediaAssetSummary[] = ["One", "Two"].map((name, i) => ({
  id: `video-${i + 1}`, sourceId: source.id, name, originalName: `${name}.mp4`, description: null, mimeType: "video/mp4", kind: "video", sizeBytes: 10,
  preview: "download_only", license: null, credit: null, tags: [], rightsStatus: "pending", version: 1, createdAt: null, updatedAt: null,
}));
const refs: MediaFavoriteRef[] = records.map(asset => ({ backend: "s3", sourceId: asset.sourceId, id: asset.id }));
const token = async () => "fixture-a";
function Harness({ userId = "a", getIdToken = token }: { userId?: string; getIdToken?: () => Promise<string> }) {
  const favorites = useMediaFavorites(userId, refs, getIdToken);
  const undo = useFavoriteUndo(userId, favorites);
  const bulk = useSourceMediaBulkEditing({ source, userId, records, favorites, getIdToken, disabled: false, onRefresh: () => undefined });
  return <>
    <button onClick={() => bulk.changeSelection(setPageSelection(bulk.selection, records, true, bulk.rules))}>Select both</button>
    {refs.map((ref, index) => <MediaFavoriteButton key={ref.id} name={records[index].name} favorite={favorites.value(ref)} pending={favorites.pending(ref)} onToggle={() => void undo.toggle(ref, records[index].name)} />)}
    {bulk.notice}{bulk.bar}
  </>;
}
const view = (props: Parameters<typeof Harness>[0] = {}) => <MemoryRouter><Harness {...props} /></MemoryRouter>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
let requests: { endpoint: string; body: any }[];
let states: Map<string, boolean>;
let batch: (body: { refs: MediaFavoriteRef[]; favorite: boolean }) => Promise<Response>;

beforeEach(() => {
  requests = [];
  states = new Map();
  batch = async body => json({ success: true, favorite: body.favorite, results: body.refs.map(ref => {
    const changed = states.get(ref.id) !== body.favorite;
    states.set(ref.id, body.favorite);
    return { ref, favorite: body.favorite, changed };
  }) });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body));
    requests.push({ endpoint, body });
    if (endpoint === "cmsListMediaFavorites") return json({ success: true, states: body.refs.map((ref: MediaFavoriteRef) => ({ ref, favorite: states.get(ref.id) ?? false })) });
    if (endpoint === "cmsSetMediaFavorites") return batch(body);
    if (endpoint === "cmsSetMediaFavorite") {
      states.set(body.ref.id, body.favorite);
      return json({ success: true, ref: body.ref, favorite: body.favorite, changed: true });
    }
    throw new Error(`Unexpected HTTP request ${endpoint}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const bar = () => screen.getByRole("group", { name: "Video selection" });
async function selectBoth() {
  await screen.findByRole("button", { name: "Add to favorites: One" });
  fireEvent.click(screen.getByRole("button", { name: "Select both" }));
}

describe("video batch favorites over the HTTP contract", () => {
  it("announces batch feedback through the shell without a second inline live region", async () => {
    const pending = deferred<Response>(); batch = () => pending.promise;
    render(<MemoryRouter><SuccessNoticeProvider routeKey="a"><Harness /></SuccessNoticeProvider></MemoryRouter>);
    const notifications = screen.getByRole("region", { name: "Notifications" });
    const announcement = notifications.querySelector("[aria-live]");
    await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await waitFor(() => expect(announcement).toHaveTextContent("Saving favorites."));
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => pending.resolve(json({ success: true, favorite: true, results: refs.map(ref => ({ ref, favorite: true, changed: true })) })));
    await waitFor(() => expect(announcement).toHaveTextContent("Added 2 to favorites."));
    expect(screen.queryByRole("status")).toBeNull();

    batch = async () => { throw new TypeError("Connection lost"); };
    fireEvent.click(screen.getByRole("button", { name: "Select both" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Remove from favorites" }));
    await waitFor(() => expect(announcement).toHaveTextContent("The favorite changes were not confirmed."));
    expect(announcement).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("replaces a previous single-item Undo before the batch starts", async () => {
    const pending = deferred<Response>(); batch = () => pending.promise;
    render(<MemoryRouter><SuccessNoticeProvider routeKey="a"><Harness /></SuccessNoticeProvider></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: One" }));
    await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(screen.getByRole("button", { name: "Select both" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await act(async () => pending.resolve(json({ success: true, favorite: true, results: refs.map(ref => ({ ref, favorite: true, changed: true })) })));
    expect(requests.filter(r => r.endpoint === "cmsSetMediaFavorite")).toHaveLength(1);
  });

  it("adds and removes a read-only source selection in one batch and one projection per action", async () => {
    render(view()); await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await screen.findByText("Added 2 to favorites.");
    await screen.findByRole("button", { name: "Remove from favorites: One" });
    expect(screen.queryByRole("group", { name: "Video selection" })).toBeNull();
    expect(requests).toEqual([
      { endpoint: "cmsListMediaFavorites", body: { refs } },
      { endpoint: "cmsSetMediaFavorites", body: { refs, favorite: true } },
      { endpoint: "cmsListMediaFavorites", body: { refs } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Select both" }));
    fireEvent.click(within(bar()).getByRole("button", { name: "Remove from favorites" }));
    await screen.findByText("Removed 2 from favorites.");
    await screen.findByRole("button", { name: "Add to favorites: One" });
    expect(requests.filter(r => r.endpoint === "cmsSetMediaFavorites").at(-1)?.body).toEqual({ refs, favorite: false });
  });

  it("retains only failed items for retry and locks overlapping actions while saving", async () => {
    const pending = deferred<Response>(); batch = () => pending.promise;
    render(view()); await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await screen.findByText("Saving favorites…");
    expect(within(bar()).getByRole("button", { name: "Remove from favorites" })).toBeDisabled();
    expect(within(bar()).getByRole("button", { name: "Clear selection" })).toBeDisabled();
    await act(async () => pending.resolve(json({ success: true, favorite: true, results: [
      { ref: refs[0], favorite: true, changed: false },
      { ref: refs[1], error: "Unavailable", status: 404 },
    ] })));
    await screen.findByText(/1 already a favorite.*1 could not be changed/);
    batch = async body => json({ success: true, favorite: true, results: body.refs.map(ref => ({ ref, favorite: true, changed: true })) });
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await screen.findByText("Added 1 to favorites.");
    expect(requests.filter(r => r.endpoint === "cmsSetMediaFavorites").at(-1)?.body.refs).toEqual([refs[1]]);
  });

  it("reconciles an ambiguous response and leaves the whole selection retryable", async () => {
    batch = async () => { states.set(refs[0].id, true); throw new TypeError("Connection lost"); };
    render(view()); await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await screen.findByText(/changes were not confirmed/);
    await screen.findByRole("button", { name: "Remove from favorites: One" });
    expect(within(bar()).getByText(/2/)).toBeInTheDocument();
    expect(within(bar()).getByRole("button", { name: "Add to favorites" })).toBeEnabled();
  });

  it("does not dispatch an old selection after account change during token lookup", async () => {
    const pendingToken = deferred<string>();
    let lookup = 0;
    const getIdToken = () => ++lookup === 1 ? token() : pendingToken.promise;
    const current = render(view({ getIdToken })); await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    current.rerender(view({ userId: "b" }));
    await act(async () => pendingToken.resolve("fixture-b"));
    await screen.findByRole("button", { name: "Add to favorites: One" });
    expect(requests.filter(r => r.endpoint === "cmsSetMediaFavorites")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Video selection" })).toBeNull();
  });

  it("ignores a late batch response after an account switch", async () => {
    const pending = deferred<Response>(); batch = () => pending.promise;
    const current = render(view()); await selectBoth();
    fireEvent.click(within(bar()).getByRole("button", { name: "Add to favorites" }));
    await waitFor(() => expect(requests.some(r => r.endpoint === "cmsSetMediaFavorites")).toBe(true));
    current.rerender(view({ userId: "b" }));
    await screen.findByRole("button", { name: "Add to favorites: One" });
    const reads = requests.length;
    await act(async () => pending.resolve(json({ success: true, favorite: true, results: refs.map(ref => ({ ref, favorite: true, changed: true })) })));
    expect(requests).toHaveLength(reads);
    expect(screen.queryByText("Favorites updated")).toBeNull();
    expect(screen.getByRole("button", { name: "Add to favorites: One" })).toBeEnabled();
  });
});
