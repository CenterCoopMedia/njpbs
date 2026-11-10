import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { App as AdminApp } from "firebase-admin/app";
import type { Auth as AdminAuth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { MemoryRouter } from "react-router";
import { ReportProblemDialog } from "../src/components/ReportProblemDialog";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { auth } from "../src/lib/firebase";
import { cmsUploadMedia } from "../src/lib/functions";
import { startVideoUpload } from "../src/lib/source-media-upload";

// The emulator refuses its mandatory reset after a client watch outlives a revoked session, a
// defect outside this contract. The revocation case serves the profile from this fixture; the
// watermark case uses the real listener, because the rules' refusal of that read is its subject.
const profileRead = vi.hoisted(() => ({ fixture: null as Record<string, unknown> | null }));
vi.mock("firebase/firestore", async (importOriginal) => {
  const real = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...real,
    onSnapshot: (...args: unknown[]) => {
      const data = profileRead.fixture;
      if (!data) return (real.onSnapshot as (...call: unknown[]) => () => void)(...args);
      (args[2] as (snapshot: unknown) => void)({
        exists: () => true,
        data: () => data,
        metadata: { hasPendingWrites: false, fromCache: false },
      });
      return () => {};
    },
  };
});

const require = createRequire(import.meta.url);
type FixtureClients = { app: AdminApp; auth: AdminAuth; firestore: Firestore };
const { assertEmulatorEnvironment } = require("../../scripts/lib/admin-e2e-guard.mjs") as {
  assertEmulatorEnvironment(): { firestorePort: number };
};
const { createFixtureClients, closeFixtureClients, resetFixtureProject, proveFixtureProjectEmpty } =
  require("../../scripts/lib/admin-e2e-fixtures.mjs") as {
    createFixtureClients(): FixtureClients;
    closeFixtureClients(clients: FixtureClients): Promise<void>;
    resetFixtureProject(): Promise<void>;
    proveFixtureProjectEmpty(clients: FixtureClients): Promise<unknown>;
  };

const endpoint = "http://127.0.0.1:5001/demo-njpbs/us-central1/cmsSubmitBugReport";
const ended = "Your session ended. Sign in again.";

// jsdom owns the form and Files; Node fetch needs an encoded multipart body.
async function multipart(form: FormData) {
  const boundary = `report-role-${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [name, value] of form.entries()) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"`));
    if (typeof value === "string") parts.push(Buffer.from(`\r\n\r\n${value}\r\n`));
    else {
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error("Fixture file read failed"));
        reader.readAsArrayBuffer(value);
      });
      parts.push(Buffer.from(`; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`), Buffer.from(bytes), Buffer.from("\r\n"));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function Workspace() {
  const { state, getIdToken } = useAuth();
  return <MemoryRouter>
    <p data-testid="auth-status">{state.status}</p>
    <p data-testid="session-ended">{state.status === "signed-out" ? String(state.sessionEnded === true) : ""}</p>
    {state.status === "signed-in"
      ? <ReportProblemDialog currentPath="/content/post/fixture/edit" getIdToken={() => getIdToken()} />
      : null}
  </MemoryRouter>;
}

const status = () => screen.getByTestId("auth-status").textContent;

