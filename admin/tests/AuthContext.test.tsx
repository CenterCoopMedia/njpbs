import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { clearStaffSiteSessions } from "../src/lib/staff-site";
import { readControlPresentation } from "../src/lib/control-presentation";
import { hasCapability } from "../../packages/content-core/src/rbac";

interface MockAuthUser {
  uid: string;
  email: string | null;
  emailVerified?: boolean;
  displayName?: string | null;
  getIdToken?: () => Promise<string>;
  getIdTokenResult?: () => Promise<unknown>;
}

interface MockSnapshot {
  exists: () => boolean;
  data: () => unknown;
  metadata: { hasPendingWrites: boolean; fromCache?: boolean };
}

const authMocks = vi.hoisted(() => {
  let authHandler: ((user: MockAuthUser | null) => void) | undefined;
  const testAuth: { currentUser: MockAuthUser | null } = { currentUser: null };
  const unsubscribe = vi.fn();
  const onAuthStateChanged = vi.fn(
    (
      _auth: unknown,
      next: (user: MockAuthUser | null) => void,
      _error: (error: Error) => void,
    ) => {
      authHandler = next;
      return unsubscribe;
    },
  );

  return {
    googleProvider: { setCustomParameters: vi.fn() },
    onAuthStateChanged,
    reset: () => {
      authHandler = undefined;
      testAuth.currentUser = null;
    },
    signInWithPopup: vi.fn(),
    signInWithEmailAndPassword: vi.fn(),
    createUserWithEmailAndPassword: vi.fn(),
    updateProfile: vi.fn(),
    signOut: vi.fn(() => Promise.resolve()),
    testAuth,
    unsubscribe,
    emitUser: (user: MockAuthUser | null) => {
      if (user?.getIdToken && !user.getIdTokenResult) {
        user.getIdTokenResult = async () => ({
          token: await user.getIdToken!(),
          claims: { email_verified: user.emailVerified === true },
        });
      }
      testAuth.currentUser = user;
      if (!authHandler) {
        throw new Error("Auth listener was not registered");
      }
      authHandler(user);
    },
  };
});

const firestoreMocks = vi.hoisted(() => {
  let activationHandler: ((snapshot: MockSnapshot) => void) | undefined;
  let activationErrorHandler: ((error: Error) => void) | undefined;
  let snapshotHandler: ((snapshot: MockSnapshot) => void) | undefined;
  let snapshotErrorHandler: ((error: Error) => void) | undefined;
  let sectionsHandler: ((snapshot: { docs: { id: string }[]; metadata: { hasPendingWrites: boolean; fromCache: boolean } }) => void) | undefined;
  let sectionsErrorHandler: ((error: Error) => void) | undefined;
  const testDb = { name: "test-db" };
  const unsubscribe = vi.fn();
  const unsubscribeSections = vi.fn();
  const collection = vi.fn((database: unknown, path: string) => ({ database, path }));
  const doc = vi.fn((database: unknown, path: string, id?: string) => ({
    database,
    id,
    path: id === undefined ? path : `${path}/${id}`,
  }));
  const onSnapshot = vi.fn(
    (
      _ref: { path: string },
      optionsOrNext:
        | { includeMetadataChanges: boolean }
        | ((snapshot: MockSnapshot) => void),
      nextOrError:
        | ((snapshot: MockSnapshot) => void)
        | ((error: Error) => void),
      _error?: (error: Error) => void,
    ) => {
      if (_ref.path === "system/staffAccessActivation") {
        activationHandler = nextOrError as typeof activationHandler;
        activationErrorHandler = _error;
        return vi.fn();
      }
      if (_ref.path === "sections") {
        sectionsHandler = nextOrError as unknown as typeof sectionsHandler;
        sectionsErrorHandler = _error;
        return unsubscribeSections;
      }
      snapshotHandler =
        typeof optionsOrNext === "function"
          ? optionsOrNext
          : (nextOrError as (snapshot: MockSnapshot) => void);
      snapshotErrorHandler =
        typeof optionsOrNext === "function"
          ? (nextOrError as (error: Error) => void)
          : _error;
      return unsubscribe;
    },
  );

  return {
    doc,
    collection,
    onSnapshot,
    reset: () => {
      activationHandler = undefined;
      activationErrorHandler = undefined;
      snapshotHandler = undefined;
      snapshotErrorHandler = undefined;
      sectionsHandler = undefined;
      sectionsErrorHandler = undefined;
    },
    testDb,
    unsubscribe,
    unsubscribeSections,
    emitActivation: (snapshot: MockSnapshot) => {
      if (!activationHandler) throw new Error("Activation listener was not registered");
      activationHandler(snapshot);
    },
    emitActivationError: () => {
      if (!activationErrorHandler) throw new Error("Activation error handler was not registered");
      activationErrorHandler(new Error("Activation receipt unavailable"));
    },
    emitSections: (ids: string[], fromCache = false, hasPendingWrites = false) => {
      if (!sectionsHandler) throw new Error("Registry listener was not registered");
      sectionsHandler({ docs: ids.map(id => ({ id })), metadata: { hasPendingWrites, fromCache } });
    },
    emitSectionsError: () => {
      if (!sectionsErrorHandler) throw new Error("Registry error handler was not registered");
      sectionsErrorHandler(new Error("Registry unavailable"));
    },
    emitSnapshot: (snapshot: MockSnapshot) => {
      if (!snapshotHandler) {
        throw new Error("Profile listener was not registered");
      }
      snapshotHandler(snapshot);
    },
    emitError: (error: Error) => {
      if (!snapshotErrorHandler) {
        throw new Error("Profile listener error handler was not registered");
      }
      snapshotErrorHandler(error);
    },
  };
});

