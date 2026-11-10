import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import { AuthProvider, useAuth } from "../src/context/AuthContext";

// Replace only external SDK and HTTP boundaries. Recovery, admission transport and
// the auth provider run together against jsdom's actual localStorage.
const session = vi.hoisted(() => ({
  auth: { currentUser: null as User | null },
  changed: (_user: User | null) => {},
  end: vi.fn(async () => {}),
  profileReads: 0,
}));

vi.mock("firebase/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("firebase/auth")>(),
  getAuth: () => session.auth,
  connectAuthEmulator: () => {},
  onIdTokenChanged: () => () => {},
  onAuthStateChanged: (_auth: unknown, changed: typeof session.changed) => {
    session.changed = changed;
    return () => {};
  },
  signOut: () => session.end(),
}));

vi.mock("firebase/firestore", async (importOriginal) => ({
  ...await importOriginal<typeof import("firebase/firestore")>(),
  onSnapshot: (_ref: unknown, _options: unknown, next: (snapshot: unknown) => void) => {
    session.profileReads += 1;
    next({
      exists: () => true,
      data: () => ({ active: true, role: "admin" }),
      metadata: { hasPendingWrites: false },
    });
    return () => {};
  },
}));

let admissionStatus = 200;
let requests: string[] = [];

beforeEach(() => {
  localStorage.clear();
  session.auth.currentUser = null;
  session.end.mockReset().mockResolvedValue();
  session.profileReads = 0;
  admissionStatus = 200;
  requests = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${init?.method} ${url.pathname}`);
    if (url.pathname.endsWith("/registerStaffProfile")) {
      return Response.json(admissionStatus === 200
        ? { success: true, uid: "ana", created: false }
        : { error: "Access denied", code: "access_denied" }, { status: admissionStatus });
    }
    if (url.pathname === "/__cms-session" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe() {
  const { state, signOut } = useAuth();
  return <>
    <output>{state.status}</output>
    <button onClick={() => { void signOut().catch(() => {}); }}>Sign out</button>
  </>;
}

function mount() {
  return render(<AuthProvider><Probe /></AuthProvider>);
}

async function authenticate(actorId: string | null) {
  const user = actorId === null ? null : {
    uid: actorId,
    email: `${actorId}@example.test`,
    emailVerified: true,
    getIdToken: async () => "test-token",
    getIdTokenResult: async () => ({ token: "test-token", claims: { email_verified: true } }),
  } as unknown as User;
  await act(async () => {
    session.auth.currentUser = user;
    session.changed(user);
  });
}

function seed(actorId: string, surfaceKey: string, savedAtMs = Date.now()) {
  const key = `njpbs-admin:displaced-work:${actorId}:${surfaceKey}`;
  localStorage.setItem(key, JSON.stringify({
    actorId, surfaceKey, savedAtMs,
    label: "Unpublished story",
    displacedBy: "Another editor",
    payload: { draft: { body: "Private unsaved interview notes" } },
  }));
  return key;
}

function expectOnlyPreference(...signOutMark: string[]) {
  expect(Object.keys(localStorage).sort()).toEqual(["njpbs-admin:appearance", ...signOutMark].sort());
  expect(localStorage.getItem("njpbs-admin:appearance")).toBe("dark");
}

const deliberateSignOut = "njpbs-admin:deliberate-sign-out";

describe("staff cookie cleanup at the auth boundary", () => {
  it("makes no remote request when a local startup resolves signed out, including repeated null events", async () => {
    mount();
    await authenticate(null);
    await authenticate(null);
    expect(screen.getByText("signed-out")).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it("still deletes remote sessions when an observed user signs out in another tab", async () => {
    mount();
    await authenticate("ana");
    localStorage.setItem(deliberateSignOut, "1");
    await authenticate(null);
    expect(screen.getByText("signed-out")).toBeInTheDocument();
    expect(requests.filter(request => request === "DELETE /__cms-session")).toHaveLength(1);
  });

  it("still deletes remote sessions on explicit sign-out", async () => {
    mount();
    await authenticate("ana");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
    expect(screen.getByText("signed-out")).toBeInTheDocument();
    expect(requests.filter(request => request === "DELETE /__cms-session")).toHaveLength(1);
  });

  it("still deletes remote sessions after admission denial signs out the observed user", async () => {
    admissionStatus = 403;
    session.end.mockImplementation(async () => {
      session.auth.currentUser = null;
      session.changed(null);
    });
    mount();
    await authenticate("ana");
    expect(screen.getByText("access-denied")).toBeInTheDocument();
    expect(requests.filter(request => request === "DELETE /__cms-session")).toHaveLength(1);
  });
});

describe("displaced draft retention at the auth boundary", () => {
  it.each([false, true])("removes every recovery record when signed out (existing session: %s)", async (signedIn) => {
    mount();
    if (signedIn) {
      await authenticate("ana");
      // The sign-out comes from another tab, which marks it before Firebase reports it here.
      localStorage.setItem(deliberateSignOut, "1");
    }
    seed("ana", "cmsPages:home");
    seed("ana", "cmsPosts:story");
    seed("bo", "cmsSettings:home");
    localStorage.setItem("njpbs-admin:displaced-work:broken", "not json");
    localStorage.setItem("njpbs-admin:appearance", "dark");

    await authenticate(null);

    expect(screen.getByText("signed-out")).toBeInTheDocument();
    expectOnlyPreference(...(signedIn ? [deliberateSignOut] : []));
  });

  it("removes the draft as soon as sign-out is requested, even if the SDK fails", async () => {
    mount();
    await authenticate("ana");
    seed("ana", "cmsPosts:story");
    localStorage.setItem("njpbs-admin:appearance", "dark");
    session.end.mockRejectedValue(new Error("Offline"));

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });

    expectOnlyPreference(deliberateSignOut);
    expect(requests.filter((request) => request.endsWith("/registerStaffProfile"))).toHaveLength(1);
    expect(session.profileReads).toBe(1);
  });

  it("drops another account's drafts on a direct identity change", async () => {
    mount();
    await authenticate("ana");
    const oldDraft = seed("ana", "cmsPosts:story");
    const currentDraft = seed("bo", "cmsPages:home");

    await authenticate("bo");

    expect(screen.getByText("signed-in")).toBeInTheDocument();
    expect(localStorage.getItem(oldDraft)).toBeNull();
    expect(localStorage.getItem(currentDraft)).not.toBeNull();
    expect(session.profileReads).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("sweeps unopened expired and invalid records on auth resolution but keeps fresh work across reload", async () => {
    const fresh = seed("ana", "cmsPosts:story");
    seed("ana", "cmsPages:unopened", Date.now() - 8 * 24 * 60 * 60 * 1_000);
    seed("bo", "cmsPosts:other");
    localStorage.setItem("njpbs-admin:displaced-work:ana:bad", "not json");
    localStorage.setItem("njpbs-admin:displaced-work:ana:invalid", "{}");
    localStorage.setItem("njpbs-admin:appearance", "dark");
    const view = mount();
    await authenticate("ana");

    expect(Object.keys(localStorage).sort()).toEqual([fresh, "njpbs-admin:appearance"].sort());
    const savedDraft = localStorage.getItem(fresh);
    view.unmount();
    mount();
    await authenticate("ana");
    expect(localStorage.getItem(fresh)).toBe(savedDraft);
    expect(session.profileReads).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("clears recovery on denied admission before the SDK reports sign-out", async () => {
    seed("ana", "cmsPosts:story");
    localStorage.setItem("njpbs-admin:appearance", "dark");
    admissionStatus = 403;
    session.end.mockImplementation(() => new Promise(() => {}));
    mount();

    await authenticate("ana");

    expect(screen.getByText("access-denied")).toBeInTheDocument();
    expectOnlyPreference(deliberateSignOut);
    expect(session.profileReads).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("still signs out when the browser blocks local storage", async () => {
    mount();
    await authenticate("ana");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Blocked"); });

    await authenticate(null);

    expect(screen.getByText("signed-out")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
