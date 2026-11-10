import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST =
  process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const FUNCTION_URL =
  `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/cmsSubmitBugReport`;
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

let db;
let clientApp;
let clientAuth;

function report() {
  return {
    severity: "work_impaired",
    area: "content_editing",
    tryingToDo: "Update the homepage lead story.",
    happened: "Authorization: Bearer private-value",
    expected: "The draft should save.",
    steps: "Open Home.\nChange the lead story.\nSelect Save.",
    workaround: "Kept the editor open.",
    route: "/content/page/home?private=value#editor",
    affectedRecord: {
      kind: "page",
      id: "home",
      lifecycle: "draft",
      version: 7,
    },
    clientContext: {
      browser: "Chrome 140",
      operatingSystem: "Windows 11",
      viewport: { width: 1440, height: 900 },
      online: true,
      timeZone: "America/New_York",
    },
    correlationIds: [],
  };
}

function form({ honeypot = "", clientRequestId = CLIENT_REQUEST_ID } = {}) {
  const body = new FormData();
  body.set("report", JSON.stringify(report()));
  body.set("clientRequestId", clientRequestId);
  body.set("website", honeypot);
  return body;
}

async function createUser(email, profile = null) {
  // Finish account creation before password sign-in: refreshing a signup token
  // retains auth_time, which can precede the emulator's validSince.
  await admin.auth().createUser({
    email,
    password: "password123",
    emailVerified: true,
  });
  const credential = await signInWithEmailAndPassword(
    clientAuth, email, "password123",
  );
  if (profile) {
    await db.collection("users").doc(credential.user.uid).set({
      active: true,
      role: null,
      grants: [],
      ...profile,
    });
  }
  const token = await credential.user.getIdToken();
  await signOut(clientAuth);
  return { uid: credential.user.uid, token };
}

async function submit(token, body) {
  return fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-njpbs-cms-edge": "local-cms-edge-only",
      "x-njpbs-request-id": REQUEST_ID,
    },
    body,
  });
}

async function rows(name) {
  return (await db.collection(name).get()).docs.map((entry) => entry.data());
}

describe("bug report endpoint wiring", () => {
  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "bug-report-endpoint-test",
    );
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
      { method: "DELETE" },
    );
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("persists a redacted report before returning its stable receipt", async () => {
    const editor = await createUser("editor@example.org", {
      grants: [{ role: "editor" }],
    });

    const first = await submit(editor.token, form());
    const retry = await submit(editor.token, form());

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const receipt = await first.json();
    const retryReceipt = await retry.json();
    expect(receipt).toMatchObject({
      success: true,
      idempotent: false,
      report: {
        id: expect.stringMatching(/^br_[a-f0-9]{32}$/),
        happened: "Authorization: [redacted]",
        route: { path: "/content/page/home", url: null },
        reporter: { uid: editor.uid, role: "editor" },
      },
    });
    expect(retryReceipt).toMatchObject({
      success: true,
      idempotent: true,
      report: { id: receipt.report.id },
    });
    expect(await rows("bug_reports")).toHaveLength(1);
    expect(await rows("admin_logs")).toHaveLength(1);
    expect(await rows("bugReportDeliveryOutbox")).toHaveLength(2);
    expect(await rows("bugReportRateLimits")).toEqual([
      expect.objectContaining({ count: 1 }),
    ]);
  }, 20_000);

  it("rejects raw Firebase auth and the honeypot without writing workflow state", async () => {
    const rawUser = await createUser("raw@example.org");
    const editor = await createUser("editor2@example.org", {
      grants: [{ role: "editor" }],
    });

    const raw = await submit(rawUser.token, form());
    const honeypot = await submit(
      editor.token,
      form({ honeypot: "https://spam.example" }),
    );

    expect(raw.status).toBe(403);
    expect(honeypot.status).toBe(400);
    await expect(honeypot.json()).resolves.toEqual({
      error: "The report could not be submitted",
    });
    expect(await rows("bug_reports")).toEqual([]);
    expect(await rows("admin_logs")).toEqual([]);
    expect(await rows("bugReportDeliveryOutbox")).toEqual([]);
  }, 20_000);
});