const functionsMocks = vi.hoisted(() => {
  const registerStaffProfile = vi.fn(() =>
    Promise.resolve({
      success: true as const,
      uid: "staff-user",
      created: false,
    }),
  );

  return {
    registerStaffProfile,
    requestStaffPasswordReset: vi.fn(() => Promise.resolve({ success: true })),
    submitStaffAccessRequest: vi.fn(),
    reset: () => {
      registerStaffProfile.mockReset();
      registerStaffProfile.mockResolvedValue({
        success: true,
        uid: "staff-user",
        created: false,
      });
      functionsMocks.requestStaffPasswordReset.mockReset();
      functionsMocks.requestStaffPasswordReset.mockResolvedValue({ success: true });
      functionsMocks.submitStaffAccessRequest.mockReset();
    },
  };
});

const consoleCaptureMocks = vi.hoisted(() => ({
  clearConsoleLogs: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: authMocks.createUserWithEmailAndPassword,
  GoogleAuthProvider: function MockGoogleAuthProvider() {
    return authMocks.googleProvider;
  },
  onAuthStateChanged: authMocks.onAuthStateChanged,
  onIdTokenChanged: vi.fn(() => vi.fn()),
  signInWithPopup: authMocks.signInWithPopup,
  signInWithEmailAndPassword: authMocks.signInWithEmailAndPassword,
  signOut: authMocks.signOut,
  updateProfile: authMocks.updateProfile,
}));

vi.mock("firebase/firestore", () => ({
  query: (ref: object, ...constraints: unknown[]) => ({ ...ref, constraints }),
  limit: (count: number) => ({ limit: count }),
  collection: firestoreMocks.collection,
  doc: firestoreMocks.doc,
  onSnapshot: firestoreMocks.onSnapshot,
}));

vi.mock("../src/lib/firebase", () => ({
  auth: authMocks.testAuth,
  db: firestoreMocks.testDb,
}));

vi.mock("../src/lib/functions", () => ({
  registerStaffProfile: functionsMocks.registerStaffProfile,
  requestStaffPasswordReset: functionsMocks.requestStaffPasswordReset,
  submitStaffAccessRequest: functionsMocks.submitStaffAccessRequest,
}));

vi.mock("../src/lib/console-capture", () => ({
  clearConsoleLogs: consoleCaptureMocks.clearConsoleLogs,
}));

vi.mock("../src/lib/staff-site", () => ({
  clearStaffSiteSessions: vi.fn(async () => undefined),
}));

function emptySnapshot(): MockSnapshot {
  return {
    exists: () => false,
    data: () => {
      throw new Error("Empty snapshots do not have data");
    },
    metadata: { hasPendingWrites: false },
  };
}

function existingSnapshot(
  data: unknown,
  hasPendingWrites = false,
): MockSnapshot {
  return {
    exists: () => true,
    data: () => data,
    metadata: { hasPendingWrites },
  };
}

