import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  db: { name: "test-db" },
  state: undefined as Record<string, unknown> | undefined,
  doc: vi.fn((_database: unknown, collection: string, id: string) => ({ collection, id })),
  onSnapshot: vi.fn(),
  set: vi.fn((_: unknown, value: Record<string, unknown>) => {
    firestore.state = value;
  }),
  update: vi.fn((_: unknown, value: Record<string, unknown>) => {
    firestore.state = { ...firestore.state, ...value };
  }),
  delete: vi.fn(() => {
    firestore.state = undefined;
  }),
}));

function timestamp(milliseconds: number) {
  return { toMillis: () => milliseconds };
}

vi.mock("firebase/firestore", () => ({
  deleteField: () => "__delete__",
  doc: firestore.doc,
  onSnapshot: firestore.onSnapshot,
  serverTimestamp: () => timestamp(Date.now()),
  runTransaction: async (
    _database: unknown,
    update: (transaction: unknown) => Promise<unknown>,
  ) =>
    update({
      get: async () => ({
        exists: () => firestore.state !== undefined,
        data: () => firestore.state,
      }),
      set: firestore.set,
      update: firestore.update,
      delete: firestore.delete,
    }),
}));

vi.mock("../src/lib/firebase", () => ({ db: firestore.db }));

import { editorLockClient, parseEditorLock } from "../src/lib/editor-lock-store";
import { EDITOR_LOCK_LEASE_MS } from "../src/lib/editor-locks";

function storedLock(
  ownerId: string,
  sessionId: string,
  heartbeatAtMs = Date.now(),
): Record<string, unknown> {
  return {
    surfaceKey: "cmsPages:home",
    contentCollection: "cmsPages",
    contentId: "home",
    ownerId,
    ownerName: "Jordan Editor",
    sessionId,
    acquiredAt: timestamp(heartbeatAtMs - 1_000),
    heartbeatAt: timestamp(heartbeatAtMs),
  };
}

function legacyStoredLock(
  ownerId: string,
  sessionId: string,
  heartbeatAtMs = Date.now(),
): Record<string, unknown> {
  const { contentCollection: _contentCollection, contentId: _contentId, ...legacy } =
    storedLock(ownerId, sessionId, heartbeatAtMs);
  return legacy;
}

function legacyReleasedLock(
  ownerId: string,
  sessionId: string,
): Record<string, unknown> {
  return {
    surfaceKey: "cmsPages:home",
    ownerId,
    sessionId,
    releasedAt: timestamp(Date.now()),
  };
}

