import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNavigationShares } from "../src/lib/navigation-shares-store";

const firestoreMock = vi.hoisted(() => ({
  onSnapshot: vi.fn(),
  collection: vi.fn((_db: unknown, name: string) => ({ kind: "collection", name })),
  query: vi.fn((...parts: unknown[]) => ({ kind: "query", parts })),
  where: vi.fn((field: unknown, op: unknown, value: unknown) => ({ kind: "where", field, op, value })),
  documentId: vi.fn(() => "__name__"),
  getDocs: vi.fn(async () => ({ forEach(_visit: (entry: { id: string; data: () => unknown }) => void) {} })),
}));

vi.mock("firebase/firestore", () => ({
  limit: (count: number) => ({ limit: count }),
  collection: firestoreMock.collection,
  documentId: firestoreMock.documentId,
  getDocs: firestoreMock.getDocs,
  onSnapshot: firestoreMock.onSnapshot,
  query: firestoreMock.query,
  where: firestoreMock.where,
}));

vi.mock("../src/lib/firebase", () => ({ db: { app: "test" } }));

const notes = {
  ownerUid: "ed",
  ownerName: "Sample editor",
  status: "active",
  item: {
    id: "custom:notes",
    kind: "link",
    label: "Desk notes",
    icon: "link",
    destination: { kind: "url", url: "https://example.test/notes" },
  },
  updatedAt: { seconds: 1, nanoseconds: 0 },
};

const retired = {
  ownerUid: "ed",
  ownerName: "Sample editor",
  status: "removed",
  removedReason: "unshared",
  item: {
    id: "custom:retired",
    kind: "link",
    label: "Old bulletin",
    icon: "link",
    destination: { kind: "url", url: "https://example.test/old" },
  },
};

const desk = {
  ownerUid: "ed",
  ownerName: "Sample editor",
  status: "active",
  item: {
    id: "custom:desk",
    kind: "section",
    label: "Desk",
    icon: "folder",
    links: [
      {
        id: "custom:child-a",
        kind: "link",
        label: "Child A",
        icon: "link",
        destination: { kind: "url", url: "https://example.test/a" },
      },
      {
        id: "custom:child-b",
        kind: "link",
        label: "Child B",
        icon: "link",
        destination: { kind: "url", url: "https://example.test/b" },
      },
    ],
  },
  updatedAt: { seconds: 1, nanoseconds: 0 },
};

function Probe({ ids = [] }: { ids?: readonly string[] }) {
  const state = useNavigationShares(undefined, true, ids);
  return <p>{`${state.ready ? "ready" : "not-ready"}:${state.shares.map((share) => share.id).join(",")}`}</p>;
}

