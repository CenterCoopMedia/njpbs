import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaCollectionPicker } from "../src/components/MediaCollectionPicker";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import type { MediaCollectionScope, MediaCollectionSummary } from "../src/lib/media-collections";
import { HttpError } from "../src/lib/functions";

const mocks = vi.hoisted(() => ({ list: vi.fn(), setItems: vi.fn() }));
vi.mock("../src/lib/media-collections", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/media-collections")>()),
  listMediaCollections: (...args: unknown[]) => mocks.list(...args),
  setMediaCollectionItems: (...args: unknown[]) => mocks.setItems(...args),
}));

const ids = { private: "a".repeat(64), shared: "b".repeat(64) };
function collection(scope: MediaCollectionScope): MediaCollectionSummary {
  return {
    id: ids[scope === "private" ? "private" : "shared"],
    scope,
    name: scope === "private" ? "My package" : "Election package",
    description: "",
    lifecycle: "active",
    version: 1,
    membershipVersion: scope === "private" ? 4 : 7,
    cover: null,
    canEdit: true,
    createdAt: null,
    updatedAt: null,
    itemCount: 0,
  };
}

function page(scope: MediaCollectionScope) {
  return { success: true as const, collections: [collection(scope)], nextCursor: null, hasMore: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const refs = [
  { backend: "r2" as const, id: "image-1" },
  { backend: "s3" as const, sourceId: "video-library", id: "video-1" },
];

function setViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*61\.99rem/.test(query) ? width < 992 : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setViewport(1280);
  mocks.list.mockImplementation(async (_token: string, query: { scope: MediaCollectionScope }) => page(query.scope));
  mocks.setItems.mockResolvedValue({
    success: true,
    collectionId: ids.shared,
    changed: true,
    replayed: false,
    version: 1,
    membershipVersion: 8,
  });
});