function StatusProbe() {
  const { state } = useAuth();
  return (
    <>
      <div data-testid="auth-status">{state.status}</div>
      <div data-testid="auth-stage">
        {state.status === "loading" ? state.stage : ""}
      </div>
      <div data-testid="auth-grants">
        {state.status === "signed-in"
          ? state.principal.grants.map((grant) => grant.role).join(",")
          : ""}
      </div>
      <div data-testid="auth-media">
        {state.status === "signed-in" ? String(hasCapability(state.principal, "media.manage")) : ""}
      </div>
      <div data-testid="auth-control-presentation">
        {state.status === "signed-in"
          ? readControlPresentation(state.userDoc)
          : ""}
      </div>
      <div data-testid="verification-error">
        {state.status === "email-unverified"
          ? state.verification?.error ?? ""
          : ""}
      </div>
      <div data-testid="verification-mail-state">
        {state.status === "email-unverified"
          ? state.verification?.mailState ?? ""
          : ""}
      </div>
    </>
  );
}

function SignInProbe() {
  const { signIn } = useAuth();
  return <button onClick={() => void signIn()}>Sign in</button>;
}

function MediaControlsProbe() {
  const { state } = useAuth();
  return state.status === "signed-in" && hasCapability(state.principal, "media.manage")
    ? <button>Manage media</button>
    : null;
}

function SignOutProbe() {
  const { signOut } = useAuth();
  return <button onClick={() => void signOut()}>Sign out</button>;
}

function RecoveryProbe() {
  const { resetPassword } = useAuth();
  return (
    <button onClick={() => void resetPassword("person@example.org")}>
      Reset password
    </button>
  );
}

function CreateAccountProbe() {
  const { createAccount } = useAuth();
  return (
    <button
      onClick={() => void createAccount({
        displayName: "New user",
        email: "new@example.org",
        password: "example-password",
        reason: "I edit program pages.",
      }).catch(() => undefined)}
    >
      Create account
    </button>
  );
}

function renderAuthProvider() {
  return render(
    <AuthProvider>
      <StatusProbe />
      <SignOutProbe />
    </AuthProvider>,
  );
}

