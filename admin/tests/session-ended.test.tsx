import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdTokenResult, User } from "firebase/auth";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { postFunction } from "../src/lib/functions";
import { uploadMediaReusingDuplicates } from "../src/lib/media-upload";

// Replace only the Firebase SDK and HTTP boundaries. The provider, admission and request
// transport run together, so each case exercises the path a staff session takes.
const session = vi.hoisted(() => ({
  auth: { currentUser: null as User | null },
  changed: (_user: User | null) => {},
  tokenChanged: (_user: User | null) => {},
  profileReads: 0,
  profileStops: 0,
  profileNext: null as ((snapshot: unknown) => void) | null,
  end: vi.fn(async () => {}),
  refuseProfile: null as ((error: Error) => void) | null,
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("firebase/auth")>(),
  getAuth: () => session.auth,
  connectAuthEmulator: () => {},
  onAuthStateChanged: (_auth: unknown, changed: typeof session.changed) => {
    session.changed = changed;
    return () => {};
  },
  onIdTokenChanged: (_auth: unknown, changed: typeof session.tokenChanged) => {
    session.tokenChanged = changed;
    return () => {};
  },
  signOut: () => session.end(),
}));

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...await importOriginal<typeof import("firebase/firestore")>(),
  onSnapshot: (_ref: unknown, _options: unknown, next: (snapshot: unknown) => void, failed: (error: Error) => void) => {
    session.profileReads += 1;
    session.profileNext = next;
    session.refuseProfile = failed;
    next(staffProfile);
    return () => { session.profileStops += 1; session.refuseProfile = null; };
  },
}));

const staffProfile = {
  exists: () => true,
  data: () => ({ active: true, role: "admin" }),
  metadata: { hasPendingWrites: false },
};
const admitted = () => Response.json({ success: true, uid: "ana", created: false });
const sessionExpired = () => Response.json({ error: "Invalid or expired authentication token", code: "session_expired" }, { status: 401 });
const work = "njpbs-admin:displaced-work:ana:cmsPosts:story";

let admission: () => Response | Promise<Response>;
let request: () => Response | Promise<Response>;
let admissionCalls = 0;
let admissionTokens: (string | null)[] = [];
let siteCleanup: Promise<void> = Promise.resolve();

