import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { App as AdminApp } from "firebase-admin/app";
import type { Auth as AdminAuth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import App from "../src/App";
import { AuthProvider } from "../src/context/AuthContext";
import { auth } from "../src/lib/firebase";
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
const roles = [
  { name: "viewer", grants: [{ role: "staff" }], reporterRole: "staff" },
  { name: "writer", grants: [{ role: "contributor" }], reporterRole: "contributor" },
  { name: "scoped-writer", grants: [{ role: "contributor", sections: ["station"] }], reporterRole: "contributor" },
  { name: "editor", grants: [{ role: "editor", sections: ["station"] }], reporterRole: "editor" },
  { name: "station-edit-any", grants: [{ role: "editor" }], reporterRole: "editor" },
  { name: "admin", role: "admin", reporterRole: "admin" },
  { name: "super-admin", role: "super_admin", reporterRole: "super_admin" },
  { name: "empty-scope-editor", grants: [{ role: "editor", sections: [] }], reporterRole: "editor", limited: true },
  { name: "pending", profile: false, denied: true },
  { name: "no-grant", grants: [], denied: true },
  { name: "inactive", grants: [{ role: "editor" }], active: false, denied: true },
  { name: "unverified", grants: [{ role: "editor" }], emailVerified: false, denied: true },
];

// jsdom owns the form and Files; Node fetch needs an encoded multipart body.
// Preserve every real client field, including screenshot bytes, at this adapter.
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

// Opt in through the guarded emulator command. Ordinary Admin tests do not start servers.
describe.skipIf(process.env.REPORT_PROBLEM_ROLE_EMULATORS !== "true")("staff problem report emulator matrix", () => {
  let clients: ReturnType<typeof createFixtureClients>;
  let deliverOutboxRow: (id: string, deps: unknown) => Promise<{ state: string }>;
  const password = randomBytes(32).toString("base64url");
  const nativeFetch = globalThis.fetch;
  let submitted: { body: Uint8Array<ArrayBuffer>; headers: Headers } | undefined;
  let intakeResult: { status: number; error?: string } | undefined;

  beforeAll(async () => {
    const { firestorePort } = assertEmulatorEnvironment();
    const allowed = new Set(["http://127.0.0.1:9099", "http://127.0.0.1:5001", `http://127.0.0.1:${firestorePort}`]);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(allowed.has(new URL(input instanceof Request ? input.url : String(input)).origin)).toBe(true);
      if (!(init?.body instanceof FormData)) return nativeFetch(input, init);
      const encoded = await multipart(init.body);
      const headers = new Headers(init.headers);
      headers.set("content-type", encoded.contentType);
      // The deployed CMS edge supplies this trusted correlation UUID.
      headers.set("x-njpbs-request-id", randomUUID());
      if (String(input) === endpoint) submitted = { body: new Uint8Array(encoded.body), headers };
      const response = await nativeFetch(input, { ...init, body: encoded.body, headers });
      if (String(input) === endpoint) intakeResult = { status: response.status, error: (await response.clone().json()).error };
      return response;
    });
    clients = createFixtureClients();
    ({ deliverOutboxRow } = require("../../functions/bug-report-delivery.js"));
    await resetFixtureProject();
    await clients.firestore.collection("contentSections").doc("station").set({ label: "Station", order: 1 });
  });

  beforeEach(() => { submitted = undefined; intakeResult = undefined; });
  afterEach(async () => { cleanup(); await act(() => signOut(auth)); });
  afterAll(async () => {
    try {
      if (clients) { await resetFixtureProject(); await proveFixtureProjectEmpty(clients); }
    } finally {
      if (clients) await closeFixtureClients(clients);
      vi.unstubAllGlobals();
    }
  });

  it.each(roles)("$name sees the correct control and crosses the correct intake boundary", async (entry) => {
    const uid = `report-role-${entry.name}`;
    const email = `${entry.name}@report-roles.invalid`;
    await clients.auth.createUser({ uid, email, password, emailVerified: entry.emailVerified !== false });
    if (entry.profile !== false) await clients.firestore.collection("users").doc(uid).set({
      email, displayName: entry.name, active: entry.active !== false,
      role: entry.role ?? null, grants: entry.grants ?? [],
    });
    render(<AuthProvider><App /></AuthProvider>);
    let token = "";
    await act(async () => {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      token = await credential.user.getIdToken();
    });
    if (entry.denied) {
      await screen.findByRole("heading", { name: /Verify your email|Request staff access|account cannot|account is|request is/i });
      expect(screen.queryByRole("button", { name: "Report a problem" })).not.toBeInTheDocument();
      const form = new FormData();
      form.set("clientRequestId", randomUUID());
      form.set("report", JSON.stringify({ category: "bug", severity: "minor", area: "other",
        happened: "This account must not submit a problem report.", route: "/reports",
        clientContext: { browser: "Test browser", operatingSystem: "Test OS",
          viewport: { width: 1024, height: 768 }, online: true, timeZone: "UTC" }, correlationIds: [] }));
      const encoded = await multipart(form);
      const response = await nativeFetch(endpoint, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "x-njpbs-cms-edge": "local-cms-edge-only",
        "content-type": encoded.contentType, "x-njpbs-request-id": randomUUID(),
      }, body: encoded.body });
      if (response.status !== 403) throw new Error(`Denied intake HTTP ${response.status}: ${(await response.json()).error}`);
      expect((await clients.firestore.collection("bug_reports").where("reporter.uid", "==", uid).get()).size).toBe(0);
      return;
    }
    fireEvent.click(await screen.findByRole("button", { name: "Report a problem" }));
    expect(screen.getByRole("dialog", { name: "Report a problem" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Tell us what happened"), { target: { value: "The staff test could not complete its work." } });
    const screenshot = new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMISKkISKlggFAAID4Ese/ZQLgAAAAASUVORK5CYII=", "base64")], "fixture.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Screenshot/), { target: { files: [screenshot] } });
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(intakeResult).toBeDefined());
    if (intakeResult?.status !== 201) throw new Error(`Intake HTTP ${intakeResult?.status}: ${intakeResult?.error}`);
    expect(await screen.findByText("Report received")).toBeVisible();
    if (entry.limited) {
      expect(screen.queryByRole("link", { name: "Open this report" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-njpbs-cms-edge": "local-cms-edge-only" };
      const list = await nativeFetch(endpoint.replace("cmsSubmitBugReport", "cmsListBugReports"), {
        method: "POST", headers, body: JSON.stringify({ view: "mine" }),
      });
      expect(list.status).toBe(403);
    }
    const records = await clients.firestore.collection("bug_reports").where("reporter.uid", "==", uid).get();
    expect(records.size).toBe(1);
    const doc = records.docs[0];
    const stored = doc.data();
    expect(stored.reporter).toEqual({ uid, email, role: entry.reporterRole });
    expect(stored.route.path).toBe(window.location.pathname);
    expect(stored.environment.deploymentEnvironment).toBe("emulator");
    expect(stored.environment.viewport).toEqual({ width: window.innerWidth, height: window.innerHeight });
    const evidence = (await clients.firestore.collection("bugReportEvidence").doc(doc.id).get()).data();
    expect(evidence).toMatchObject({ reporterUid: uid, mimeType: "image/webp" });
    if (!evidence) throw new Error("Private screenshot evidence is missing");
    expect(evidence.bytes.length).toBeGreaterThan(0);
    expect(submitted).toBeDefined();
    const replay = await nativeFetch(endpoint, { method: "POST", ...submitted });
    expect(replay.status).toBe(200);
    expect((await replay.json()).report.id).toBe(doc.id);
    const outbox = await clients.firestore.collection("bugReportDeliveryOutbox").where("reportId", "==", doc.id).get();
    expect(outbox.docs.map((row) => row.data().channel).sort()).toEqual(["email", "telegram"]);
    const card = vi.fn(async () => ({ chat: { id: "local-test" }, message_id: 1 }));
    const receipt = vi.fn(async ({ to }: { to: string }) => { expect(to).toBe(email); return { queued: true }; });
    const deps = { firestore: clients.firestore, chatId: "local-test", adminOrigin: "http://127.0.0.1:4173",
      telegramClient: { sendMessage: card }, sendEmail: receipt };
    for (const row of outbox.docs) {
      expect((await deliverOutboxRow(row.id, deps)).state).toBe("delivered");
      expect((await deliverOutboxRow(row.id, deps)).state).toBe("skipped");
      expect((await row.ref.get()).data()?.state).toBe("delivered");
    }
    expect(card).toHaveBeenCalledTimes(1);
    expect(receipt).toHaveBeenCalledTimes(1);
    expect((await clients.firestore.collection("bug_reports").where("reporter.uid", "==", uid).get()).size).toBe(1);
  });
});