describe("editor lock Firestore store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestore.state = undefined;
    vi.setSystemTime(new Date("2026-07-22T14:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("parses only complete timestamped lock documents", () => {
    expect(parseEditorLock(storedLock("fixture-editor", "remote-session"))).toMatchObject({
      surfaceKey: "cmsPages:home",
      ownerId: "fixture-editor",
      ownerName: "Jordan Editor",
      sessionId: "remote-session",
    });
    expect(parseEditorLock({ ...storedLock("fixture-editor", "remote-session"), heartbeatAt: null })).toBe(
      null,
    );
    expect(
      parseEditorLock({
        ...storedLock("fixture-editor", "remote-session"),
        contentId: "another-page",
      }),
    ).toBeNull();
  });

  it("derives a legacy lease address only when both persisted address fields are absent", () => {
    expect(parseEditorLock(legacyStoredLock("fixture-editor", "remote-session"))).toMatchObject({
      surfaceKey: "cmsPages:home",
      ownerId: "fixture-editor",
    });
    expect(
      parseEditorLock({
        ...legacyStoredLock("fixture-editor", "remote-session"),
        contentCollection: "cmsPages",
      }),
    ).toBeNull();
    expect(
      parseEditorLock({
        ...legacyStoredLock("fixture-editor", "remote-session"),
        contentId: "home",
      }),
    ).toBeNull();
    expect(
      parseEditorLock({
        ...legacyStoredLock("fixture-editor", "remote-session"),
        takeoverAt: "not-a-timestamp",
      }),
    ).toBeNull();
  });

  it("recognizes a valid legacy release marker during a rolling deployment", () => {
    const onLock = vi.fn();
    const onError = vi.fn();
    editorLockClient.subscribe("cmsPages:home", onLock, onError);
    const next = firestore.onSnapshot.mock.calls[0]?.[1] as
      | ((snapshot: unknown) => void)
      | undefined;
    expect(next).toBeTypeOf("function");
    next?.({
      exists: () => true,
      data: () => legacyReleasedLock("admin", "session-a"),
    });
    expect(onLock).toHaveBeenCalledWith(null);
    expect(onError).not.toHaveBeenCalled();
  });

  it("replaces a legacy release marker with a new addressed claim", async () => {
    firestore.state = legacyReleasedLock("admin", "remote-session");
    await expect(
      editorLockClient.claim(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "local-session",
      ),
    ).resolves.toMatchObject({ status: "acquired" });
    expect(firestore.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surfaceKey: "cmsPages:home",
        contentCollection: "cmsPages",
        contentId: "home",
        ownerId: "admin",
      }),
    );
  });

  it("requires an observed-stale claim before asking the server to replace a lease", async () => {
    firestore.state = storedLock("fixture-editor", "remote-session");
    await expect(
      editorLockClient.claim(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "local-session",
      ),
    ).resolves.toMatchObject({ status: "blocked", lock: { ownerId: "fixture-editor" } });
    expect(firestore.set).not.toHaveBeenCalled();

    firestore.state = storedLock(
      "fixture-editor",
      "remote-session",
      Date.now() - EDITOR_LOCK_LEASE_MS,
    );
    await expect(
      editorLockClient.claim(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "local-session",
        { observedStale: true },
      ),
    ).resolves.toMatchObject({ status: "acquired", lock: { ownerId: "admin" } });
    expect(firestore.set).toHaveBeenCalledTimes(1);
    expect(firestore.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surfaceKey: "cmsPages:home",
        contentCollection: "cmsPages",
        contentId: "home",
      }),
    );
    expect(firestore.set.mock.calls[0]?.[1]).not.toHaveProperty("takeoverAt");
  });

  it("preserves elapsed observation age when the server denies the same stale lease", async () => {
    firestore.state = storedLock(
      "fixture-editor",
      "remote-session",
      Date.now() - EDITOR_LOCK_LEASE_MS,
    );
    const observed = parseEditorLock(firestore.state, 250);
    expect(observed).not.toBeNull();
    firestore.set.mockImplementationOnce(() => {
      throw { code: "permission-denied" };
    });

    const result = await editorLockClient.claim(
      "cmsPages:home",
      { id: "admin", name: "Al Admin" },
      "local-session",
      { observedStale: true, observedLock: observed! },
    );

    expect(result).toMatchObject({
      status: "blocked",
      lock: { ownerId: "fixture-editor", observedAtMs: 250 },
    });
  });

  it("starts a fresh observation window when the denied lease has a newer heartbeat", async () => {
    const originalState = storedLock(
      "fixture-editor",
      "remote-session",
      Date.now() - EDITOR_LOCK_LEASE_MS,
    );
    const observed = parseEditorLock(originalState, -500_000);
    expect(observed).not.toBeNull();
    firestore.state = storedLock("fixture-editor", "remote-session", Date.now() - 1_000);
    firestore.set.mockImplementationOnce(() => {
      throw { code: "permission-denied" };
    });

    const result = await editorLockClient.claim(
      "cmsPages:home",
      { id: "admin", name: "Al Admin" },
      "local-session",
      { observedStale: true, observedLock: observed! },
    );

    expect(result).toMatchObject({
      status: "blocked",
      lock: { ownerId: "fixture-editor", heartbeatAtMs: Date.now() - 1_000 },
    });
    expect(result.lock.observedAtMs).not.toBe(observed!.observedAtMs);
  });

  it("marks an explicit takeover for the server-time rule", async () => {
    firestore.state = storedLock("fixture-editor", "remote-session");
    await expect(
      editorLockClient.claim(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "local-session",
        { force: true },
      ),
    ).resolves.toMatchObject({ status: "acquired", lock: { ownerId: "admin" } });
    expect(firestore.set.mock.calls[0]?.[1]).toHaveProperty("takeoverAt");
  });

  it("heartbeats and releases only the exact owning session", async () => {
    firestore.state = storedLock("admin", "session-a");
    await expect(
      editorLockClient.heartbeat("cmsPages:home", "admin", "session-b"),
    ).resolves.toBe(false);
    expect(firestore.update).not.toHaveBeenCalled();

    await expect(
      editorLockClient.heartbeat("cmsPages:home", "admin", "session-a"),
    ).resolves.toBe(true);
    expect(firestore.update).toHaveBeenCalledTimes(1);

    await editorLockClient.release("cmsPages:home", "admin", "session-b");
    expect(firestore.set).not.toHaveBeenCalled();
    await editorLockClient.release("cmsPages:home", "admin", "session-a");
    expect(firestore.set).toHaveBeenCalledTimes(1);
    expect(firestore.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surfaceKey: "cmsPages:home",
        contentCollection: "cmsPages",
        contentId: "home",
        ownerId: "admin",
        sessionId: "session-a",
        releasedAt: expect.anything(),
      }),
    );
  });

  it("heartbeats a legacy owned lease and migrates it on release", async () => {
    firestore.state = legacyStoredLock("admin", "session-a");
    await expect(
      editorLockClient.heartbeat("cmsPages:home", "admin", "session-a"),
    ).resolves.toBe(true);
    expect(firestore.update).toHaveBeenCalledWith(expect.anything(), {
      heartbeatAt: expect.anything(),
    });

    await editorLockClient.release("cmsPages:home", "admin", "session-a");
    expect(firestore.set).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        surfaceKey: "cmsPages:home",
        contentCollection: "cmsPages",
        contentId: "home",
        ownerId: "admin",
        sessionId: "session-a",
        releasedAt: expect.anything(),
      }),
    );
  });
  it("attaches a waiting editor's ask to the exact live lease it was shown", async () => {
    firestore.state = storedLock("fixture-editor", "remote-session");
    await expect(
      editorLockClient.requestTakeover(
        "cmsPages:home",
        { id: "admin", name: "  Al   Admin  " },
        "remote-session",
      ),
    ).resolves.toBe(true);
    expect(firestore.update).toHaveBeenCalledWith(expect.anything(), {
      requestedById: "admin",
      requestedByName: "Al Admin",
      requestedAt: expect.anything(),
    });
  });

  it("refuses an ask aimed at a lease that has already moved on", async () => {
    firestore.state = storedLock("fixture-editor", "newer-session");
    await expect(
      editorLockClient.requestTakeover(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "remote-session",
      ),
    ).resolves.toBe(false);
    // The holder's own tab never asks itself for the record.
    firestore.state = storedLock("admin", "session-a");
    await expect(
      editorLockClient.requestTakeover(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "session-a",
      ),
    ).resolves.toBe(false);
    expect(firestore.update).not.toHaveBeenCalled();
  });

  it("leaves another editor's pending ask in place rather than replacing it", async () => {
    firestore.state = {
      ...storedLock("fixture-editor", "remote-session"),
      requestedById: "cass",
      requestedByName: "Cass Editor",
      requestedAt: timestamp(Date.now()),
    };
    await expect(
      editorLockClient.requestTakeover(
        "cmsPages:home",
        { id: "admin", name: "Al Admin" },
        "remote-session",
      ),
    ).resolves.toBe(false);
    expect(firestore.update).not.toHaveBeenCalled();

    // The editor already waiting may refresh their own ask.
    await expect(
      editorLockClient.requestTakeover(
        "cmsPages:home",
        { id: "cass", name: "Cass Editor" },
        "remote-session",
      ),
    ).resolves.toBe(true);
  });

  it("reads an attached ask back off the lease and clears it from the holder's own lease", async () => {
    firestore.state = {
      ...storedLock("admin", "session-a"),
      requestedById: "fixture-editor",
      requestedByName: "Jordan Editor",
      requestedAt: timestamp(Date.now()),
    };
    expect(parseEditorLock(firestore.state)).toMatchObject({
      ownerId: "admin",
      request: { byId: "fixture-editor", byName: "Jordan Editor" },
    });

    await editorLockClient.clearRequest("cmsPages:home", "admin", "session-a");
    expect(firestore.update).toHaveBeenCalledWith(expect.anything(), {
      requestedById: "__delete__",
      requestedByName: "__delete__",
      requestedAt: "__delete__",
    });
  });

  it("ignores a malformed ask rather than failing the whole lease read", () => {
    expect(
      parseEditorLock({
        ...storedLock("fixture-editor", "remote-session"),
        requestedById: "",
        requestedByName: "Jordan Editor",
        requestedAt: timestamp(Date.now()),
      })?.request,
    ).toBeUndefined();
    expect(
      parseEditorLock({
        ...storedLock("fixture-editor", "remote-session"),
        requestedById: "fixture-editor",
        requestedByName: "Jordan Editor",
      })?.request,
    ).toBeUndefined();
  });

  it("does not clear an ask from a lease this session does not hold", async () => {
    firestore.state = {
      ...storedLock("fixture-editor", "remote-session"),
      requestedById: "admin",
      requestedByName: "Al Admin",
      requestedAt: timestamp(Date.now()),
    };
    await editorLockClient.clearRequest("cmsPages:home", "admin", "session-a");
    expect(firestore.update).not.toHaveBeenCalled();
  });
});