describe("MediaCollectionPicker", () => {
  it("loads one page per scope and adds a mixed selection with one bounded request", async () => {
    const onAdded = vi.fn();
    render(<MediaCollectionPicker open userId="staff-a" refs={refs} getIdToken={async () => "token-a"}
      onClose={vi.fn()} onAdded={onAdded} onOpenCollections={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: /Election package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));

    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(1));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.setItems).toHaveBeenCalledWith("token-a", expect.objectContaining({
      collectionId: ids.shared,
      baseMembershipVersion: 7,
      present: true,
      refs,
    }));
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: ids.shared, membershipVersion: 8 }));
  });

  it("reuses the request identity after an unconfirmed write", async () => {
    mocks.setItems.mockRejectedValueOnce(new Error("Connection closed before a response was received"));
    render(<MediaCollectionPicker open userId="staff-a" refs={[refs[0]]} getIdToken={async () => "token-a"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    expect(await screen.findByText("Connection closed before a response was received")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(2));

    const firstRequest = mocks.setItems.mock.calls[0][1] as { requestId: string };
    const retryRequest = mocks.setItems.mock.calls[1][1] as { requestId: string };
    expect(retryRequest.requestId).toBe(firstRequest.requestId);
  });

  it("reloads an authoritative conflict and requires a current selection", async () => {
    mocks.setItems.mockRejectedValueOnce(new HttpError(409, "Conflict"));
    render(<MediaCollectionPicker open userId="staff-a" refs={[refs[0]]} getIdToken={async () => "token-a"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    expect(await screen.findByText(/Current collections were reloaded/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("button", { name: "Add to collection" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /My package/ })).not.toBeChecked();
  });

  it("drops list results from the prior account", async () => {
    const oldPrivate = deferred<ReturnType<typeof page>>();
    const oldShared = deferred<ReturnType<typeof page>>();
    mocks.list.mockImplementation((token: string, query: { scope: MediaCollectionScope }) => {
      if (token === "token-a") return query.scope === "private" ? oldPrivate.promise : oldShared.promise;
      return Promise.resolve({ ...page(query.scope), collections: [{ ...collection(query.scope), name: `New ${query.scope}` }] });
    });
    const view = render(<MediaCollectionPicker open userId="staff-a" refs={refs} getIdToken={async () => "token-a"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);

    view.rerender(<MediaCollectionPicker open userId="staff-b" refs={refs} getIdToken={async () => "token-b"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: /New private/ })).toBeInTheDocument();
    await act(async () => {
      oldPrivate.resolve(page("private"));
      oldShared.resolve(page("all_staff"));
    });
    expect(screen.queryByRole("radio", { name: /^My package/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /New all_staff/ })).toBeInTheDocument();
  });

  it("does not dispatch a selected write after the account changes during authentication", async () => {
    const pendingToken = deferred<string>();
    const tokenA = vi.fn()
      .mockResolvedValueOnce("token-a")
      .mockResolvedValueOnce("token-a")
      .mockReturnValueOnce(pendingToken.promise);
    const view = render(<MediaCollectionPicker open userId="staff-a" refs={refs} getIdToken={tokenA}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(tokenA).toHaveBeenCalledTimes(3));

    view.rerender(<MediaCollectionPicker open userId="staff-b" refs={refs} getIdToken={async () => "token-b"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />);
    await act(async () => pendingToken.resolve("token-a"));
    expect(mocks.setItems).not.toHaveBeenCalled();
  });

  it.each([1280, 390])("offers one exact reverse request after a confirmed add at %ipx", async width => {
    setViewport(width);
    mocks.setItems
      .mockResolvedValueOnce({
        success: true, collectionId: ids.shared, changed: true, replayed: false,
        version: 1, membershipVersion: 8, changedRefs: [refs[1]],
      })
      .mockResolvedValueOnce({
        success: true, collectionId: ids.shared, changed: true, replayed: false,
        version: 1, membershipVersion: 9, changedRefs: [refs[1]],
      });
    render(<SuccessNoticeProvider routeKey="staff-a:route-a">
      <MediaCollectionPicker open userId="staff-a" refs={refs} getIdToken={async () => "token-a"}
        onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />
    </SuccessNoticeProvider>);

    fireEvent.click(await screen.findByRole("radio", { name: /Election package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    fireEvent.click(undo);

    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(2));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    const first = mocks.setItems.mock.calls[0][1] as { requestId: string };
    expect(mocks.setItems.mock.calls[1][1]).toEqual(expect.objectContaining({
      collectionId: ids.shared,
      baseMembershipVersion: 8,
      present: false,
      refs: [refs[1]],
    }));
    expect(mocks.setItems.mock.calls[1][1].requestId).not.toBe(first.requestId);
    expect(await screen.findAllByText("1 item removed from Election package.")).toHaveLength(2);
  });

  it.each([
    ["a legacy response", { changed: true, replayed: false }],
    ["a replayed response", { changed: true, replayed: true, changedRefs: [refs[0]] }],
    ["an unchanged response", { changed: false, replayed: false, changedRefs: [] }],
  ])("does not offer Undo for %s", async (_label, state) => {
    mocks.setItems.mockResolvedValueOnce({
      success: true, collectionId: ids.private, version: 1, membershipVersion: 5, ...state,
    });
    render(<SuccessNoticeProvider routeKey="staff-a:route-a">
      <MediaCollectionPicker open userId="staff-a" refs={[refs[0]]} getIdToken={async () => "token-a"}
        onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />
    </SuccessNoticeProvider>);

    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("expires an add Undo on an account or route change", async () => {
    mocks.setItems.mockResolvedValueOnce({
      success: true, collectionId: ids.private, changed: true, replayed: false,
      version: 1, membershipVersion: 5, changedRefs: [refs[0]],
    });
    const picker = <MediaCollectionPicker open userId="staff-a" refs={[refs[0]]} getIdToken={async () => "token-a"}
      onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />;
    const view = render(<SuccessNoticeProvider routeKey="staff-a:route-a">{picker}</SuccessNoticeProvider>);
    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();

    view.rerender(<SuccessNoticeProvider routeKey="staff-b:route-b">{picker}</SuccessNoticeProvider>);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
    expect(mocks.setItems).toHaveBeenCalledOnce();
  });

  it("consumes a conflicting Undo without retrying", async () => {
    mocks.setItems
      .mockResolvedValueOnce({
        success: true, collectionId: ids.private, changed: true, replayed: false,
        version: 1, membershipVersion: 5, changedRefs: [refs[0]],
      })
      .mockRejectedValueOnce(new HttpError(409, "Conflict"));
    render(<SuccessNoticeProvider routeKey="staff-a:route-a">
      <MediaCollectionPicker open userId="staff-a" refs={[refs[0]]} getIdToken={async () => "token-a"}
        onClose={vi.fn()} onAdded={vi.fn()} onOpenCollections={vi.fn()} />
    </SuccessNoticeProvider>);
    fireEvent.click(await screen.findByRole("radio", { name: /My package/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText(/changed before Undo/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(mocks.setItems).toHaveBeenCalledTimes(2);
  });
});