describe("navigation shares listener", () => {
  it("reloads settled tombstones after recovering from a share-list overflow", async () => {
    type Snapshot = { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void };
    let deliver: (snapshot: Snapshot) => void = () => {};
    firestoreMock.onSnapshot.mockImplementation((_query, next) => { deliver = next; return vi.fn(); });
    firestoreMock.getDocs.mockResolvedValue({ forEach(visit) {
      visit({ id: "custom:retired", data: () => retired });
    } });
    const view = render(<Probe ids={["custom:retired"]} />);
    await act(async () => deliver({ forEach() {} }));
    expect(screen.getByText("ready:custom:retired", { exact: true })).toBeInTheDocument();
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);
    act(() => deliver({ forEach(visit) {
      for (let index = 0; index < 501; index += 1) visit({ id: `share-${index}`, data: () => notes });
    } }));
    await act(async () => deliver({ forEach() {} }));
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("ready:custom:retired", { exact: true })).toBeInTheDocument();
    view.unmount();
  });
  it("restarts a tombstone lookup after a share-list overflow invalidates it", async () => {
    type Snapshot = { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void };
    let deliver: (snapshot: Snapshot) => void = () => {};
    let release: (snapshot: Snapshot) => void = () => {};
    firestoreMock.onSnapshot.mockImplementation((_query, next) => { deliver = next; return vi.fn(); });
    const tombstones: Snapshot = { forEach(visit) { visit({ id: "custom:retired", data: () => retired }); } };
    firestoreMock.getDocs.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue(tombstones);
    const view = render(<Probe ids={["custom:retired"]} />);
    act(() => deliver({ forEach() {} }));
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);
    act(() => deliver({ forEach(visit) {
      for (let index = 0; index < 501; index += 1) visit({ id: `share-${index}`, data: () => notes });
    } }));
    await act(async () => release(tombstones));
    await act(async () => deliver({ forEach() {} }));
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("ready:custom:retired", { exact: true })).toBeInTheDocument();
    view.unmount();
  });
  it("keeps an oversized shared list unavailable instead of showing a partial list", () => {
    firestoreMock.onSnapshot.mockImplementation((_query, next) => {
      next({ forEach(visit: (row: unknown) => void) {
        for (let index = 0; index < 501; index += 1) visit({ id: `share-${index}`, data: () => notes });
      } });
      return vi.fn();
    });
    render(<Probe />);
    expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
  });
  afterEach(() => {
    firestoreMock.onSnapshot.mockReset();
    firestoreMock.getDocs.mockReset();
    firestoreMock.query.mockClear();
    firestoreMock.where.mockClear();
    firestoreMock.documentId.mockClear();
  });

  it("keeps the last shares and marks the list not ready when the listener fails", () => {
    const stop = vi.fn();
    let onNext: (snapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void = () => undefined;
    let onError: () => void = () => undefined;
    firestoreMock.onSnapshot.mockImplementation((_query, next, error) => {
      onNext = next;
      onError = error;
      return stop;
    });

    const view = render(<Probe />);
    expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
    act(() => {
      onNext({
        forEach(visit) {
          visit({ id: "custom:notes", data: () => notes });
        },
      });
    });
    expect(screen.getByText("ready:custom:notes", { exact: true })).toBeInTheDocument();
    expect(firestoreMock.getDocs).not.toHaveBeenCalled();
    expect(firestoreMock.where).toHaveBeenCalledWith("status", "==", "active");
    act(() => onError());
    expect(screen.getByText("not-ready:custom:notes", { exact: true })).toBeInTheDocument();

    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    render(<Probe />);
    expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
  });

  it("retries a failed listener and stops when the last subscriber leaves", () => {
    vi.useFakeTimers();
    const handlers: Array<{
      next: (snapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void;
      error: () => void;
    }> = [];
    firestoreMock.onSnapshot.mockImplementation((_query, next, error) => {
      handlers.push({ next, error });
      return vi.fn();
    });

    try {
      const view = render(<Probe />);
      act(() => {
        handlers[0].next({
          forEach(visit) {
            visit({ id: "custom:notes", data: () => notes });
          },
        });
      });
      expect(screen.getByText("ready:custom:notes", { exact: true })).toBeInTheDocument();

      act(() => handlers[0].error());
      expect(screen.getByText("not-ready:custom:notes", { exact: true })).toBeInTheDocument();
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);

      act(() => { vi.advanceTimersByTime(999); });
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);
      act(() => { vi.advanceTimersByTime(1); });
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(2);

      act(() => {
        handlers[1].next({
          forEach(visit) {
            visit({ id: "custom:notes", data: () => notes });
          },
        });
      });
      expect(screen.getByText("ready:custom:notes", { exact: true })).toBeInTheDocument();

      view.unmount();
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a failed listener after the last subscriber leaves", () => {
    vi.useFakeTimers();
    let onError: () => void = () => undefined;
    firestoreMock.onSnapshot.mockImplementation((_query, _next, error) => {
      onError = error;
      return vi.fn();
    });

    try {
      const view = render(<Probe />);
      act(() => onError());
      expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);

      view.unmount();
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("listens for active shares and reads referenced tombstones by id", async () => {
    let onNext: (snapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void = () => undefined;
    firestoreMock.onSnapshot.mockImplementation((_query, next) => {
      onNext = next;
      return vi.fn();
    });
    firestoreMock.getDocs.mockImplementation(async () => ({
      forEach(visit: (entry: { id: string; data: () => unknown }) => void) {
        visit({ id: "custom:retired", data: () => retired });
      },
    }));

    const view = render(<Probe ids={["custom:notes", "custom:retired"]} />);
    expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
    expect(firestoreMock.getDocs).not.toHaveBeenCalled();
    expect(firestoreMock.where).toHaveBeenCalledWith("status", "==", "active");

    await act(async () => {
      onNext({
        forEach(visit) {
          visit({ id: "custom:notes", data: () => notes });
        },
      });
    });

    expect(screen.getByText("ready:custom:notes,custom:retired", { exact: true })).toBeInTheDocument();
    expect(firestoreMock.documentId).toHaveBeenCalled();
    expect(firestoreMock.where).toHaveBeenCalledWith("__name__", "in", ["custom:retired"]);
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("retries a tombstone read without attaching a second listener", async () => {
    vi.useFakeTimers();
    let onNext: (snapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void = () => undefined;
    firestoreMock.onSnapshot.mockImplementation((_query, next) => {
      onNext = next;
      return vi.fn();
    });
    firestoreMock.getDocs.mockRejectedValue(new Error("offline"));

    try {
      const view = render(<Probe ids={["custom:retired"]} />);
      await act(async () => {
        onNext({ forEach() {} });
      });
      expect(screen.getByText("not-ready:", { exact: true })).toBeInTheDocument();
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);
      expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(firestoreMock.onSnapshot).toHaveBeenCalledTimes(1);
      expect(firestoreMock.getDocs).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an active span's children as present and still reads a missing share", async () => {
    let onNext: (snapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void = () => undefined;
    firestoreMock.onSnapshot.mockImplementation((_query, next) => {
      onNext = next;
      return vi.fn();
    });
    let releaseDocs: (value: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }) => void = () => undefined;
    firestoreMock.getDocs.mockImplementation(() => new Promise((resolve) => {
      releaseDocs = resolve;
    }));
    const covered = ["custom:desk", "custom:child-a", "custom:child-b"];
    const deliverDesk = () => {
      onNext({
        forEach(visit) {
          visit({ id: "custom:desk", data: () => desk });
        },
      });
    };

    const view = render(<Probe ids={covered} />);
    await act(async () => {
      deliverDesk();
    });
    expect(screen.getByText("ready:custom:desk", { exact: true })).toBeInTheDocument();
    expect(firestoreMock.getDocs).not.toHaveBeenCalled();

    view.rerender(<Probe ids={[...covered, "custom:retired"]} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(firestoreMock.where).toHaveBeenCalledWith("__name__", "in", ["custom:retired"]);
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseDocs({
        forEach(visit) {
          visit({ id: "custom:retired", data: () => retired });
        },
      });
    });
    expect(screen.getByText("ready:custom:desk,custom:retired", { exact: true })).toBeInTheDocument();

    act(() => {
      deliverDesk();
    });
    expect(firestoreMock.getDocs).toHaveBeenCalledTimes(1);
    expect(screen.getByText("ready:custom:desk,custom:retired", { exact: true })).toBeInTheDocument();
    view.unmount();
  });
});
