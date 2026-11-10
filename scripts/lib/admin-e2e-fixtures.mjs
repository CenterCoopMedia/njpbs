import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { ADMIN_E2E_PROJECT_ID } from "./admin-e2e-guard.mjs";

const FIXTURE_TIMESTAMP = "2026-08-23T12:00:00.000Z";

export const ADMIN_E2E_REVISION_FIXTURE = Object.freeze({
  collection: "cmsPosts",
  documentId: "admin-e2e-draft",
  route: "/content/post/admin-e2e-draft/edit",
  currentTitle: "Loopback newsroom fixture",
  historicalTitle: "Archived newsroom draft",
  historicalRevisionId: "admin-e2e-revision-v1",
  currentRevisionId: "admin-e2e-revision-v3",
  historicalVersion: 1,
  currentVersion: 3,
  finalVersion: 5,
});

export const ADMIN_E2E_IDENTITIES = Object.freeze([
  Object.freeze({
    id: "superAdmin",
    uid: "admin-e2e-super-admin",
    email: "super-admin@admin-e2e.njpbs.invalid",
    displayName: "E2E super admin",
    profile: Object.freeze({ role: "super_admin", grants: Object.freeze([]) }),
  }),
  Object.freeze({
    id: "sectionEditor",
    uid: "admin-e2e-section-editor",
    email: "section-editor@admin-e2e.njpbs.invalid",
    displayName: "E2E section editor",
    profile: Object.freeze({
      role: null,
      grants: Object.freeze([
        Object.freeze({ role: "editor", sections: Object.freeze(["watch"]) }),
      ]),
    }),
  }),
  Object.freeze({
    id: "pending",
    uid: "admin-e2e-pending",
    email: "pending@admin-e2e.njpbs.invalid",
    displayName: "E2E pending account",
    profile: null,
  }),
]);

const SECTIONS = Object.freeze([
  Object.freeze({
    id: "watch",
    label: "Watch",
    description: "Live, on-demand, schedule and kids pages.",
    order: 1,
  }),
  Object.freeze({
    id: "support",
    label: "Support",
    description: "Membership, giving and Passport pages.",
    order: 2,
  }),
  Object.freeze({
    id: "station",
    label: "Station",
    description: "Home, about and contact pages.",
    order: 3,
  }),
  Object.freeze({
    id: "compliance",
    label: "Compliance",
    description: "Public file, accessibility, EEO and policy pages.",
    order: 4,
  }),
]);

function revisionFixturePost({
  title,
  version,
  tag,
  blockId,
  body,
  updatedAt,
}) {
  const editor = ADMIN_E2E_IDENTITIES.find(
    (identity) => identity.id === "sectionEditor",
  );
  return {
    id: ADMIN_E2E_REVISION_FIXTURE.documentId,
    type: "post",
    title,
    summary: "A disposable record for the local revision-history proof.",
    credits: [],
    tags: [tag],
    blocks: [
      {
        id: blockId,
        type: "prose",
        order: 0,
        visible: true,
        data: {
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: body }],
              },
            ],
          },
        },
      },
    ],
    status: "draft",
    section: "watch",
    slug: "loopback-newsroom-fixture",
    previousSlugs: [],
    locale: "en",
    createdBy: editor.uid,
    updatedBy: editor.uid,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt,
    version,
  };
}

function revisionFixtureRecords() {
  const historical = revisionFixturePost({
    title: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
    version: ADMIN_E2E_REVISION_FIXTURE.historicalVersion,
    tag: "first-revision",
    blockId: "admin-e2e-prose-v1",
    body: "The first saved body is available for recovery.",
    updatedAt: "2026-08-23T12:10:00.000Z",
  });
  const current = revisionFixturePost({
    title: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
    version: ADMIN_E2E_REVISION_FIXTURE.currentVersion,
    tag: "current-revision",
    blockId: "admin-e2e-prose-v3",
    body: "The current saved body can restore the older revision forward.",
    updatedAt: "2026-08-23T12:30:00.000Z",
  });
  return { historical, current };
}

function emulatorUrl(host, suffix) {
  return `http://${host}${suffix}`;
}

