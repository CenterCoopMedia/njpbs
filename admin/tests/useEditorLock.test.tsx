import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEditorLock } from "../src/hooks/useEditorLock";
import type {
  EditorLock,
  EditorLockClaim,
  EditorLockClient,
} from "../src/lib/editor-locks";

afterEach(cleanup);

function pageTransition(type: "pagehide" | "pageshow", persisted = false) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  act(() => { window.dispatchEvent(event); });
}

const actor = { id: "admin", name: "Al Admin" };
const surfaceKey = "cmsPages:home";

function lockClient() {
  let listener: ((lock: EditorLock | null) => void) | undefined;
  let stored: EditorLock | null = null;
  const publish = (lock: EditorLock | null) => {
    stored = lock;
    listener?.(lock);
  };
  const client: EditorLockClient & { publish: typeof publish; stored: () => EditorLock | null } = {
    subscribe: vi.fn((_surfaceKey, onLock) => {
      listener = onLock;
      onLock(stored);
      return () => {
        listener = undefined;
      };
    }),
    claim: vi.fn(async (claimedSurfaceKey, claimedActor, sessionId) => {
      const lock: EditorLock = {
        surfaceKey: claimedSurfaceKey,
        ownerId: claimedActor.id,
        ownerName: claimedActor.name,
        sessionId,
        acquiredAtMs: Date.now(),
        heartbeatAtMs: Date.now(),
        observedAtMs: globalThis.performance.now(),
      };
      publish(lock);
      return { status: "acquired" as const, lock };
    }),
    heartbeat: vi.fn(async () => true),
    release: vi.fn(async () => {
      publish(null);
    }),
    requestTakeover: vi.fn(async (_surfaceKey, requester, ownerSessionId) => {
      if (!stored || stored.sessionId !== ownerSessionId) return false;
      publish({
        ...stored,
        request: { byId: requester.id, byName: requester.name, atMs: Date.now() },
      });
      return true;
    }),
    clearRequest: vi.fn(async () => {
      if (stored?.request) {
        const { request: _request, ...rest } = stored;
        publish(rest);
      }
    }),
    publish,
    stored: () => stored,
  };
  return client;
}

type LockState = ReturnType<typeof useEditorLock>;

function LockHarness({
  client,
  canTakeOver = true,
  mutable = true,
  onState,
}: {
  client: EditorLockClient;
  canTakeOver?: boolean;
  mutable?: boolean;
  onState?: (state: LockState) => void;
}) {
  const lock = useEditorLock({ actor, canTakeOver, client, mutable, surfaceKey });
  onState?.(lock);
  return (
    <>
      <span>{lock.ownsLock ? "Lease owned" : "Lease not owned"}</span>
      <span>
        {lock.blockingLock ? `Blocked by ${lock.blockingLock.ownerName}` : "Not blocked"}
      </span>
      <span>{lock.incomingRequest ? `Asked by ${lock.incomingRequest.byName}` : "No ask"}</span>
      <span>{lock.outgoingRequestPending ? "Ask pending" : "No ask pending"}</span>
      <span>{lock.displacedBy ? `Displaced by ${lock.displacedBy}` : "Not displaced"}</span>
    </>
  );
}

function remoteLock(overrides: Partial<EditorLock> = {}): EditorLock {
  return {
    surfaceKey,
    ownerId: "fixture-editor",
    ownerName: "Jordan Editor",
    sessionId: "remote-session",
    acquiredAtMs: Date.now(),
    heartbeatAtMs: Date.now(),
    observedAtMs: globalThis.performance.now(),
    ...overrides,
  };
}

it("releases the exact owned visit on pagehide without waiting for React cleanup", async () => {
  const client = lockClient();
  const send = vi.fn();
  client.prepareExitRelease = vi.fn(async () => send);
  render(<LockHarness client={client} />);
  await screen.findByText("Lease owned");
  const sessionId = client.stored()?.sessionId;
  expect(client.prepareExitRelease).toHaveBeenCalledWith(surfaceKey, actor.id, sessionId);
  act(() => { window.dispatchEvent(new Event("beforeunload")); });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(send).not.toHaveBeenCalled();
  pageTransition("pagehide");
  expect(send).toHaveBeenCalledTimes(1);
  pageTransition("pagehide");
  expect(send).toHaveBeenCalledTimes(1);
  expect(client.release).not.toHaveBeenCalled();
});

