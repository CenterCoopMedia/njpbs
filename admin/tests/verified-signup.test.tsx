import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import App from "../src/App";
import { AuthProvider, useAuth } from "../src/context/AuthContext";

// Firebase boundaries only: keep the provider, HTTP transport, reducer and views real.
const firebase = vi.hoisted(() => ({
  auth: { currentUser: null as User | null },
  changed: (_user: User | null) => {},
  signOut: vi.fn(async () => {}),
  unsubscribeProfile: vi.fn(),
}));

vi.mock("firebase/auth", async (original) => ({
  ...await original<typeof import("firebase/auth")>(),
  getAuth: () => firebase.auth,
  connectAuthEmulator: () => {},
  onIdTokenChanged: () => () => {},
  onAuthStateChanged: (_auth: unknown, changed: typeof firebase.changed) => {
    firebase.changed = changed;
    return () => {};
  },
  signOut: () => firebase.signOut(),
}));
vi.mock("firebase/firestore", async (original) => ({
  ...await original<typeof import("firebase/firestore")>(),
  onSnapshot: (_ref: unknown, _options: unknown, _next: unknown, error: (error: Error) => void) => {
    // A signup has no readable staff profile until approval.
    error(Object.assign(new Error("No approved profile"), { code: "permission-denied" }));
    return firebase.unsubscribeProfile;
  },
}));

let refusal: string | null;
let submittedTokens: string[];
let refreshes: number;

beforeEach(() => {
  window.history.replaceState(null, "", "/?accountAction=verified");
  firebase.auth.currentUser = null;
  firebase.signOut.mockClear();
  firebase.unsubscribeProfile.mockClear();
  refusal = null;
  submittedTokens = [];
  refreshes = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const endpoint = new URL(input).pathname.split("/").pop();
    if (endpoint === "registerStaffProfile") {
      const token = new Headers(init?.headers).get("Authorization")!;
      submittedTokens.push(token);
      // Match staff-profile's contract: verification precedes approval.
      const code = token === "Bearer unverified-token"
        ? "unverified_email" : refusal ?? "approval_required";
      return Response.json({ error: "Admission refused", code }, { status: 403 });
    }
    if (endpoint === "getStaffAccessStatus") {
      return Response.json({ success: true, request: { state: "pending" } });
    }
    throw new Error(`Unexpected request: ${endpoint}`);
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function AuthorityProbe() {
  const { state } = useAuth();
  return <output data-testid="authority">{state.status === "signed-in"
    ? JSON.stringify({ grants: state.principal.grants, profile: state.userDoc })
    : state.status}</output>;
}

async function returnFromVerification(email: string, tokenVerified = false) {
  // Firebase startup can reload the verified record without refreshing its
  // unexpired ID token. Keep those two values independent (issue #2907).
  let claim = tokenVerified;
  const user = {
    uid: "new-staff",
    email,
    emailVerified: true,
    async getIdToken(forceRefresh = false) {
      if (forceRefresh) {
        refreshes += 1;
        claim = true;
      }
      return claim ? "verified-token" : "unverified-token";
    },
    async getIdTokenResult(this: User) {
      return { token: await this.getIdToken(), claims: { email_verified: claim } };
    },
  } as unknown as User;
  render(<AuthProvider><App /><AuthorityProbe /></AuthProvider>);
  await act(async () => {
    firebase.auth.currentUser = user;
    firebase.changed(user);
  });
}

describe("return from hosted email verification", () => {
  it.each(["staff@example.test", "staff+news@example.test"])(
    "refreshes the stale token for %s and reaches pending approval without staff grants",
    async (email) => {
      await returnFromVerification(email);
      expect(await screen.findByText(/request is waiting/i)).toBeInTheDocument();
      expect(submittedTokens).toEqual(["Bearer verified-token"]);
      expect(refreshes).toBe(1);
      expect(screen.getByTestId("authority")).toHaveTextContent('{"grants":[],"profile":null}');
      expect(firebase.signOut).not.toHaveBeenCalled();
      expect(firebase.unsubscribeProfile).toHaveBeenCalled();
    },
  );

  it("keeps a current verified token without an extra refresh", async () => {
    await returnFromVerification("staff@example.test", true);
    expect(await screen.findByText(/request is waiting/i)).toBeInTheDocument();
    expect(submittedTokens).toEqual(["Bearer verified-token"]);
    expect(refreshes).toBe(0);
  });

  it("shows verification when admission still refuses an unverified email", async () => {
    refusal = "unverified_email";
    await returnFromVerification("staff@example.test", true);
    expect(await screen.findByRole("heading", { name: "Verify your email" })).toBeInTheDocument();
    expect(screen.getByTestId("authority")).toHaveTextContent("email-unverified");
    expect(screen.queryByText(/no longer matches the approved account identity/i)).not.toBeInTheDocument();
    expect(firebase.signOut).not.toHaveBeenCalled();
    expect(firebase.unsubscribeProfile).toHaveBeenCalled();
  });

  it.each(["inactive_account", "email_changed"])("still denies %s", async (code) => {
    refusal = code;
    await returnFromVerification("staff@example.test", true);
    await waitFor(() => expect(screen.getByTestId("authority")).toHaveTextContent("access-denied"));
    expect(firebase.signOut).toHaveBeenCalled();
  });
});