beforeEach(() => {
  localStorage.clear();
  session.auth.currentUser = null;
  session.changed = () => {};
  session.tokenChanged = () => {};
  session.profileReads = 0;
  session.profileStops = 0;
  session.profileNext = null;
  session.end.mockReset().mockImplementation(async () => {
    session.auth.currentUser = null;
    notifyUser(null);
  });
  session.refuseProfile = null;
  admission = admitted;
  request = sessionExpired;
  admissionCalls = 0;
  admissionTokens = [];
  siteCleanup = Promise.resolve();
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/registerStaffProfile")) {
      admissionCalls += 1;
      admissionTokens.push(new Headers(init?.headers).get("authorization"));
      return admission();
    }
    if (url.pathname.endsWith("/cmsListContent") || url.pathname.endsWith("/cmsUploadMedia")) return request();
    if (url.pathname === "/__cms-session" && init?.method === "DELETE") {
      await siteCleanup;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe() {
  const { state, signOut } = useAuth();
  return <>
    <p data-testid="auth-status">{state.status}</p>
    <p data-testid="session-ended">{state.status === "signed-out" ? String(state.sessionEnded === true) : ""}</p>
    <p data-testid="admission-error">{state.status === "error" ? state.error.message : ""}</p>
    <button onClick={() => { void signOut(); }}>Sign out</button>
  </>;
}

// Each sign-in gets a later auth_time, as Firebase gives it. A refresh keeps it.
let signIns = 0;
const idToken = (uid: string, authTime: number, refresh = 0, expiresAt?: number) =>
  `header.${btoa(JSON.stringify({ sub: uid, auth_time: authTime, refresh,
    ...(expiresAt === undefined ? {} : { exp: expiresAt }) }))}.signature`;

function tokenResult(token: string, authTime: number, expiresAt?: number): IdTokenResult {
  const issuedAtTime = new Date(authTime * 1_000).toUTCString();
  // ParsedToken declares a string, but the SDK parses numeric JWT seconds.
  const claims = { email_verified: true, auth_time: authTime,
    ...(expiresAt === undefined ? {} : { exp: expiresAt }) } as unknown as IdTokenResult["claims"];
  return { token, claims, authTime: issuedAtTime,
    issuedAtTime, expirationTime: new Date((expiresAt ?? authTime + 3_600) * 1_000).toUTCString(),
    signInProvider: "password", signInSecondFactor: null };
}

async function signIn(uid = "ana", expiresAt?: number) {
  signIns += 1;
  const authTime = signIns;
  const token = idToken(uid, authTime, 0, expiresAt);
  const user = {
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
    getIdToken: async () => token,
    getIdTokenResult: async () => tokenResult(token, authTime, expiresAt),
  } as unknown as User;
  await act(async () => {
    session.auth.currentUser = user;
    notifyUser(user);
  });
}

function notifyUser(user: User | null) {
  session.changed(user);
  session.tokenChanged(user);
}

async function updateTokenInPlace(authTime: number, refresh = 0, expiresAt?: number) {
  const user = session.auth.currentUser!;
  const token = idToken(user.uid, authTime, refresh, expiresAt);
  user.getIdToken = vi.fn(async () => token);
  user.getIdTokenResult = vi.fn(async () => tokenResult(token, authTime, expiresAt));
  await act(async () => { session.tokenChanged(user); });
  return token;
}

function seedWork() {
  localStorage.setItem(work, JSON.stringify({
    actorId: "ana", surfaceKey: "cmsPosts:story", savedAtMs: Date.now(), label: "Story",
    displacedBy: "Another editor", payload: { draft: { body: "Notes" } },
  }));
}

async function send(token?: string) {
  const sentToken = token ?? await currentToken();
  let failure: unknown;
  await act(async () => {
    failure = await postFunction("cmsListContent", sentToken, {}).catch((error: unknown) => error);
  });
  return failure;
}

function currentToken() {
  return session.auth.currentUser!.getIdToken();
}

const status = () => screen.getByTestId("auth-status").textContent;

describe("automatic sign-out for an ended session", () => {
  it("surfaces an expired admission request after refresh instead of waiting for a sign-out", async () => {
    const now = Math.floor(Date.now() / 1_000);
    let finishAdmission!: (response: Response) => void;
    admission = () => new Promise<Response>(resolve => { finishAdmission = resolve; });
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn("ana", now + 10);
    seedWork();
    await updateTokenInPlace(signIns, 1, now + 3_600);
    vi.spyOn(Date, "now").mockReturnValue((now + 20) * 1_000);
    await act(async () => {
      finishAdmission(Response.json({ code: "session_expired", reason: "token_expired" }, { status: 401 }));
    });
    expect(status()).toBe("error");
    expect(screen.getByTestId("admission-error")).toHaveTextContent("This request expired. Try the action again.");
    expect(admissionCalls).toBe(1);
    expect(session.profileReads).toBe(1);
    expect(session.profileStops).toBe(1);
    expect(session.end).not.toHaveBeenCalled();
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("keeps the editor when a rate-limited upload's held JWT expires after refresh", async () => {
    const now = Math.floor(Date.now() / 1_000);
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn("ana", now + 10);
    seedWork();
    const held = await currentToken();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let calls = 0;
    request = () => ++calls === 1
      ? Response.json({ retryAfterSeconds: 60 }, { status: 429 })
      : Response.json({ code: "session_expired", reason: "token_expired" }, { status: 401 });
    let result!: Promise<unknown>;
    await act(async () => {
      result = uploadMediaReusingDuplicates(held, new File(["x"], "fixture.jpg", { type: "image/jpeg" }),
        { category: "station" }, new AbortController().signal).catch(error => error);
    });
    await updateTokenInPlace(signIns, 1, now + 3_600);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(await result).toMatchObject({ status: 401, message: "This request expired. Try the action again." });
    expect(calls).toBe(2);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    expect(admissionCalls).toBe(1);
    expect(session.profileReads).toBe(1);
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("fails an expired held request without ending a newer observed token or looking one up", async () => {
    const now = Math.floor(Date.now() / 1_000);
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn("ana", now + 10);
    seedWork();
    const held = await currentToken();
    const fresh = await updateTokenInPlace(signIns, 1, now + 3_600);
    vi.spyOn(Date, "now").mockReturnValue((now + 20) * 1_000);
    const user = session.auth.currentUser!;
    vi.mocked(user.getIdTokenResult).mockClear();
    let calls = 0;
    request = () => { calls += 1; return Response.json({ code: "session_expired", reason: "token_expired" }, { status: 401 }); };
    expect(await send(held)).toMatchObject({ status: 401, message: "This request expired. Try the action again." });
    expect(calls).toBe(1);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    expect(user.getIdTokenResult).not.toHaveBeenCalled();
    expect(user.getIdToken).not.toHaveBeenCalled();
    expect(localStorage.getItem(work)).not.toBeNull();
    // Refusing the current token still ends the session, even with that reason.
    await send(fresh);
    expect(session.end).toHaveBeenCalledOnce();
  });

  it.each([undefined, "session_revoked", "session_age"])("keeps genuine session refusal authoritative: %s", async reason => {
    const now = Math.floor(Date.now() / 1_000);
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn("ana", now + 10);
    const held = await currentToken();
    await updateTokenInPlace(signIns, 1, now + 3_600);
    vi.spyOn(Date, "now").mockReturnValue((now + 20) * 1_000);
    request = () => Response.json({ code: "session_expired", ...(reason ? { reason } : {}) }, { status: 401 });
    await send(held);
    expect(status()).toBe("signed-out");
    expect(session.end).toHaveBeenCalledOnce();
  });

  // The browser clock must not decide this: an expired current token ends the session at its own
  // refusal, even where Firebase still holds it, so no failing request can repeat.
  it.each([undefined, 10, 15, 22])("ends the session once the replacement token is refused, whatever its expiry: %s", async lifetime => {
    const now = Math.floor(Date.now() / 1_000);
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn("ana", now + 10);
    const held = await currentToken();
    const replacement = await updateTokenInPlace(signIns, 1, lifetime === undefined ? undefined : now + lifetime);
    vi.spyOn(Date, "now").mockReturnValue((now + 20) * 1_000);
    let calls = 0;
    request = () => { calls += 1; return Response.json({ code: "session_expired", reason: "token_expired" }, { status: 401 }); };
    await send(held);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    await send(replacement);
    expect(calls).toBe(2);
    expect(status()).toBe("signed-out");
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("uses an observed refresh that overtakes the initial admission lookup", async () => {
    const now = Math.floor(Date.now() / 1_000), authTime = ++signIns;
    const old = idToken("ana", authTime, 0, now + 10);
    let finishOld!: (result: IdTokenResult) => void;
    const pending = new Promise<IdTokenResult>(resolve => { finishOld = resolve; });
    const user = { uid: "ana", email: "ana@example.test", emailVerified: true,
      getIdToken: async () => old, getIdTokenResult: async () => pending } as unknown as User;
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { session.auth.currentUser = user; notifyUser(user); });
    const fresh = await updateTokenInPlace(authTime, 1, now + 3_600);
    await act(async () => { finishOld(tokenResult(old, authTime, now + 10)); });
    expect(admissionTokens).toEqual([`Bearer ${fresh}`]);
    expect(session.profileReads).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue((now + 20) * 1_000);
    request = () => Response.json({ code: "session_expired", reason: "token_expired" }, { status: 401 });
    await send(old);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
  });

  it("cannot restore refused authority when SDK sign-out fails, and admits a real later sign-in", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    const oldToken = await currentToken();
    const lateProfile = session.profileNext!;
    session.end.mockRejectedValueOnce(new Error("Synthetic credential persistence removal failed"));
    await send(oldToken);
    expect(status()).toBe("signed-out");
    await act(async () => { lateProfile(staffProfile); });
    expect(status()).toBe("signed-out");
    expect(session.profileStops).toBe(1);
    expect(session.end).toHaveBeenCalledOnce();
    expect(localStorage.getItem(work)).not.toBeNull();

    await updateTokenInPlace(signIns, 1);
    expect(status()).toBe("signed-out");
    expect(admissionCalls).toBe(1);
    expect(session.profileReads).toBe(1);

    // A failed SDK cleanup can leave the same User installed. Only an actual
    // new sign-in may re-admit it; a late profile callback has no authority.
    const newToken = await updateTokenInPlace(++signIns);
    expect(status()).toBe("signed-in");
    expect(admissionCalls).toBe(2);
    await send(oldToken);
    expect(session.end).toHaveBeenCalledOnce();
    await send(newToken);
    expect(session.end).toHaveBeenCalledTimes(2);
  });

  it("tracks an in-place same-account sign-in without an auth-state event", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    const user = session.auth.currentUser;
    const oldToken = await currentToken();
    const newToken = await updateTokenInPlace(++signIns);

    expect(session.auth.currentUser).toBe(user);
    expect(admissionCalls).toBe(2);
    await send(oldToken);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    expect(localStorage.getItem(work)).not.toBeNull();
    await send(newToken);
    expect(status()).toBe("signed-out");
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("keeps ordinary refresh within the admitted session without another server read", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    const oldToken = await currentToken();
    await updateTokenInPlace(signIns, 1);
    expect(admissionCalls).toBe(1);
    expect(session.profileReads).toBe(1);
    expect(localStorage.getItem(work)).not.toBeNull();
    await send(oldToken);
    expect(status()).toBe("signed-out");
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("fences an old admission refusal after an in-place new sign-in", async () => {
    let finishOld!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finishOld = resolve; });
    admission = () => pending;
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    expect(admissionCalls).toBe(1);
    admission = admitted;
    const newToken = await updateTokenInPlace(++signIns);
    expect(admissionCalls).toBe(2);
    expect(status()).toBe("signed-in");
    await act(async () => { finishOld(sessionExpired()); });
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    await send(newToken);
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("ignores a superseded token-observer lookup", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    const user = session.auth.currentUser!;
    const oldToken = await currentToken();
    const oldAuthTime = signIns;
    let finishOld!: (result: IdTokenResult) => void;
    user.getIdTokenResult = vi.fn(() => new Promise<IdTokenResult>(resolve => { finishOld = resolve; }));
    await act(async () => { session.tokenChanged(user); });
    const newToken = await updateTokenInPlace(++signIns);
    await act(async () => { finishOld(tokenResult(oldToken, oldAuthTime)); });
    expect(admissionCalls).toBe(2);
    expect(status()).toBe("signed-in");
    await send(newToken);
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("never admits an old token lookup replaced by a same-object sign-in", async () => {
    const authTime = ++signIns;
    const token = idToken("ana", authTime);
    let finishOld!: (result: IdTokenResult) => void;
    const pending = new Promise<IdTokenResult>(resolve => { finishOld = resolve; });
    const user = { uid: "ana", email: "ana@example.test", emailVerified: true,
      getIdToken: async () => token, getIdTokenResult: async () => pending } as unknown as User;
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { session.auth.currentUser = user; notifyUser(user); });
    const newToken = await updateTokenInPlace(++signIns);
    await act(async () => { finishOld(tokenResult(token, authTime)); });
    expect(status()).toBe("signed-in");
    expect(admissionTokens).toEqual([`Bearer ${newToken}`]);
    await send(token);
    expect(session.end).not.toHaveBeenCalled();
    await send(newToken);
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("signs out once and keeps browser-held work for the same account", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();

    const token = await currentToken();
    await send(token);
    await send(token);

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(session.end).toHaveBeenCalledOnce();
    expect(localStorage.getItem(work)).not.toBeNull();

    await signIn();

    expect(status()).toBe("signed-in");
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("removes that work when a different account signs in", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    await send();

    await signIn("bo");

    expect(localStorage.getItem(work)).toBeNull();
  });

  it("keeps the work and the notice in another tab that sees the same sign-out", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    localStorage.setItem("njpbs-admin:session-ended", "1");

    await act(async () => { notifyUser(null); });

    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("still removes the work on a sign-out the person chose", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();

    await act(async () => { screen.getByRole("button", { name: "Sign out" }).click(); });

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("false");
    expect(localStorage.getItem(work)).toBeNull();
  });

  // The locked SDK's getIdToken awaits its own sign-out and only then rejects.
  function firebaseEndsSessionDuringRefresh() {
    const user = session.auth.currentUser!;
    user.getIdToken = async () => {
      session.auth.currentUser = null;
      notifyUser(null);
      throw Object.assign(new Error("Firebase refused the refresh"), { code: "auth/user-token-expired" });
    };
    return act(async () => { await expect(user.getIdToken(true)).rejects.toMatchObject({ code: "auth/user-token-expired" }); });
  }

  it("keeps the work and shows the notice when Firebase ends the session during a refresh", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();

    await firebaseEndsSessionDuringRefresh();

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(localStorage.getItem(work)).not.toBeNull();
    expect(localStorage.getItem("njpbs-admin:session-ended")).toBe("1");

    await signIn();

    expect(status()).toBe("signed-in");
    expect(localStorage.getItem(work)).not.toBeNull();
    expect(localStorage.getItem("njpbs-admin:session-ended")).toBeNull();
  });

  it("removes the work when another tab signs out on purpose", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    localStorage.setItem("njpbs-admin:deliberate-sign-out", "1");

    await act(async () => { notifyUser(null); });

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("false");
    expect(localStorage.getItem(work)).toBeNull();
  });

  it("marks a chosen sign-out for other tabs and clears the mark at the next sign-in", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();

    await act(async () => { screen.getByRole("button", { name: "Sign out" }).click(); });
    expect(localStorage.getItem("njpbs-admin:deliberate-sign-out")).toBe("1");

    await signIn();
    expect(localStorage.getItem("njpbs-admin:deliberate-sign-out")).toBeNull();

    seedWork();
    await firebaseEndsSessionDuringRefresh();
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("removes the work and shows no notice when admission denies the session", async () => {
    admission = () => Response.json({ error: "Access denied" }, { status: 403 });
    render(<AuthProvider><Probe /></AuthProvider>);
    seedWork();

    await signIn();

    expect(status()).toBe("access-denied");
    expect(session.end).toHaveBeenCalledOnce();
    expect(localStorage.getItem("njpbs-admin:session-ended")).toBeNull();
    expect(localStorage.getItem("njpbs-admin:deliberate-sign-out")).toBe("1");
    expect(localStorage.getItem(work)).toBeNull();
  });

  it("treats a page load with no session as a plain signed-out start", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    seedWork();

    await act(async () => { notifyUser(null); });

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("false");
    expect(localStorage.getItem(work)).toBeNull();
  });

  it.each([
    ["an uncoded App Check refusal", () => Response.json({ error: "Invalid App Check token" }, { status: 401 })],
    ["a key-service outage", () => Response.json({ error: "Authentication service is unavailable" }, { status: 503 })],
    ["a permission refusal", () => Response.json({ error: "Access denied" }, { status: 403 })],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("stays signed in after %s", async (_label, failure) => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    request = failure;

    await send();

    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("ignores a late refusal from the session that already ended", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    let finishLate: (response: Response) => void = () => {};
    request = () => new Promise<Response>(resolve => { finishLate = resolve; });
    let late: Promise<unknown> = Promise.resolve();
    await act(async () => {
      late = postFunction("cmsListContent", await currentToken(), {}).catch((error: unknown) => error);
      await Promise.resolve();
    });
    request = sessionExpired;
    await send();
    await signIn();

    await act(async () => {
      finishLate(sessionExpired());
      await late;
    });

    expect(status()).toBe("signed-in");
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("ignores a refusal for a request that was waiting when a new session began", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    const oldToken = await currentToken();
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = postFunction("cmsListContent", oldToken, {}, {}, { appCheck: true }).catch((error: unknown) => error);
      // The old token is still on its way out while this tab reaches a new session.
      notifyUser(null);
    });
    await signIn();
    await act(async () => { await pending; });

    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
  });

  // The author profile form keeps one token across a read and the write after it.
  it.each([["the same account", "ana"], ["another account", "bo"]])(
    "ignores a held token refused after a new sign-in by %s",
    async (_name, nextAccount) => {
      render(<AuthProvider><Probe /></AuthProvider>);
      await signIn();
      const heldToken = await currentToken();
      await signIn(nextAccount);

      await send(heldToken);

      expect(status()).toBe("signed-in");
      expect(session.end).not.toHaveBeenCalled();
    },
  );

  it("ends the session for a refreshed token from the same sign-in", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();

    await send(idToken("ana", signIns, 1));

    expect(status()).toBe("signed-out");
    expect(session.end).toHaveBeenCalledOnce();
  });

  // A lookup can refresh the token, and a failed refresh signs out with no notice.
  it("ends the session without looking up the current token", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();
    const token = await currentToken();
    session.auth.currentUser!.getIdTokenResult = async () => {
      session.auth.currentUser = null;
      notifyUser(null);
      throw new Error("Refresh refused");
    };

    await send(token);

    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("ignores a refusal of a token it cannot read", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();

    await send("not-a-token");

    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
  });

  it("keeps a new sign-in that lands while the ended session is still cleaning up", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    let finishCleanup: () => void = () => {};
    siteCleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    await send();
    expect(status()).toBe("signed-out");

    await signIn();
    expect(status()).toBe("signed-in");
    await act(async () => { finishCleanup(); await Promise.resolve(); });

    expect(status()).toBe("signed-in");
  });

  it("sends no admission request for a session replaced during its token lookup", async () => {
    let finishLookup: (result: unknown) => void = () => {};
    const replaced = {
      uid: "ana", email: "ana@example.test", emailVerified: true,
      getIdToken: async () => idToken("ana", 0),
      getIdTokenResult: () => new Promise(resolve => { finishLookup = resolve; }),
    } as unknown as User;
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => {
      session.auth.currentUser = replaced;
      notifyUser(replaced);
    });
    await signIn();
    expect(status()).toBe("signed-in");
    expect(admissionCalls).toBe(1);
    admission = sessionExpired;

    await act(async () => { finishLookup({ token: idToken("ana", 0), claims: { email_verified: true, auth_time: 0 } }); });

    expect(admissionCalls).toBe(1);
    expect(status()).toBe("signed-in");
    expect(session.end).not.toHaveBeenCalled();
  });

  it("signs out during admission without showing an error", async () => {
    admission = sessionExpired;
    render(<AuthProvider><Probe /></AuthProvider>);

    await signIn();

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(admissionCalls).toBe(1);
  });
});

// A real emulator run recorded this shape: after a newer tokensValidAfter, the rules fail the
// live read with permission-denied and no snapshot carrying the new value arrives.
describe("revocation seen by the profile listener", () => {
  const refused = (code: string) => Object.assign(new Error("Refused"), { code });

  it("signs out when the rules stop accepting an admitted session, with no request", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();
    seedWork();

    await act(async () => { session.refuseProfile?.(refused("permission-denied")); });

    expect(status()).toBe("signed-out");
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(session.end).toHaveBeenCalledOnce();
    expect(localStorage.getItem(work)).not.toBeNull();
    expect(admissionCalls).toBe(1);
  });

  it("stays out of the sign-in path for a network failure on that read", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await signIn();

    await act(async () => { session.refuseProfile?.(refused("unavailable")); });

    expect(session.end).not.toHaveBeenCalled();
  });
});