it("does not send an exit release for another session's lease", async () => {
  const client = lockClient();
  client.publish(remoteLock({ ownerId: actor.id }));
  const send = vi.fn();
  client.prepareExitRelease = vi.fn(async () => send);
  render(<LockHarness client={client} />);
  await screen.findByText("Blocked by Jordan Editor");
  pageTransition("pagehide");
  expect(send).not.toHaveBeenCalled();
  expect(client.release).not.toHaveBeenCalled();
});

it("uses a new session after browser-history restore and ignores a delayed old exit", async () => {
  const client = lockClient();
  const sends: (() => void)[] = [];
  client.prepareExitRelease = vi.fn(async (_surface, _actorId, sessionId) => {
    const send = () => {
      // Mirrors the server's existing exact-session release rule.
      if (client.stored()?.sessionId === sessionId) client.publish(null);
    };
    sends.push(send);
    return send;
  });
  render(<LockHarness client={client} />);
  await screen.findByText("Lease owned");
  const firstSession = client.stored()?.sessionId;
  pageTransition("pagehide", true);
  expect(client.stored()).toBeNull();
  pageTransition("pageshow", true);
  await waitFor(() => expect(client.claim).toHaveBeenCalledTimes(2));
  await screen.findByText("Lease owned");
  expect(client.stored()?.sessionId).not.toBe(firstSession);
  act(() => { sends[0]?.(); });
  expect(client.stored()).not.toBeNull();
  expect(screen.getByText("Lease owned")).toBeInTheDocument();
});

it("reserves the record on open, before any local change", async () => {
  const client = lockClient();
  render(<LockHarness client={client} />);

  await screen.findByText("Lease owned");
  expect(client.claim).toHaveBeenCalledTimes(1);
  expect(vi.mocked(client.claim).mock.calls[0]?.[3]).toMatchObject({ force: false });
});

it("keeps the lease for the whole visit and releases it on the way out", async () => {
  const client = lockClient();
  const view = render(<LockHarness client={client} />);

  await screen.findByText("Lease owned");
  // Nothing about going clean, idle, or saved may drop the reservation mid-visit.
  await act(async () => {});
  expect(client.release).not.toHaveBeenCalled();

  const sessionId = vi.mocked(client.claim).mock.calls[0]?.[2];
  view.unmount();
  await waitFor(() =>
    expect(client.release).toHaveBeenCalledWith(surfaceKey, actor.id, sessionId),
  );
});

it("shows a second editor who holds the record and does not claim it", async () => {
  const client = lockClient();
  client.publish(remoteLock());
  render(<LockHarness client={client} />);

  await screen.findByText("Blocked by Jordan Editor");
  expect(screen.getByText("Lease not owned")).toBeTruthy();
  expect(client.claim).not.toHaveBeenCalled();
});

it("records a waiting editor's ask against the exact session it was shown", async () => {
  const client = lockClient();
  client.publish(remoteLock());
  let state: LockState | undefined;
  render(<LockHarness client={client} onState={(value) => (state = value)} />);

  await screen.findByText("Blocked by Jordan Editor");
  await act(async () => {
    await state?.requestTakeover();
  });

  expect(client.requestTakeover).toHaveBeenCalledWith(
    surfaceKey,
    { id: actor.id, name: actor.name },
    "remote-session",
  );
  expect(await screen.findByText("Ask pending")).toBeTruthy();
});