describe("AuthProvider server admission", () => {
  it("requires a server-confirmed activation receipt before replacing legacy authority with a tier", async () => {
    renderAuthProvider();
    act(() => authMocks.emitUser({ uid: "tier-browser", email: "staff@example.test", emailVerified: true,
      getIdToken: async () => "synthetic-token" }));
    await waitFor(() => expect(functionsMocks.registerStaffProfile).toHaveBeenCalled());
    act(() => firestoreMocks.emitSnapshot(existingSnapshot({ accessTier: "owner", grants: [{ role: "staff" }] })));
    const activated = { schema: 1, state: "active", cleanScan: true };
    act(() => firestoreMocks.emitActivation({ exists: () => true, data: () => activated,
      metadata: { hasPendingWrites: false, fromCache: true } }));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    act(() => firestoreMocks.emitActivation({ exists: () => false, data: () => undefined,
      metadata: { hasPendingWrites: false, fromCache: false } }));
    expect(screen.getByTestId("auth-grants")).toHaveTextContent("staff");
    act(() => firestoreMocks.emitActivation({ exists: () => true, data: () => activated,
      metadata: { hasPendingWrites: true, fromCache: false } }));
    expect(screen.getByTestId("auth-grants")).toHaveTextContent("staff");
    act(() => firestoreMocks.emitActivation({ exists: () => true, data: () => activated,
      metadata: { hasPendingWrites: false, fromCache: false } }));
    expect(screen.getByTestId("auth-grants")).toHaveTextContent("super_admin");
  });

  it("a failed activation read cannot restore stale legacy Owner authority", async () => {
    renderAuthProvider();
    act(() => authMocks.emitUser({ uid: "tier-browser", email: "staff@example.test", emailVerified: true,
      getIdToken: async () => "synthetic-token" }));
    await waitFor(() => expect(functionsMocks.registerStaffProfile).toHaveBeenCalled());
    act(() => firestoreMocks.emitSnapshot(existingSnapshot({ accessTier: "viewer", role: "super_admin" })));
    act(() => firestoreMocks.emitActivationError());
    expect(screen.getByTestId("auth-status")).toHaveTextContent("error");
    expect(screen.getByTestId("auth-grants")).toBeEmptyDOMElement();
  });
  it("withholds scoped media controls for a cached retired area until the server confirms the registry", async () => {
    const view = render(
      <AuthProvider>
        <StatusProbe />
        <MediaControlsProbe />
      </AuthProvider>,
    );
    act(() => authMocks.emitUser({
      uid: "scoped-1", email: "account-21@example.org", emailVerified: true,
      getIdToken: vi.fn(async () => "scoped-token"),
    }));
    await waitFor(() => expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith("scoped-token"));
    act(() => firestoreMocks.emitSnapshot(existingSnapshot({
      grants: [{ role: "editor", sections: ["retired-area"] }],
    })));

    act(() => firestoreMocks.emitSections(["retired-area"], true));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    expect(screen.getByTestId("auth-media")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Manage media" })).not.toBeInTheDocument();

    act(() => firestoreMocks.emitSections(["retired-area"], false, true));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    expect(screen.getByTestId("auth-media")).toBeEmptyDOMElement();

    act(() => firestoreMocks.emitSections(["current-area"]));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
    expect(screen.getByTestId("auth-media")).toHaveTextContent("false");
    expect(screen.queryByRole("button", { name: "Manage media" })).not.toBeInTheDocument();
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("keeps processing cached registry updates after server confirmation", async () => {
    const view = renderAuthProvider();
    act(() => authMocks.emitUser({
      uid: "scoped-1", email: "account-21@example.org", emailVerified: true,
      getIdToken: vi.fn(async () => "scoped-token"),
    }));
    await waitFor(() => expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith("scoped-token"));
    act(() => firestoreMocks.emitSnapshot(existingSnapshot({
      grants: [{ role: "editor", sections: ["current-area"] }],
    })));
    act(() => firestoreMocks.emitSections(["current-area"]));
    expect(screen.getByTestId("auth-media")).toHaveTextContent("true");

    act(() => firestoreMocks.emitSections([], true));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
    expect(screen.getByTestId("auth-media")).toHaveTextContent("false");
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("uses one live registry listener for scoped grants and withdraws retired media access", async () => {
    const view = renderAuthProvider();
    act(() => authMocks.emitUser({
      uid: "scoped-1", email: "account-21@example.org", emailVerified: true,
      getIdToken: vi.fn(async () => "scoped-token"),
    }));
    await waitFor(() => expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith("scoped-token"));
    act(() => firestoreMocks.emitSnapshot(existingSnapshot({
      grants: [{ role: "editor", sections: ["retired-area", "current-area"] }],
    })));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    expect(screen.getByTestId("auth-media")).toBeEmptyDOMElement();
    expect(firestoreMocks.collection).toHaveBeenCalledWith(firestoreMocks.testDb, "sections");
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(2);
    act(() => firestoreMocks.emitSections(["current-area"]));
    expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
    expect(screen.getByTestId("auth-media")).toHaveTextContent("true");
    act(() => firestoreMocks.emitSections([]));
    expect(screen.getByTestId("auth-media")).toHaveTextContent("false");
    act(() => firestoreMocks.emitSections(["current-area"]));
    expect(screen.getByTestId("auth-media")).toHaveTextContent("true");
    act(() => firestoreMocks.emitSections(["current-area", ...Array.from({ length: 100 }, (_, index) => `area-${index}`)]));
    expect(screen.getByTestId("auth-media")).toHaveTextContent("false");
    act(() => firestoreMocks.emitSections(["current-area"]));
    expect(screen.getByTestId("auth-media")).toHaveTextContent("true");
    act(() => firestoreMocks.emitSectionsError());
    expect(screen.getByTestId("auth-media")).toHaveTextContent("false");
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(firestoreMocks.unsubscribeSections).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    authMocks.reset();
    firestoreMocks.reset();
    functionsMocks.reset();
  });

  it.each(["account menu", "another tab"])("removes stored recent tags when signing out through %s", async (route) => {
    renderAuthProvider();
    act(() => authMocks.emitUser({ uid: "staff-1", email: "staff@example.test", emailVerified: false }));
    const tagKeys = [
      "njpbs-admin:media-recent-tags:images",
      "njpbs-admin:media-recent-tags:video",
      "njpbs-admin:media-recent-tags:images:staff-1",
      "njpbs-admin:media-recent-tags:video:staff-2",
    ];
    for (const key of tagKeys) localStorage.setItem(key, JSON.stringify(["Private staff tag"]));
    localStorage.setItem("unrelated-preference", "keep");

    if (route === "account menu") fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    else act(() => authMocks.emitUser(null));

    await waitFor(() => {
      for (const key of tagKeys) expect(localStorage.getItem(key)).toBeNull();
    });
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
    localStorage.clear();
  });

  it("drops this tab's remembered Admin destination when the session ends", async () => {
    // The destination memory belongs to a session, not a browser tab. Clearing it in the sign-out
    // menu alone left it behind for every other way a session can end -- a sign-out in another
    // tab, a denial, an account-page sign-out -- so the next person to sign in here could be
    // carried to the last person's route (#1031).
    sessionStorage.setItem(
      "njpbs.admin.destination",
      JSON.stringify({ uid: "someone", path: "/staff-access" }),
    );
    renderAuthProvider();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(sessionStorage.getItem("njpbs.admin.destination")).toBeNull(),
    );
    expect(consoleCaptureMocks.clearConsoleLogs).toHaveBeenCalledTimes(1);
  });

  it("clears private sessions and the remembered destination when the account signs out elsewhere", async () => {
    sessionStorage.setItem(
      "njpbs.admin.destination",
      JSON.stringify({ uid: "someone", path: "/staff-access" }),
    );
    renderAuthProvider();

    await act(async () => {
      authMocks.emitUser({ uid: "staff-1", email: null });
      expect(clearStaffSiteSessions).not.toHaveBeenCalled();
      authMocks.emitUser(null);
      expect(clearStaffSiteSessions).toHaveBeenCalledTimes(1);
    });

    expect(sessionStorage.getItem("njpbs.admin.destination")).toBeNull();
    expect(consoleCaptureMocks.clearConsoleLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps bootstrap console evidence on the first auth resolution", async () => {
    renderAuthProvider();

    await act(async () => {
      authMocks.emitUser(null);
    });

    expect(consoleCaptureMocks.clearConsoleLogs).not.toHaveBeenCalled();
  });

  it("clears captured console evidence when the authenticated identity changes", () => {
    renderAuthProvider();

    act(() => {
      authMocks.emitUser({ uid: "staff-1", email: null });
    });
    act(() => {
      authMocks.emitUser({ uid: "staff-2", email: null });
    });

    expect(consoleCaptureMocks.clearConsoleLogs).toHaveBeenCalledTimes(1);
  });

  it("uses the server-owned password recovery endpoint", async () => {
    render(
      <AuthProvider>
        <RecoveryProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => {
      expect(functionsMocks.requestStaffPasswordReset).toHaveBeenCalledWith(
        "person@example.org",
      );
    });
  });

  it.each([
    [
      429,
      "Email verification is temporarily limited. Check your first email, wait 15 minutes, then try again.",
    ],
    [
      503,
      "The verification link could not be created. Try again later or email account-10@example.org.",
    ],
  ])("keeps a create-account %s error after the verification view mounts", async (status, message) => {
    const user = {
      uid: "new-user",
      email: "new@example.org",
      emailVerified: false,
      displayName: "New user",
      getIdToken: vi.fn(() => Promise.resolve("new-user-token")),
    };
    authMocks.createUserWithEmailAndPassword.mockImplementationOnce(async () => {
      authMocks.testAuth.currentUser = user;
      return { user };
    });
    functionsMocks.submitStaffAccessRequest.mockRejectedValueOnce(
      Object.assign(new Error(message), { status }),
    );
    render(
      <AuthProvider>
        <StatusProbe />
        <CreateAccountProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("email-unverified");
    });
    expect(screen.getByTestId("verification-error")).toHaveTextContent(message);
  });

  it.each([
    ["profile update", "The profile name could not be saved."],
    ["token refresh", "The account session could not be refreshed."],
  ])("keeps a create-account %s error after account creation", async (step, message) => {
    const getIdToken = vi.fn(() => Promise.resolve("new-user-token"));
    const user = {
      uid: "new-user",
      email: "new@example.org",
      emailVerified: false,
      displayName: "New user",
      getIdToken,
    };
    authMocks.createUserWithEmailAndPassword.mockImplementationOnce(async () => {
      authMocks.testAuth.currentUser = user;
      return { user };
    });
    if (step === "profile update") {
      authMocks.updateProfile.mockRejectedValueOnce(new Error(message));
    } else {
      getIdToken.mockRejectedValueOnce(new Error(message));
    }
    render(
      <AuthProvider>
        <StatusProbe />
        <CreateAccountProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("email-unverified");
    });
    expect(screen.getByTestId("verification-error")).toHaveTextContent(message);
    expect(functionsMocks.submitStaffAccessRequest).not.toHaveBeenCalled();
  });

  it("does not restore the verification view after sign-out during account submission", async () => {
    let finishSubmission = () => {};
    const submission = new Promise<{
      success: true;
      request: Record<string, never>;
      mailState: "sent";
    }>((resolve) => {
      finishSubmission = () => resolve({
        success: true,
        request: {},
        mailState: "sent",
      });
    });
    const user = {
      uid: "new-user",
      email: "new@example.org",
      emailVerified: false,
      displayName: "New user",
      getIdToken: vi.fn(() => Promise.resolve("new-user-token")),
    };
    authMocks.createUserWithEmailAndPassword.mockImplementationOnce(async () => {
      authMocks.testAuth.currentUser = user;
      return { user };
    });
    functionsMocks.submitStaffAccessRequest.mockReturnValueOnce(submission);
    render(
      <AuthProvider>
        <StatusProbe />
        <CreateAccountProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(functionsMocks.submitStaffAccessRequest).toHaveBeenCalledTimes(1);
    });
    act(() => authMocks.emitUser(null));
    finishSubmission();
    await submission;

    expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out");
  });

  it("ignores account submission after the same user starts a new session", async () => {
    let finishSubmission = () => {};
    const submission = new Promise<{
      success: true;
      request: Record<string, never>;
      mailState: "sent";
    }>((resolve) => {
      finishSubmission = () => resolve({
        success: true,
        request: {},
        mailState: "sent",
      });
    });
    const createdUser = {
      uid: "new-user",
      email: "new@example.org",
      emailVerified: false,
      displayName: "New user",
      getIdToken: vi.fn(() => Promise.resolve("new-user-token")),
    };
    const reenteredUser = { ...createdUser };
    authMocks.createUserWithEmailAndPassword.mockImplementationOnce(async () => {
      authMocks.testAuth.currentUser = createdUser;
      return { user: createdUser };
    });
    functionsMocks.submitStaffAccessRequest.mockReturnValueOnce(submission);
    render(
      <AuthProvider>
        <StatusProbe />
        <CreateAccountProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(functionsMocks.submitStaffAccessRequest).toHaveBeenCalledTimes(1);
    });
    act(() => authMocks.emitUser(null));
    act(() => authMocks.emitUser(reenteredUser));
    finishSubmission();
    await submission;

    expect(screen.getByTestId("auth-status")).toHaveTextContent("email-unverified");
    expect(screen.getByTestId("verification-mail-state")).toBeEmptyDOMElement();
  });

  it("does not reclaim the auth session after a delayed account token", async () => {
    let resolveToken = () => {};
    const delayedToken = new Promise<string>((resolve) => {
      resolveToken = () => resolve("new-user-token");
    });
    const createdUser = {
      uid: "new-user",
      email: "new@example.org",
      emailVerified: false,
      displayName: "New user",
      getIdToken: vi.fn(() => delayedToken),
    };
    const currentUser = {
      uid: "other-user",
      email: "other@example.org",
      emailVerified: false,
      displayName: "Other user",
      getIdToken: vi.fn(() => Promise.resolve("other-user-token")),
    };
    authMocks.createUserWithEmailAndPassword.mockImplementationOnce(async () => {
      authMocks.testAuth.currentUser = createdUser;
      return { user: createdUser };
    });
    render(
      <AuthProvider>
        <StatusProbe />
        <CreateAccountProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => {
      expect(createdUser.getIdToken).toHaveBeenCalledTimes(1);
    });
    act(() => authMocks.emitUser(currentUser));
    await act(async () => {
      resolveToken();
      await delayedToken;
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("email-unverified");
    });
    expect(functionsMocks.submitStaffAccessRequest).not.toHaveBeenCalled();
    expect(authMocks.testAuth.currentUser).toBe(currentUser);
  });

  it("reads a profile during admission but does not trust it early", async () => {
    let resolveAdmission: (result: {
      success: true;
      uid: string;
      created: boolean;
    }) => void = () => undefined;
    const admission = new Promise<{
      success: true;
      uid: string;
      created: boolean;
    }>((resolve) => {
      resolveAdmission = resolve;
    });
    functionsMocks.registerStaffProfile.mockReturnValueOnce(admission);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "staff-1",
        email: "account-26@example.org",
        emailVerified: true,
        displayName: "Staff member",
        getIdToken: vi.fn(() => Promise.resolve("staff-token")),
      });
    });

    await waitFor(() => {
      expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith(
        "staff-token",
      );
      expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    expect(firestoreMocks.doc).toHaveBeenCalledWith(
      firestoreMocks.testDb,
      "users",
      "staff-1",
    );

    act(() => {
      firestoreMocks.emitSnapshot(
        existingSnapshot({
          email: "account-26@example.org",
          displayName: "Staff member",
          role: "admin",
          grants: [],
        }),
      );
    });
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");

    await act(async () => {
      resolveAdmission({ success: true, uid: "staff-1", created: false });
      await admission;
    });
    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
      expect(screen.getByTestId("auth-grants")).toHaveTextContent("admin");
    });
  });

  it("waits for a profile that admission creates", async () => {
    let resolveAdmission: (result: {
      success: true;
      uid: string;
      created: boolean;
    }) => void = () => undefined;
    const admission = new Promise<{
      success: true;
      uid: string;
      created: boolean;
    }>((resolve) => {
      resolveAdmission = resolve;
    });
    functionsMocks.registerStaffProfile.mockReturnValueOnce(admission);
    renderAuthProvider();
    // Before Firebase answers, the wait is the restored-session phase.
    expect(screen.getByTestId("auth-stage")).toHaveTextContent("session");

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "new-staff",
        email: "account-11@example.org",
        emailVerified: true,
        displayName: "New staff member",
        getIdToken: vi.fn(() => Promise.resolve("new-staff-token")),
      });
    });
    await waitFor(() => {
      expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    });
    // A session exists and the trusted admission call is in flight.
    expect(screen.getByTestId("auth-stage")).toHaveTextContent("admission");

    act(() => {
      firestoreMocks.emitError(
        Object.assign(new Error("Missing profile is not readable"), {
          code: "permission-denied",
        }),
      );
    });
    await act(async () => {
      resolveAdmission({ success: true, uid: "new-staff", created: true });
      await admission;
    });
    expect(screen.getByTestId("auth-status")).toHaveTextContent("loading");
    // Admission returned; only the created profile's snapshot is still outstanding.
    expect(screen.getByTestId("auth-stage")).toHaveTextContent("profile");
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(2);

    act(() => {
      firestoreMocks.emitSnapshot(
        existingSnapshot({
          email: "account-11@example.org",
          displayName: "New staff member",
          role: null,
          grants: [{ role: "staff" }],
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
      expect(screen.getByTestId("auth-grants")).toHaveTextContent("staff");
    });
  });

  it("denies an auth user without an email before server admission", async () => {
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "staff-2",
        email: null,
        displayName: "No email staff",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent(
        "access-denied",
      );
    });
    expect(functionsMocks.registerStaffProfile).not.toHaveBeenCalled();
    expect(firestoreMocks.onSnapshot).not.toHaveBeenCalled();
    expect(authMocks.signOut).toHaveBeenCalledWith(authMocks.testAuth);
  });

  it("revalidates an existing external profile before trusting its role", async () => {
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "outside-admin",
        email: "approved@example.com",
        emailVerified: true,
        displayName: "Approved administrator",
        getIdToken: vi.fn(() => Promise.resolve("outside-admin-token")),
      });
    });

    await waitFor(() => {
      expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith(
        "outside-admin-token",
      );
      expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    });
    act(() => {
      firestoreMocks.emitSnapshot(
        existingSnapshot({
          email: "approved@example.com",
          displayName: "Approved administrator",
          role: "admin",
          grants: [],
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
      expect(screen.getByTestId("auth-grants")).toHaveTextContent("admin");
    });

    act(() => {
      firestoreMocks.emitSnapshot(emptySnapshot());
    });
    await waitFor(() => {
      expect(screen.getByTestId("auth-grants")).toBeEmptyDOMElement();
    });
  });

  it("ignores local profile snapshots until Firestore confirms the write", async () => {
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "staff-preferences",
        email: "account-18@example.org",
        emailVerified: true,
        displayName: "Preference editor",
        getIdToken: vi.fn(() => Promise.resolve("preference-token")),
      });
    });

    await waitFor(() => {
      expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(firestoreMocks.onSnapshot.mock.calls[0]?.[1]).toEqual({
      includeMetadataChanges: true,
    });

    act(() => {
      firestoreMocks.emitSnapshot(
        existingSnapshot({
          preferences: { display: { controlPresentation: "text" } },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("auth-control-presentation")).toHaveTextContent(
        "text",
      );
    });

    act(() => {
      firestoreMocks.emitSnapshot(
        existingSnapshot(
          { preferences: { display: { controlPresentation: "icons" } } },
          true,
        ),
      );
    });
    expect(screen.getByTestId("auth-control-presentation")).toHaveTextContent(
      "text",
    );
  });

  it("denies an existing external account after its exception is removed", async () => {
    const denied = Object.assign(new Error("Approved staff account required"), {
      status: 403,
    });
    functionsMocks.registerStaffProfile.mockRejectedValueOnce(denied);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "removed-exception",
        email: "removed@example.com",
        emailVerified: true,
        displayName: "Removed exception",
        getIdToken: vi.fn(() => Promise.resolve("removed-token")),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent(
        "access-denied",
      );
    });
    expect(functionsMocks.registerStaffProfile).toHaveBeenCalledWith(
      "removed-token",
    );
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.unsubscribe).toHaveBeenCalled();

    await waitFor(() => {
      expect(authMocks.signOut).toHaveBeenCalledWith(authMocks.testAuth);
    });

    act(() => {
      authMocks.emitUser(null);
    });
    expect(screen.getByTestId("auth-status")).toHaveTextContent(
      "access-denied",
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out");
    });
  });

  it("keeps an approved-email requester signed in without creating a CMS profile", async () => {
    const approvalRequired = Object.assign(new Error("Account approval required"), {
      status: 403,
      data: { code: "approval_required" },
    });
    functionsMocks.registerStaffProfile.mockRejectedValueOnce(approvalRequired);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "requester",
        email: "requester@example.org",
        emailVerified: true,
        getIdToken: vi.fn(() => Promise.resolve("requester-token")),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-in");
    });
    expect(screen.getByTestId("auth-grants")).toBeEmptyDOMElement();
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(authMocks.signOut).not.toHaveBeenCalled();
  });

  it("keeps an unverified account in the verification state without an admission call", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "unverified-requester",
        email: "unverified@example.org",
        emailVerified: false,
        getIdToken: vi.fn(() => Promise.resolve("unverified-token")),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent(
        "email-unverified",
      );
    });
    expect(functionsMocks.registerStaffProfile).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(firestoreMocks.onSnapshot).not.toHaveBeenCalled();
    expect(authMocks.signOut).not.toHaveBeenCalled();
  });

  it("reports a transient admission failure without opening the profile", async () => {
    const failure = new Error("Function unavailable");
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    functionsMocks.registerStaffProfile.mockRejectedValueOnce(failure);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "staff-3",
        email: "account-24@example.org",
        emailVerified: true,
        getIdToken: vi.fn(() => Promise.resolve("staff-3-token")),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("error");
    });
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ignores a completed admission after that account signs out", async () => {
    let resolveAdmission: (result: {
      success: true;
      uid: string;
      created: boolean;
    }) => void = () => undefined;
    const admission = new Promise<{
      success: true;
      uid: string;
      created: boolean;
    }>((resolve) => {
      resolveAdmission = resolve;
    });
    functionsMocks.registerStaffProfile.mockReturnValueOnce(admission);
    renderAuthProvider();

    await waitFor(() => {
      expect(authMocks.onAuthStateChanged).toHaveBeenCalled();
    });
    act(() => {
      authMocks.emitUser({
        uid: "staff-4",
        email: "account-25@example.org",
        emailVerified: true,
        getIdToken: vi.fn(() => Promise.resolve("staff-4-token")),
      });
    });
    await waitFor(() => {
      expect(functionsMocks.registerStaffProfile).toHaveBeenCalledTimes(1);
    });

    act(() => {
      authMocks.emitUser(null);
    });
    await waitFor(() => {
      expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out");
    });
    await act(async () => {
      resolveAdmission({ success: true, uid: "staff-4", created: false });
      await admission;
    });

    expect(screen.getByTestId("auth-status")).toHaveTextContent("signed-out");
    expect(firestoreMocks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(firestoreMocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("always shows the Google account chooser without a domain constraint", async () => {
    render(
      <AuthProvider>
        <SignInProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(authMocks.signInWithPopup).toHaveBeenCalledWith(
        authMocks.testAuth,
        authMocks.googleProvider,
      );
    });
    expect(authMocks.googleProvider.setCustomParameters).toHaveBeenCalledTimes(1);
    expect(authMocks.googleProvider.setCustomParameters).toHaveBeenCalledWith({ prompt: "select_account" });
  });
});