async function requireDelete(url, fetchFn) {
  const response = await fetchFn(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Admin E2E reset failed with HTTP ${response.status}.`);
  }
}

export function createFixtureClients() {
  const app = initializeApp(
    { projectId: ADMIN_E2E_PROJECT_ID },
    `admin-e2e-${process.pid}`,
  );
  return {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
  };
}

export async function closeFixtureClients(clients) {
  await deleteApp(clients.app);
}

export async function resetFixtureProject({
  authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST,
  firestoreHost = process.env.FIRESTORE_EMULATOR_HOST,
  fetchFn = fetch,
} = {}) {
  await requireDelete(
    emulatorUrl(
      firestoreHost,
      `/emulator/v1/projects/${ADMIN_E2E_PROJECT_ID}/databases/(default)/documents`,
    ),
    fetchFn,
  );
  await requireDelete(
    emulatorUrl(
      authHost,
      `/emulator/v1/projects/${ADMIN_E2E_PROJECT_ID}/accounts`,
    ),
    fetchFn,
  );
}

export async function seedFixtureProject({ auth, firestore, password }) {
  if (typeof password !== "string" || password.length < 20) {
    throw new Error("Admin E2E requires a strong in-memory password.");
  }

  for (const identity of ADMIN_E2E_IDENTITIES) {
    await auth.createUser({
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      password,
      emailVerified: true,
    });
    if (identity.profile !== null) {
      await firestore
        .collection("users")
        .doc(identity.uid)
        .set({
          active: true,
          email: identity.email,
          displayName: identity.displayName,
          role: identity.profile.role,
          grants: identity.profile.grants.map((grant) => ({
            role: grant.role,
            ...(grant.sections ? { sections: [...grant.sections] } : {}),
          })),
          createdAt: FIXTURE_TIMESTAMP,
          updatedAt: FIXTURE_TIMESTAMP,
        });
    }
  }

  await Promise.all(
    SECTIONS.map((section) =>
      firestore
        .collection("sections")
        .doc(section.id)
        .set({
          ...section,
          createdAt: FIXTURE_TIMESTAMP,
          createdBy: "system:admin-e2e",
          updatedAt: FIXTURE_TIMESTAMP,
          updatedBy: "system:admin-e2e",
        }),
    ),
  );

  const editor = ADMIN_E2E_IDENTITIES.find(
    (identity) => identity.id === "sectionEditor",
  );
  const { historical, current } = revisionFixtureRecords();
  await Promise.all([
    firestore
      .collection(ADMIN_E2E_REVISION_FIXTURE.collection)
      .doc(ADMIN_E2E_REVISION_FIXTURE.documentId)
      .set(current),
    firestore
      .collection("cmsVersionHistory")
      .doc(ADMIN_E2E_REVISION_FIXTURE.historicalRevisionId)
      .set({
        collection: ADMIN_E2E_REVISION_FIXTURE.collection,
        documentId: ADMIN_E2E_REVISION_FIXTURE.documentId,
        action: "create",
        userId: editor.uid,
        userEmail: editor.email,
        at: "2026-08-23T12:10:00.000Z",
        before: null,
        after: historical,
      }),
    firestore
      .collection("cmsVersionHistory")
      .doc(ADMIN_E2E_REVISION_FIXTURE.currentRevisionId)
      .set({
        collection: ADMIN_E2E_REVISION_FIXTURE.collection,
        documentId: ADMIN_E2E_REVISION_FIXTURE.documentId,
        action: "update",
        userId: editor.uid,
        userEmail: editor.email,
        at: "2026-08-23T12:30:00.000Z",
        before: historical,
        after: current,
      }),
  ]);

  return {
    authUsers: ADMIN_E2E_IDENTITIES.length,
    approvedProfiles: ADMIN_E2E_IDENTITIES.filter(
      (identity) => identity.profile !== null,
    ).length,
    pendingProfiles: ADMIN_E2E_IDENTITIES.filter(
      (identity) => identity.profile === null,
    ).length,
    sections: SECTIONS.length,
    contentRecords: 1,
    versionHistoryRecords: 2,
  };
}

export async function proveRevisionBrowserFlow({ firestore }) {
  const fixture = ADMIN_E2E_REVISION_FIXTURE;
  const content = await firestore
    .collection(fixture.collection)
    .doc(fixture.documentId)
    .get();
  const stored = content.exists ? content.data() : null;
  if (
    stored?.title !== fixture.currentTitle ||
    stored?.version !== fixture.finalVersion ||
    stored?.blocks?.[0]?.data?.content?.content?.[0]?.content?.[0]?.text !==
      "The current saved body can restore the older revision forward."
  ) {
    throw new Error(
      "Admin E2E revision proof did not restore the newer content.",
    );
  }

  const history = await firestore
    .collection("cmsVersionHistory")
    .where("collection", "==", fixture.collection)
    .where("documentId", "==", fixture.documentId)
    .get();
  const restoreRows = history.docs
    .map((document) => document.data())
    .filter((row) => row.action === "restore");
  const sourceRevisionIds = restoreRows
    .map((row) => row.sourceRevisionId)
    .sort();
  if (
    history.size !== 4 ||
    restoreRows.length !== 2 ||
    sourceRevisionIds.join("\n") !==
      [fixture.currentRevisionId, fixture.historicalRevisionId]
        .sort()
        .join("\n")
  ) {
    throw new Error("Admin E2E revision proof has an invalid history chain.");
  }

  const audit = await firestore.collection("admin_logs").get();
  const restoreAuditRecords = audit.docs.filter(
    (document) =>
      document.data().action === "cms.restore-revision" &&
      document.data().target === `${fixture.collection}/${fixture.documentId}`,
  ).length;
  if (restoreAuditRecords !== 2) {
    throw new Error("Admin E2E revision proof has an invalid audit chain.");
  }

  return {
    contentVersion: stored.version,
    versionHistoryRecords: history.size,
    restoreHistoryRecords: restoreRows.length,
    restoreAuditRecords,
  };
}

export async function proveFixtureProjectEmpty({ auth, firestore }) {
  const users = await auth.listUsers(10);
  const collections = await firestore.listCollections();
  const nonemptyCollections = [];
  for (const collection of collections) {
    const snapshot = await collection.limit(1).get();
    if (!snapshot.empty) nonemptyCollections.push(collection.id);
  }
  if (users.users.length > 0 || nonemptyCollections.length > 0) {
    throw new Error("Admin E2E cleanup proof found remaining emulator data.");
  }
  return { authUsers: 0, firestoreDocuments: 0 };
}