it("surfaces another editor's ask to the holder and clears it on a decision", async () => {
  const client = lockClient();
  let state: LockState | undefined;
  render(<LockHarness client={client} onState={(value) => (state = value)} />);
  await screen.findByText("Lease owned");

  const held = client.stored();
  act(() => {
    client.publish({
      ...held!,
      request: { byId: "fixture-editor", byName: "Jordan Editor", atMs: Date.now() },
    });
  });
  expect(await screen.findByText("Asked by Jordan Editor")).toBeTruthy();

  await act(async () => {
    await state?.dismissRequest();
  });
  expect(client.clearRequest).toHaveBeenCalled();
  expect(await screen.findByText("No ask")).toBeTruthy();
});

it("hands the record over on a yield and does not silently reclaim it", async () => {
  const client = lockClient();
  let state: LockState | undefined;
  render(<LockHarness client={client} onState={(value) => (state = value)} />);
  await screen.findByText("Lease owned");
  expect(client.claim).toHaveBeenCalledTimes(1);

  let released: boolean | undefined;
  await act(async () => {
    released = await state?.yieldEditor();
  });

  expect(released).toBe(true);
  expect(await screen.findByText("Lease not owned")).toBeTruthy();
  await act(async () => {});
  // A yielded tab must stay out of the way; re-claiming here would fight the editor it just
  // handed the record to.
  expect(client.claim).toHaveBeenCalledTimes(1);

  await act(async () => {
    await state?.reclaim();
  });
  expect(await screen.findByText("Lease owned")).toBeTruthy();
});

it("names who displaced this tab when another session takes the lease", async () => {
  const client = lockClient();
  render(<LockHarness client={client} />);
  await screen.findByText("Lease owned");

  act(() => {
    client.publish(remoteLock({ ownerName: "Bo Editor" }));
  });

  expect(await screen.findByText("Displaced by Bo Editor")).toBeTruthy();
  expect(screen.getByText("Blocked by Bo Editor")).toBeTruthy();
});

it("releases a first claim that resolves after the hook unmounts", async () => {
  const client = lockClient();
  let settleClaim: (() => void) | undefined;
  client.claim = vi.fn(
    (claimedSurfaceKey, claimedActor, sessionId) =>
      new Promise<EditorLockClaim>((resolve) => {
        settleClaim = () =>
          resolve({
            status: "acquired" as const,
            lock: {
              surfaceKey: claimedSurfaceKey,
              ownerId: claimedActor.id,
              ownerName: claimedActor.name,
              sessionId,
              acquiredAtMs: Date.now(),
              heartbeatAtMs: Date.now(),
              observedAtMs: globalThis.performance.now(),
            },
          });
      }),
  );
  const view = render(<LockHarness client={client} />);
  await waitFor(() => expect(client.claim).toHaveBeenCalledTimes(1));
  const sessionId = vi.mocked(client.claim).mock.calls[0]?.[2];

  view.unmount();
  await act(async () => settleClaim?.());

  await waitFor(() =>
    expect(client.release).toHaveBeenCalledWith(surfaceKey, actor.id, sessionId),
  );
});

it("retries a server-denied stale claim without restarting the full lease window", async () => {
  const client = lockClient();
  const staleLock: EditorLock = {
    surfaceKey,
    ownerId: "fixture-editor",
    ownerName: "Jordan Editor",
    sessionId: "remote-session",
    acquiredAtMs: Date.now() - 130_000,
    heartbeatAtMs: Date.now() - 120_000,
    observedAtMs: globalThis.performance.now() - 120_000,
  };
  client.subscribe = vi.fn((_surfaceKey, onLock) => {
    onLock(staleLock);
    return () => {};
  });
  client.claim = vi.fn(async () => ({ status: "blocked" as const, lock: staleLock }));

  render(<LockHarness client={client} />);
  await waitFor(() => expect(client.claim).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(client.claim).toHaveBeenCalledTimes(1);

  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_050));
  });
  await waitFor(() => expect(client.claim).toHaveBeenCalledTimes(2));
});

