// Seed the emulator with the four roles the section-enforcement proof needs, the section
// registry, and content spread across two desks plus one unsectioned legacy record.
// Run with the emulator suite already up.

process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

const { getApps, initializeApp } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const { getFirestore } = await import("firebase-admin/firestore");

const PROJECT = "demo-njpbs";
if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

const PASSWORD = "proof-password-1";

const PEOPLE = [
  {
    key: "super",
    email: "super@njpbs.test",
    displayName: "Sam Super",
    profile: { role: "super_admin", grants: [] },
  },
  {
    key: "sitewide",
    email: "sitewide@njpbs.test",
    displayName: "Sky Sitewide",
    profile: { role: null, grants: [{ role: "editor" }] },
  },
  {
    key: "watch",
    email: "watch@njpbs.test",
    displayName: "Wren Watch",
    profile: { role: null, grants: [{ role: "editor", sections: ["watch"] }] },
  },
  {
    key: "contributor",
    email: "contributor@njpbs.test",
    displayName: "Cory Contributor",
    profile: { role: null, grants: [{ role: "contributor", sections: ["watch"] }] },
  },
];

async function resetEmulatorData() {
  await fetch(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
    { method: "DELETE" },
  );
}

async function seedPeople() {
  const uids = {};
  for (const person of PEOPLE) {
    const user = await auth.createUser({
      email: person.email,
      emailVerified: true,
      password: PASSWORD,
      displayName: person.displayName,
    });
    uids[person.key] = user.uid;
    await db.collection("users").doc(user.uid).set({
      uid: user.uid,
      email: person.email,
      displayName: person.displayName,
      active: true,
      ...person.profile,
      createdAt: new Date().toISOString(),
    });
  }
  return uids;
}

// The registry rows have to be complete: the admin's parser drops a row missing a
// `description`, and an entirely dropped registry silently falls back to the built-in seed
// table. That fallback happens to hold the same four desks, so a broken subscription or a
// broken parser would have looked exactly like a working one. `newsroom` exists only in
// Firestore and in no seed table, so the create form can only offer it by reading the live
// registry -- if it is missing from the picker, the registry integration is not working.
const PROOF_ONLY_DESK = "newsroom";

async function seedSections() {
  const desks = [
    {
      id: "watch",
      label: "Watch",
      description: "Live, on-demand, schedule and kids pages.",
      order: 1,
    },
    {
      id: "support",
      label: "Support",
      description: "Membership, giving and Passport pages.",
      order: 2,
    },
    {
      id: "station",
      label: "Station",
      description: "Home, about and contact pages.",
      order: 3,
    },
    {
      id: "compliance",
      label: "Compliance",
      description: "Public file, accessibility, EEO and policy pages.",
      order: 4,
    },
    {
      id: PROOF_ONLY_DESK,
      label: "Newsroom",
      description: "A desk registered only in Firestore, in no seed table.",
      order: 5,
    },
  ];
  await Promise.all(
    desks.map((desk) => db.collection("sections").doc(desk.id).set(desk)),
  );
}

async function seedContent(uids) {
  const base = (title, extra) => ({
    type: "post",
    title,
    date: "2026-08-21",
    tags: [],
    blocks: [],
    slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    locale: "en",
    status: "draft",
    createdBy: uids.sitewide,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    updatedBy: uids.sitewide,
    version: 1,
    ...extra,
  });

  await db
    .collection("cmsPosts")
    .doc("proof-watch-1")
    .set(base("Watch desk draft", { id: "proof-watch-1", section: "watch" }));
  await db
    .collection("cmsPosts")
    .doc("proof-station-1")
    .set(base("Station desk draft", { id: "proof-station-1", section: "station" }));
  await db
    .collection("cmsPosts")
    .doc("proof-legacy-1")
    .set(base("Legacy unsectioned draft", { id: "proof-legacy-1" }));
  // Owned by the scoped contributor, in a desk they do not hold: ownership must not
  // punch through the scope.
  await db
    .collection("cmsPosts")
    .doc("proof-own-out-of-desk")
    .set(
      base("Contributor's own station draft", {
        id: "proof-own-out-of-desk",
        section: "station",
        createdBy: uids.contributor,
      }),
    );
  // Owned by the scoped contributor inside their desk: the one record they may reach.
  await db
    .collection("cmsPosts")
    .doc("proof-own-in-desk")
    .set(
      base("Contributor's own watch draft", {
        id: "proof-own-in-desk",
        section: "watch",
        createdBy: uids.contributor,
      }),
    );
}

await resetEmulatorData();
const uids = await seedPeople();
await seedSections();
await seedContent(uids);

console.log(
  JSON.stringify({ password: PASSWORD, uids, people: PEOPLE.map((p) => p.email) }, null, 2),
);
process.exit(0);