describe.skipIf(process.env.SESSION_ENDED_EMULATORS !== "true")("ended session emulator contract", () => {
  let clients: ReturnType<typeof createFixtureClients>;
  const password = randomBytes(32).toString("base64url");
  const nativeFetch = globalThis.fetch;

  beforeAll(async () => {
    const { firestorePort } = assertEmulatorEnvironment();
    const allowed = new Set(["http://127.0.0.1:9099", "http://127.0.0.1:5001", `http://127.0.0.1:${firestorePort}`]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://127.0.0.1");
      if (url.pathname === "/__cms-session") return new Response(null, { status: 204 });
      expect(allowed.has(url.origin)).toBe(true);
      if (!(init?.body instanceof FormData)) return nativeFetch(input, init);
      const encoded = await multipart(init.body);
      const headers = new Headers(init.headers);
      headers.set("content-type", encoded.contentType);
      // The deployed CMS edge supplies this trusted correlation UUID.
      headers.set("x-njpbs-request-id", randomUUID());
      return nativeFetch(input, { ...init, body: encoded.body, headers });
    });
    clients = createFixtureClients();
    await resetFixtureProject();
    await clients.firestore.collection("contentSections").doc("station").set({ label: "Station", order: 1 });
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    profileRead.fixture = null;
    await act(() => signOut(auth));
  });
  afterAll(async () => {
    try {
      if (clients) {
        await resetFixtureProject();
        await proveFixtureProjectEmpty(clients);
      }
    } finally {
      if (clients) await closeFixtureClients(clients);
      vi.unstubAllGlobals();
    }
  });

  async function signedInWorkspace(uid: string) {
    const email = `${uid}@report-roles.invalid`;
    await clients.auth.createUser({ uid, email, password, emailVerified: true });
    await clients.firestore.collection("users").doc(uid).set({ email, active: true, role: "super_admin", grants: [] });
    render(<AuthProvider><Workspace /></AuthProvider>);
    await act(async () => { await signInWithEmailAndPassword(auth, email, password); });
    await waitFor(() => expect(status()).toBe("signed-in"));
    // Auth tokens and revocation watermarks use whole seconds. Cross that real
    // clock boundary so this session is strictly older than the revocation.
    await new Promise(resolve => setTimeout(resolve, 1_100 - Date.now() % 1_000));
    return email;
  }

  it("signs out after a real revocation and returns through normal sign-in with browser work", async () => {
    const uid = "report-revoked";
    profileRead.fixture = { email: `${uid}@report-roles.invalid`, active: true, role: "super_admin", grants: [] };
    const email = await signedInWorkspace(uid);
    const token = await auth.currentUser!.getIdToken();
    const work = `njpbs-admin:displaced-work:${uid}:cmsPosts:story`;
    localStorage.setItem(work, JSON.stringify({
      actorId: uid, surfaceKey: "cmsPosts:story", savedAtMs: Date.now(), label: "Story",
      displacedBy: "Another editor", payload: { draft: { body: "Notes" } },
    }));

    await clients.auth.revokeRefreshTokens(uid);
    await expect(clients.auth.verifyIdToken(token, true)).rejects.toMatchObject({ code: "auth/id-token-revoked" });
    const navigationResult = await fetch(endpoint.replace("cmsSubmitBugReport", "cmsSetNavigationPreferences"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-njpbs-cms-edge": "local-cms-edge-only" },
      body: JSON.stringify({ action: "reset" }),
    });
    expect(navigationResult.status).toBe(401);
    expect(await navigationResult.json()).toMatchObject({ code: "session_expired" });

    await act(async () => {
      await expect(cmsUploadMedia(token, new File(["image"], "test.png"), { category: "general" }))
        .rejects.toMatchObject({ status: 401, message: ended });
    });
    await waitFor(() => expect(status()).toBe("signed-out"));
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(auth.currentUser).toBeNull();
    expect(localStorage.getItem(work)).not.toBeNull();
    await expect(startVideoUpload(token, "s3-video", { name: "test.mp4", size: 10, lastModified: 1 }, { name: "Test" }))
      .rejects.toMatchObject({ status: 401, message: ended });

    await act(async () => { await signInWithEmailAndPassword(auth, email, password); });
    await waitFor(() => expect(status()).toBe("signed-in"));
    expect(localStorage.getItem(work)).not.toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Report a problem" }));
    fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "Report after signing in again." } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Report received")).toBeVisible();
    expect((await clients.firestore.collection("bug_reports").where("reporter.uid", "==", uid).get()).size).toBe(1);
  });

  // The Auth emulator still refreshes a revoked session, so a disabled account drives the same
  // SDK invalidation path, which covers auth/user-disabled and auth/user-token-expired alike.
  it("keeps browser work when the real SDK signs out a disabled account during refresh", async () => {
    const uid = "report-refresh-disabled";
    profileRead.fixture = { email: `${uid}@report-roles.invalid`, active: true, role: "super_admin", grants: [] };
    await signedInWorkspace(uid);
    const work = `njpbs-admin:displaced-work:${uid}:cmsPosts:story`;
    localStorage.setItem(work, JSON.stringify({
      actorId: uid, surfaceKey: "cmsPosts:story", savedAtMs: Date.now(), label: "Story",
      displacedBy: "Another editor", payload: { draft: { body: "Notes" } },
    }));
    const user = auth.currentUser!;

    await clients.auth.updateUser(uid, { disabled: true });
    await act(async () => { await expect(user.getIdToken(true)).rejects.toMatchObject({ code: "auth/user-disabled" }); });

    await waitFor(() => expect(status()).toBe("signed-out"));
    expect(auth.currentUser).toBeNull();
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(localStorage.getItem(work)).not.toBeNull();
  });

  it("signs out when a real watermark reaches the profile listener, with no request", async () => {
    const uid = "report-watermark";
    await signedInWorkspace(uid);

    await clients.firestore.collection("users").doc(uid).update({ tokensValidAfter: Math.floor(Date.now() / 1_000) });

    await waitFor(() => expect(status()).toBe("signed-out"), { timeout: 5_000 });
    expect(screen.getByTestId("session-ended")).toHaveTextContent("true");
    expect(auth.currentUser).toBeNull();
  });
});