it("reclaims a record whose holder stopped renewing before this tab opened", async () => {
  const client = lockClient();
  client.publish(
    remoteLock({
      // Ten minutes without a heartbeat, observed fresh by this tab: the elapsed-observation test
      // alone would keep it blocked for another two minutes (#1047).
      acquiredAtMs: Date.now() - 700_000,
      heartbeatAtMs: Date.now() - 600_000,
      observedAtMs: globalThis.performance.now(),
    }),
  );
  render(<LockHarness client={client} />);

  await screen.findByText("Lease owned");
  expect(vi.mocked(client.claim).mock.calls[0]?.[3]).toMatchObject({
    observedStale: true,
  });
});

it("does not retry a refused abandoned claim against the same unchanged heartbeat", async () => {
  const client = lockClient();
  const abandoned = remoteLock({
    acquiredAtMs: Date.now() - 700_000,
    heartbeatAtMs: Date.now() - 600_000,
    observedAtMs: globalThis.performance.now(),
  });
  client.publish(abandoned);
  // The server is the authority on expiry and refuses: this workstation's clock does not get to
  // evict anybody.
  client.claim = vi.fn(async () => ({ status: "blocked" as const, lock: abandoned }));

  render(<LockHarness client={client} />);
  await waitFor(() => expect(client.claim).toHaveBeenCalledTimes(1));
  await act(async () => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
  });
  expect(client.claim).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Blocked by Jordan Editor")).toBeTruthy();
});

it("keeps a handed-over tab out of save reservations until it is taken back", async () => {
  // A lifecycle, history, or assignment action reserves before it writes. After a hand-off that
  // reservation would reclaim the record from the person it was just given to, without anybody
  // pressing "Take the record back".
  const client = lockClient();
  let state: LockState | undefined;
  render(<LockHarness client={client} onState={(value) => (state = value)} />);
  await screen.findByText("Lease owned");

  await act(async () => {
    await state?.yieldEditor();
  });
  await screen.findByText("Lease not owned");
  expect(client.claim).toHaveBeenCalledTimes(1);

  let reserved: boolean | undefined;
  await act(async () => {
    reserved = await state?.reserveForSave();
  });
  expect(reserved).toBe(false);
  expect(client.claim).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Lease not owned")).toBeTruthy();

  // The explicit reclaim is the only way back in, and it restores save eligibility.
  await act(async () => {
    await state?.reclaim();
  });
  await screen.findByText("Lease owned");
  await act(async () => {
    reserved = await state?.reserveForSave();
  });
  expect(reserved).toBe(true);
});

it("does not reserve a record this person cannot actually change", async () => {
  // The lease actor passes the coarse content-write floor, but the loaded document's own
  // lifecycle decision refuses the save. Reserving here would let a contributor reading their
  // own submitted record hold a lease against an editor who can actually work on it.
  const client = lockClient();
  render(<LockHarness client={client} mutable={false} />);

  await screen.findByText("Lease not owned");
  await act(async () => {});
  expect(client.claim).not.toHaveBeenCalled();
  expect(client.subscribe).toHaveBeenCalledTimes(1);
});

it("reserves as soon as the loaded document turns out to be changeable", async () => {
  const client = lockClient();
  const view = render(<LockHarness client={client} mutable={false} />);
  await screen.findByText("Lease not owned");
  expect(client.claim).not.toHaveBeenCalled();

  view.rerender(<LockHarness client={client} mutable />);
  await screen.findByText("Lease owned");
  expect(client.claim).toHaveBeenCalledTimes(1);
});

it("tells a waiting editor when somebody else already asked for the record", async () => {
  const client = lockClient();
  client.publish(
    remoteLock({
      request: { byId: "cass", byName: "Cass Editor", atMs: Date.now() },
    }),
  );
  let state: LockState | undefined;
  render(<LockHarness client={client} onState={(value) => (state = value)} />);

  await screen.findByText("Blocked by Jordan Editor");
  expect(state?.requestedByOther?.byName).toBe("Cass Editor");
  expect(state?.outgoingRequestPending).toBe(false);

  // A queue of one is the contract: asking must not quietly displace the editor already waiting.
  let asked: boolean | undefined;
  await act(async () => {
    asked = await state?.requestTakeover();
  });
  expect(asked).toBe(false);
  expect(client.requestTakeover).not.toHaveBeenCalled();
});
