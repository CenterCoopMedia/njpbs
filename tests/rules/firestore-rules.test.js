import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  documentId,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently and the
// revocation watermark sits between them.
const nowSeconds = Math.floor(Date.now() / 1000);
const recentAuthTime = nowSeconds - 3600;
const revokedAt = recentAuthTime - 3600;
const DAY_SECONDS = 24 * 60 * 60;

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = resolve(here, "../../firestore.rules");
const rulesSource = readFileSync(rulesPath, "utf8");

// One minted authorId, reused by the author-profile seeds and assertions.
const AUTHOR_ID = `au_${"a".repeat(32)}`;

function resolveFirestoreEmulatorPort(host) {
  const match = host?.match(/:(\d+)$/);
  if (!match) return 8080;
  const port = Number.parseInt(match[1], 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 8080;
}

const firestoreEmulatorPort = resolveFirestoreEmulatorPort(
  process.env.FIRESTORE_EMULATOR_HOST,
);

describe("Firestore emulator configuration", () => {
  it("uses a valid explicit port and otherwise falls back to the default", () => {
    expect(resolveFirestoreEmulatorPort("localhost:8180")).toBe(8180);
    expect(resolveFirestoreEmulatorPort("[::1]:9090")).toBe(9090);
    expect(resolveFirestoreEmulatorPort("localhost")).toBe(8080);
    expect(resolveFirestoreEmulatorPort("localhost:not-a-port")).toBe(8080);
    expect(resolveFirestoreEmulatorPort("localhost:99999")).toBe(8080);
  });
});

describe("Firestore settings rule contract", () => {
  it("keeps both the settings root and usage documents explicitly server-only", () => {
    expect(rulesSource).toMatch(
      /match \/cmsSettings\/\{docId\} \{\s+allow read, write: if false;/,
    );
    expect(rulesSource).toMatch(
      /match \/cmsSettings\/\{docId\}\/mediaUsage\/\{state\} \{\s+allow read, write: if false;/,
    );
  });
});

describe("Firestore editor-lock page contract", () => {
  it("keeps absent create-eligible lease pages in parity with the public registry", () => {
    const match = rulesSource.match(
      /function isCreateEligibleEditorLockPage\(data\) \{[\s\S]*?data\.contentId in \[([\s\S]*?)\];/,
    );
    expect(match?.[1]).toBeDefined();
    const rulePageIds = [...match[1].matchAll(/'([^']+)'/g)].map(
      (entry) => entry[1],
    );
    expect(rulePageIds).toEqual(PUBLIC_PAGE_IDS);
  });
});

let testEnv;

// Cold rules initialization needs a bounded setup budget.
// loaded CI exceeded the default 10 s. Give only this startup hook 20 s.
beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-njpbs",
    firestore: {
      rules: rulesSource,
      host: "127.0.0.1",
      port: firestoreEmulatorPort,
    },
  });
}, 20_000);

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const database = ctx.firestore();
    await Promise.all([
      setDoc(doc(database, "users/super"), {
        email: "fixture-d9bb0a65ad@example.org",
        displayName: "Sue Super",
        role: "super_admin",
        grants: [],
      }),
      setDoc(doc(database, "users/admin"), {
        email: "fixture-51fddd0c91@example.org",
        displayName: "Al Admin",
        role: "admin",
        grants: [],
      }),
      setDoc(doc(database, "users/regular"), {
        email: "fixture-07bf055157@example.org",
        displayName: "Reg User",
        role: null,
        grants: [],
      }),
      setDoc(doc(database, "users/orientation-staff"), {
        email: "fixture-686959c1a1@example.org",
        displayName: "Orientation Staff",
        role: null,
        grants: [{ role: "staff" }],
      }),
      setDoc(doc(database, "users/editor"), {
        email: "editor@example.org",
        displayName: "Eden Editor",
        role: null,
        grants: [{ role: "editor" }],
      }),
      setDoc(doc(database, "users/contributor"), {
        email: "contributor@example.org",
        displayName: "Casey Contributor",
        role: null,
        grants: [{ role: "contributor" }],
      }),
      setDoc(doc(database, "users/contributor-two"), {
        email: "contributor-two@example.org",
        displayName: "Taylor Contributor",
        role: null,
        grants: [{ role: "contributor" }],
      }),
      setDoc(doc(database, "users/scoped-editor"), {
        email: "fixture-d5543fcce1@example.org",
        displayName: "Nia News",
        role: null,
        grants: [{ role: "editor", sections: ["news"] }],
      }),
      setDoc(doc(database, "users/inactive-editor"), {
        email: "inactive-editor@example.org",
        displayName: "Inactive Editor",
        active: false,
        role: null,
        grants: [{ role: "editor" }],
      }),
      setDoc(doc(database, "users/other"), {
        email: "fixture-36e6221c49@example.org",
        displayName: "Otto Other",
        role: null,
        grants: [],
      }),
      setDoc(doc(database, "users/inactive-admin"), {
        email: "inactive-admin@example.org",
        displayName: "Inactive Admin",
        active: false,
        tokensValidAfter: 1,
        role: "admin",
        grants: [],
      }),
      setDoc(doc(database, "users/inactive-regular"), {
        email: "inactive-regular@example.org",
        displayName: "Inactive Regular",
        active: false,
        tokensValidAfter: 1,
        role: null,
        grants: [],
      }),
      setDoc(doc(database, "users/revoked-admin"), {
        email: "fixture-8784a2e323@example.org",
        displayName: "Revoked Admin",
        active: true,
        tokensValidAfter: revokedAt,
        role: "admin",
        grants: [],
      }),
      setDoc(doc(database, "cmsVersionHistory/v1"), {
        field: "title",
        action: "edit",
      }),
      setDoc(doc(database, "admin_logs/l1"), {
        action: "roles.grant",
      }),
      setDoc(doc(database, "activity_logs/al1"), {
        action: "auth.login",
      }),
      setDoc(doc(database, "system_errors/e1"), {
        message: "boom",
      }),
      setDoc(doc(database, "cmsPublishQueue/q1"), {
        status: "pending",
        triggeredBy: "admin",
      }),
      setDoc(doc(database, "cmsPreviewQueue/q1"), {
        status: "ready",
        pageId: "home",
        sourceVersion: 3,
        snapshot: { id: "home", title: "Private draft", version: 3 },
      }),
      setDoc(doc(database, "cmsPages/home"), {
        id: "home",
        title: "Home",
        status: "draft",
        createdBy: "contributor",
      }),
      setDoc(doc(database, "cmsPages/contact"), {
        id: "contact",
        title: "Contact",
        status: "draft",
        createdBy: "contributor-two",
      }),
      setDoc(doc(database, "cmsPosts/p1"), {
        id: "p1",
        type: "post",
        title: "A post",
        status: "draft",
        createdBy: "contributor",
      }),
      setDoc(doc(database, "cmsPosts/foreign-post"), {
        id: "foreign-post",
        type: "post",
        title: "Another contributor's post",
        status: "draft",
        createdBy: "contributor-two",
      }),
      setDoc(doc(database, "cmsSettings/fixture-settings"), {
        values: { enabled: true },
        version: 1,
      }),
      setDoc(doc(database, "cmsPages/home/mediaUsage/working"), {
        state: "working",
        sourceVersion: 1,
        assetIds: ["asset-1"],
        occurrenceCount: 1,
      }),
      setDoc(doc(database, "cmsPosts/p1/mediaUsage/published"), {
        state: "published",
        sourceVersion: 1,
        assetIds: ["asset-1"],
        occurrenceCount: 1,
      }),
      setDoc(doc(database, "cmsPages/home/mediaUsage/deployed-1"), {
        state: "deployed",
        generation: 1,
        assetIds: ["asset-1"],
        occurrenceCount: 1,
      }),
      setDoc(doc(database, "cmsSettings/site/mediaUsage/deployed-1"), {
        state: "deployed",
        generation: 1,
        assetIds: ["asset-1"],
        occurrenceCount: 1,
      }),
      setDoc(doc(database, "cmsSettings/fixture-settings/mediaUsage/working"), {
        state: "working",
        sourceVersion: 1,
        assetIds: ["asset-1"],
        occurrenceCount: 1,
      }),
      setDoc(doc(database, "media_assets/asset-1"), {
        id: "asset-1",
        name: "Studio",
        lifecycle: "active",
      }),
      setDoc(doc(database, "media_assets_public/asset-1"), {
        url: "https://media.njpbs.org/cms-media/news/asset-1/hash.png",
        altText: null,
        mimeType: "image/png",
        width: 1,
        height: 1,
      }),
      setDoc(doc(database, "system/media/hashOwners/hash-1"), {
        state: "committed",
        assetId: "asset-1",
      }),
      setDoc(doc(database, "system/media/replacements/asset-1"), {
        operation: "replacement",
        state: "reserved",
        assetId: "asset-1",
      }),
      setDoc(doc(database, "sections/watch"), {
        id: "watch",
        label: "Watch",
        description: "Live, on-demand, schedule and kids pages.",
        order: 1,
      }),
      setDoc(doc(database, "system/billing"), {
        disabled: false,
      }),
      setDoc(doc(database, "system/bootstrap"), {
        completed: true,
        initialSuperAdmin: "super",
      }),
      setDoc(doc(database, "staffAccessRequests/requester-1"), {
        uid: "requester-1",
        email: "requester@example.org",
        state: "pending",
      }),
      setDoc(doc(database, "staffAccessEmailOutbox/requester-1-1-received"), {
        uid: "requester-1",
        state: "pending",
      }),
      setDoc(doc(database, "staffAccessNotificationOutbox/requester-1--1--pending"), {
        uid: "requester-1",
        state: "pending",
      }),
      setDoc(doc(database, "staffAccessRequestCounters/requester-1"), {
        lastVersion: 1,
      }),
      setDoc(doc(database, "staffAccessNotificationCooldowns/email-hash"), {
        lastNotifiedAt: new Date(),
      }),
      setDoc(doc(database, "staffSignInRefusedCooldowns/editor-1"), {
        lastRefusedAt: new Date(),
      }),
      setDoc(doc(database, `bug_reports/br_${"a".repeat(32)}`), {
        reporter: { uid: "regular" },
        status: "open",
      }),
      setDoc(doc(database, "bugReportDeliveryOutbox/delivery-1"), {
        reportId: `br_${"a".repeat(32)}`,
        status: "pending",
      }),
      setDoc(doc(database, "bugReportMutationReceipts/mutation-1"), {
        reportId: `br_${"a".repeat(32)}`,
        actorUid: "admin",
      }),
      setDoc(doc(database, "bugReportRateLimits/regular"), {
        windowCount: 1,
      }),
      setDoc(doc(database, "staffPasswordResetRequests/email-hash"), {
        lastRequestedAt: new Date(),
      }),
      setDoc(doc(database, "cmsStaffRecords/regular"), {
        uid: "regular",
        authorId: AUTHOR_ID,
        email: "regular@example.org",
        status: "active",
      }),
      setDoc(doc(database, `cmsAuthorProfiles/${AUTHOR_ID}`), {
        authorId: AUTHOR_ID,
        uid: "regular",
        displayName: "Regular Person",
        visibility: "published",
        slug: "regular-person",
      }),
      setDoc(doc(database, `cmsAuthorProfilesPublic/${AUTHOR_ID}`), {
        authorId: AUTHOR_ID,
        slug: "regular-person",
        displayName: "Regular Person",
      }),
      setDoc(doc(database, "cmsAuthorSlugs/regular-person"), {
        slug: "regular-person",
        authorId: AUTHOR_ID,
        state: "active",
      }),
    ]);
  });
});

function db(uid, tokenOptions = {}) {
  return uid
    ? testEnv
        .authenticatedContext(uid, { auth_time: recentAuthTime, ...tokenOptions })
        .firestore()
    : testEnv.unauthenticatedContext().firestore();
}

describe("maximum session age", () => {
  it("accepts a session 59 days after sign-in", async () => {
    const database = db("regular", { auth_time: nowSeconds - 59 * DAY_SECONDS });
    await assertSucceeds(getDoc(doc(database, "users/regular")));
  });

  it("refuses a session 60 days after sign-in, for every role", async () => {
    const auth_time = nowSeconds - 60 * DAY_SECONDS;
    await assertFails(getDoc(doc(db("regular", { auth_time }), "users/regular")));
    await assertFails(getDoc(doc(db("admin", { auth_time }), "users/regular")));
    await assertFails(getDoc(doc(db("super", { auth_time }), "users/regular")));
  });
});

describe("users profile reads", () => {
  it("self reads own profile", async () => {
    const database = db("regular");
    await assertSucceeds(getDoc(doc(database, "users/regular")));
  });

  it("authed user cannot read another profile", async () => {
    const database = db("regular");
    await assertFails(getDoc(doc(database, "users/other")));
  });

  it("admin reads any profile", async () => {
    const database = db("admin");
    await assertSucceeds(getDoc(doc(database, "users/other")));
  });

  it("inactive admin cannot read another profile", async () => {
    const database = db("inactive-admin");
    await assertFails(getDoc(doc(database, "users/other")));
  });

  it("inactive user cannot read their own profile", async () => {
    const database = db("inactive-regular");
    await assertFails(getDoc(doc(database, "users/inactive-regular")));
  });

  it("super_admin reads any profile", async () => {
    const database = db("super");
    await assertSucceeds(getDoc(doc(database, "users/other")));
  });

  it("unauthenticated cannot read a profile", async () => {
    const database = db();
    await assertFails(getDoc(doc(database, "users/regular")));
  });
});

describe("server-owned profile creation", () => {
  it("denies direct profile creation with someone else's email", async () => {
    const database = db("newbie", { email: "fixture-40d6ec0985@example.org" });
    await assertFails(
      setDoc(doc(database, "users/newbie"), {
        email: "fixture-4d461deb19@example.org",
        displayName: "New User",
        createdAt: "now",
      }),
    );
  });

  it("denies direct profile creation with the caller's own email", async () => {
    const database = db("newbie", { email: "fixture-40d6ec0985@example.org" });
    await assertFails(
      setDoc(doc(database, "users/newbie"), {
        email: "fixture-40d6ec0985@example.org",
        displayName: "New User",
        createdAt: "now",
      }),
    );
  });

  it("denies direct profile creation without an email", async () => {
    const database = db("newbie-no-email");
    await assertFails(
      setDoc(doc(database, "users/newbie-no-email"), {
        displayName: "New User",
        createdAt: "now",
      }),
    );
  });

  it("denies direct profile creation containing saved library views", async () => {
    const database = db("newbie-views");
    await assertFails(
      setDoc(
        doc(database, "users/newbie-views"),
        {
          preferences: {
            contentLibraryViews: [
              { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
            ],
          },
        },
        { mergeFields: ["preferences.contentLibraryViews"] },
      ),
    );
  });

  it("denies direct profile creation containing a display preference", async () => {
    const database = db("newbie-display");
    await assertFails(
      setDoc(
        doc(database, "users/newbie-display"),
        {
          preferences: {
            display: { controlPresentation: "icons" },
          },
        },
        { mergeFields: ["preferences.display.controlPresentation"] },
      ),
    );
  });

  it("denies direct profile creation even when role is explicitly null", async () => {
    const database = db("newbie2", { email: "fixture-53b818a6c5@example.org" });
    await assertFails(
      setDoc(doc(database, "users/newbie2"), {
        email: "fixture-53b818a6c5@example.org",
        displayName: "New User 2",
        role: null,
      }),
    );
  });

  it("self-create setting role is denied", async () => {
    const database = db("attacker");
    await assertFails(
      setDoc(doc(database, "users/attacker"), {
        email: "fixture-e91a227bcb@example.org",
        role: "admin",
      }),
    );
  });

  it("self-create setting grants is denied", async () => {
    const database = db("attacker2");
    await assertFails(
      setDoc(doc(database, "users/attacker2"), {
        email: "fixture-9ecfe9de42@example.org",
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    );
  });
});

describe("self-update escalation guard", () => {
  it("self-update of a normal field succeeds", async () => {
    const database = db("regular");
    await assertSucceeds(
      updateDoc(doc(database, "users/regular"), {
        displayName: "Reg Renamed",
      }),
    );
  });

  it("self-update of saved content-library views succeeds", async () => {
    const database = db("regular");
    await assertSucceeds(
      updateDoc(doc(database, "users/regular"), {
        "preferences.contentLibraryViews": [
          {
            id: "my-drafts",
            name: "My drafts",
            query: "owner=me&status=draft&v=1",
          },
        ],
      }),
    );
  });

  it("self-update of the display preference succeeds", async () => {
    const database = db("regular");
    await assertSucceeds(
      updateDoc(doc(database, "users/regular"), {
        "preferences.display.controlPresentation": "icons",
      }),
    );
  });

  it("a user cannot update another person's display preference", async () => {
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        "preferences.display.controlPresentation": "icons",
      }),
    );
  });

  it("denies a display preference update combined with a privilege change", async () => {
    const database = db("regular");
    const privilegeChanges = [
      ["role", "admin"],
      ["grants", [{ role: "editor" }]],
      ["active", false],
      ["tokensValidAfter", 200],
    ];

    for (const [field, value] of privilegeChanges) {
      await assertFails(
        updateDoc(doc(database, "users/regular"), {
          "preferences.display.controlPresentation": "icons",
          [field]: value,
        }),
      );
    }
  });

  it("a user cannot update another person's saved content-library views", async () => {
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        "preferences.contentLibraryViews": [
          { id: "tampered", name: "Tampered", query: "v=1" },
        ],
      }),
    );
  });

  // #195: a display jobTitle carries no authorization weight, so a user may set their
  // own byline freely; it is a non-privilege field like displayName.
  it("self-update of a display jobTitle succeeds", async () => {
    const database = db("regular");
    await assertSucceeds(
      updateDoc(doc(database, "users/regular"), {
        jobTitle: "Newsroom lead",
      }),
    );
  });

  // A jobTitle write cannot be used to smuggle a role change past the guard: the moment
  // the write also touches role, affectedKeys hits a privilege key and it is denied.
  it("self-update setting a jobTitle alongside a role is denied", async () => {
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, "users/regular"), {
        jobTitle: "Editor in chief",
        role: "admin",
      }),
    );
  });

  it("owner update changing email to own token email succeeds", async () => {
    const database = db("regular", { email: "fixture-90c618dc5c@example.org" });
    await assertSucceeds(
      updateDoc(doc(database, "users/regular"), {
        email: "fixture-90c618dc5c@example.org",
      }),
    );
  });

  it("self-update adding role is denied", async () => {
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, "users/regular"), {
        role: "admin",
      }),
    );
  });

  it("self-update adding grants is denied", async () => {
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, "users/regular"), {
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    );
  });

  it("inactive user cannot reactivate their profile", async () => {
    const database = db("inactive-regular");
    await assertFails(
      updateDoc(doc(database, "users/inactive-regular"), {
        active: true,
        tokensValidAfter: 0,
      }),
    );
  });

  it("inactive user cannot update a non-privilege profile field", async () => {
    const database = db("inactive-regular");
    await assertFails(
      updateDoc(doc(database, "users/inactive-regular"), {
        displayName: "Back again",
      }),
    );
  });

  it("field-aliasing via merge set is denied", async () => {
    const database = db("regular");
    await assertFails(
      setDoc(
        doc(database, "users/regular"),
        {
          displayName: "x",
          role: "admin",
        },
        { merge: true },
      ),
    );
  });
});


describe("custom navigation preferences", () => {
  const link = (overrides = {}) => ({
    id: "custom:newsroom",
    label: "Newsroom",
    kind: "link",
    destination: { kind: "url", url: "https://example.test/news" },
    ...overrides,
  });
  const navigation = (custom = [link()]) => ({
    version: 4,
    order: ["home", ...custom.map((item) => item.id), "schedule"],
    hidden: [],
    custom,
  });
  const write = (value, uid = "regular", target = uid, fields = {}) =>
    updateDoc(doc(db(uid), "users", target), {
      "preferences.navigation": value,
      ...fields,
    });
  // Custom admission now belongs to the CMS API. Rules only protect client arrangement.
  const seedNavigation = async (value, uid = "regular") => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", uid), {
        preferences: { navigation: value },
      }, { mergeFields: ["preferences.navigation"] });
    });
  };
  const rearranged = (value) => ({ ...value, order: [...value.order].reverse() });
  const writeStored = async (value, uid = "regular") => {
    await seedNavigation(value, uid);
    return write(rearranged(value), uid);
  };

  it("lets an owner save the gated live production navigation ID without granting studio record access", async () => {
    const value = { ...navigation([]), order: ["home", "schedule", "live-production"] };
    await assertSucceeds(writeStored(value));
    await assertSucceeds(write({ ...value, hidden: ["live-production"] }));
    await assertFails(getDoc(doc(db("regular"), "liveProductionSessions", "rehearsal")));
  });

  it("lets admitted owners arrange navigation while reset remains server-owned", async () => {
    await assertSucceeds(writeStored(navigation()));
    await assertSucceeds(write({ ...navigation(), hidden: ["custom:newsroom"] }));
    await assertFails(write(deleteField()));
    await assertSucceeds(writeStored(navigation([])));
    await assertFails(write(deleteField()));
    await assertSucceeds(writeStored(navigation(), "admin"));
    await assertSucceeds(writeStored(navigation(), "super"));
  });

  it.each(["regular", "admin", "super"])(
    "denies %s changing another staff member's navigation",
    async (uid) => {
      await seedNavigation(navigation(), "other");
      await assertFails(write(rearranged(navigation()), uid, "other"));
    },
  );

  it("denies navigation writes from missing, inactive, revoked or anonymous sessions", async () => {
    await assertFails(write(navigation(), "newbie"));
    await seedNavigation(navigation(), "inactive-regular");
    await assertFails(write(rearranged(navigation()), "inactive-regular"));
    await seedNavigation(navigation(), "revoked-admin");
    await assertFails(
      updateDoc(doc(db("revoked-admin", { auth_time: revokedAt }), "users/revoked-admin"), {
        "preferences.navigation": rearranged(navigation()),
      }),
    );
    await seedNavigation(navigation());
    await assertFails(write(rearranged(navigation()), null, "regular"));
  });

  it.each([
    ["role", "admin"],
    ["grants", [{ role: "editor" }]],
    ["active", false],
    ["tokensValidAfter", 200],
    ["displayName", "Changed with navigation"],
    ["preferences.display.controlPresentation", "icons"],
  ])("denies a navigation write combined with %s", async (field, value) => {
    await seedNavigation(navigation());
    await assertFails(write(rearranged(navigation()), "regular", "regular", { [field]: value }));
  });

  it("retains version 3 saves and permits migration without changing other preferences", async () => {
    await assertSucceeds(
      updateDoc(doc(db("regular"), "users/regular"), {
        "preferences.display.controlPresentation": "text",
      }),
    );
    await assertSucceeds(write({ version: 3, order: ["home", "voiceovers"], hidden: ["media"] }));
    await assertSucceeds(write(navigation([])));
    await assertSucceeds(writeStored(navigation()));
    const saved = await getDoc(doc(db("regular"), "users/regular"));
    expect(saved.data().preferences.display.controlPresentation).toBe("text");
    expect(saved.data().preferences.navigation.version).toBe(4);
  });

  it("refuses a stale v3 overwrite and client reset after server custom admission", async () => {
    await assertSucceeds(writeStored(navigation([link()])));
    await assertFails(write({ version: 3, order: ["home"], hidden: [] }));
    const saved = await getDoc(doc(db("regular"), "users/regular"));
    expect(saved.data().preferences.navigation.custom).toHaveLength(1);
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), { "preferences.navigation": deleteField() }));
  });

  it("arranges ten server-stored links and ten empty sections within the evaluation budget", async () => {
    const links = Array.from({ length: 10 }, (_, index) =>
      link({ id: `custom:link-${index}`, icon: "external-link" }),
    );
    await assertSucceeds(writeStored(navigation(links)));
    await assertFails(write(navigation([
      ...links.slice(0, -1),
      { ...links.at(-1), destination: { kind: "url", url: "javascript:alert(1)" } },
    ])));
    const sections = links.map(({ id, label }) => ({ id, label, kind: "section", icon: "folder", links: [] }));
    await assertSucceeds(writeStored(navigation(sections)));
  });

  it("arranges server-stored section children and rejects custom changes", async () => {
    const links = Array.from({ length: 9 }, (_, index) =>
      link({ id: `custom:child-${index}`, icon: "file" }),
    );
    const section = { id: "custom:desk", label: "Desk", kind: "section", icon: "folder", links };
    await seedNavigation(navigation([section]));
    await assertSucceeds(write({ ...rearranged(navigation([section])), hidden: [links[8].id] }));
    const builtInIds = [
      "home", "pages", "posts", "library", "media", "editorial-queue", "activity",
      "schedule", "resources", "staff-profiles", "staff-access", "analytics",
      "reports", "admin-settings", "around-nj",
    ];
    const allIds = [...builtInIds, section.id, ...links.map((item) => item.id)];
    const fullArrangement = { ...navigation([section]), order: allIds };
    await seedNavigation(fullArrangement);
    await assertSucceeds(write({
      ...rearranged(fullArrangement),
      hidden: allIds.filter((id) => id !== "home"),
    }));
    await assertFails(write(navigation([{ ...section, links: [...links, link()] }])));
    await assertFails(write(navigation(Array.from({ length: 11 }, (_, index) => link({ id: `custom:${index}` })))));
  });

  it("denies last-child and nested-section mutations of server custom items", async () => {
    const links = Array.from({ length: 9 }, (_, index) => link({ id: `custom:child-${index}` }));
    const section = { id: "custom:desk", label: "Desk", kind: "section", links };
    await seedNavigation(navigation([section]));
    await assertFails(write(navigation([{ ...section, links: [...links.slice(0, 8), link({ id: "custom:last", destination: { kind: "url", url: "javascript:alert(1)" } })] }])));
    await assertFails(write(navigation([{ ...section, links: [{ id: "custom:nested", label: "Nested", kind: "section", links: [] }] }])));
    await assertFails(write(navigation([{ ...section, links: [link({ label: "" }), link({ id: "custom:valid-child" })] }])));
  });

  it.each([
    "/", "/?tab=staff", "/#top", "/content/pages/home", "/media/images?search=NJ#results",
    "/admin/settings", "/account/profile", "/premiere/connect",
    "https://example.test", "https://example.test:8443/news?q=NJ#top",
  ])("arranges a server-stored link with safe URL %s", async (url) => {
    await assertSucceeds(writeStored(navigation([link({ destination: { kind: "url", url } })])));
  });

  it.each([
    "http://example.test", "javascript:alert(1)", "data:text/html,hello", "mailto:staff@example.test",
    "//example.test", "/\\example.test", "https://staff:secret@example.test", "https://example.test\\@evil.test",
    "https://example.test/has space", "https://example.test/\nnext", "https://example.test/é",
    "/unknown", "/content-other", "/content/../admin", "/content/./pages", "/content/%2E%2e/admin",
    "/content/%2fexample.test", "/content/%5Cexample.test", "/content/\tpages",
    "https://example.test/../other", "https://example.test/%2Fother",
    `https://example.test/${"a".repeat(2048)}`,
  ])("denies direct client custom admission with unsafe URL %s", async (url) => {
    await assertFails(write(navigation([link({ destination: { kind: "url", url } })])));
  });

  it.each(["post", "page"])("arranges server-stored %s destinations with bounded IDs", async (kind) => {
    await assertSucceeds(writeStored(navigation([link({ destination: { kind, id: "news_2026-10" } })])));
    await assertSucceeds(writeStored(navigation([link({ destination: { kind, id: "a".repeat(128) } })])));
    await assertFails(write(navigation([link({ destination: { kind, id: "a".repeat(129) } })])));
    await assertFails(write(navigation([link({ destination: { kind, id: "../other" } })])));
  });

  it.each([
    { id: "home" }, { id: `custom:${"a".repeat(74)}` }, { id: "custom:" },
    { label: "" }, { label: " \t\n" }, { label: "\u00a0\u2003" }, { label: "a".repeat(61) },
    { icon: "invented-icon" }, { kind: "unknown" }, { grants: [{ role: "editor" }] },
    { destination: { kind: "url", url: "https://example.test", extra: true } },
    { destination: { kind: "post", id: "post-1", url: "https://example.test" } },
    { destination: { kind: "section", id: "post-1" } }, { destination: null },
  ])("denies direct client custom admission with malformed link %j", async (overrides) => {
    await assertFails(write(navigation([link(overrides)])));
  });

  it("arranges a server-stored link at the label and custom ID limits", async () => {
    await assertSucceeds(writeStored(navigation([link({ id: `custom:${"a".repeat(73)}`, label: "a".repeat(60) })])));
  });

  it.each([
    { id: "custom:desk", label: "Desk", kind: "section", links: "invalid" },
    { id: "custom:desk", label: "Desk", kind: "section", links: [], destination: { kind: "url", url: "/" } },
    { id: "custom:desk", label: " ", kind: "section", links: [] },
  ])("denies direct client custom admission with malformed section %j", async (section) => {
    await assertFails(write(navigation([section])));
  });

  it("denies duplicate custom mutations and non-string or unknown arrangement IDs", async () => {
    await seedNavigation(navigation());
    await assertFails(write(navigation([link(), link()])));
    await assertFails(write(navigation([{ id: "custom:desk", label: "Desk", kind: "section", links: [link(), link()] }])));
    await assertFails(write({ ...navigation(), order: [1] }));
    await assertFails(write({ ...navigation(), hidden: [{ role: "editor" }] }));
    await assertFails(write({ ...navigation(), order: [""] }));
    await assertFails(write({ ...navigation(), hidden: ["retired-destination"] }));
  });

  it.each(["order", "hidden"])("denies duplicate IDs in version 4 %s", async (field) => {
    const saved = navigation();
    await seedNavigation(saved);
    await assertFails(write({ ...rearranged(saved), [field]: ["home", "home"] }));
  });

  it.each(["order", "hidden"])("denies oversized repeated IDs in version 4 %s", async (field) => {
    const saved = navigation();
    await seedNavigation(saved);
    await assertFails(write({ ...rearranged(saved), [field]: Array(1_000).fill("home") }));
  });

  it("retains legacy version 3 duplicate-ID handling", async () => {
    await assertSucceeds(write({
      version: 3,
      order: ["home", "home", "voiceovers"],
      hidden: ["media", "media"],
    }));
  });

  it("denies direct client admission of otherwise valid custom links", async () => {
    await assertFails(write(navigation()));
  });

  it("denies any client change to server-owned custom items or children", async () => {
    const first = link({ id: "custom:first" });
    const second = link({ id: "custom:second" });
    const children = [link({ id: "custom:child-a" }), link({ id: "custom:child-b" })];
    const section = { id: "custom:desk", label: "Desk", kind: "section", links: children };
    const saved = navigation([first, second, section]);
    await seedNavigation(saved);
    const mutations = [
      [{ ...first, label: "Changed" }, second, section],
      [{ ...first, icon: "file" }, second, section],
      [{ ...first, destination: { kind: "url", url: "https://example.test/changed" } }, second, section],
      [first, second, section, link({ id: "custom:added" })],
      [second, section],
      [second, first, section],
      [first, second, { ...section, links: [...children].reverse() }],
      [first, second, { ...section, links: [children[0]] }],
      [first, second, { ...section, links: [...children, link({ id: "custom:child-c" })] }],
      [first, second, { ...section, links: [children[0], { ...children[1], destination: { kind: "url", url: "javascript:alert(1)" } }] }],
    ];
    for (const custom of mutations) {
      await assertFails(write({ ...rearranged(saved), custom }));
    }
    await assertFails(write({ ...rearranged(saved), custom: mutations[0] }, "regular", "regular", {
      role: "admin",
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation.custom": deleteField(),
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      preferences: deleteField(),
    }));
  });

  it.each([
    null, [], { version: 5, order: [], hidden: [], custom: [] },
    { version: 4, order: [], hidden: [] }, { version: 4, order: [], hidden: [], custom: {} },
    { version: 4, order: [], hidden: [], custom: [null] },
    { version: 4, order: [], hidden: [], custom: ["link"] },
    { version: 4, order: [], hidden: [], custom: [], extra: true },
  ])("denies malformed navigation records %j", async (value) => {
    await assertFails(write(value));
  });
});

describe("shared navigation items", () => {
  const item = (overrides = {}) => ({
    id: "custom:shared-news",
    label: "Shared news",
    kind: "link",
    destination: { kind: "url", url: "https://example.test/news" },
    ...overrides,
  });
  const body = (entry = item(), extra = {}) => ({
    ownerUid: "regular",
    ownerName: "Reg User",
    status: "active",
    item: entry,
    updatedAt: serverTimestamp(),
    ...extra,
  });
  const shareRef = (uid, id = "custom:shared-news") => doc(db(uid), "navigationShares", id);
  const seedShare = async (entry = item(), extra = {}) => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "navigationShares", entry.id), {
        ownerUid: "regular",
        ownerName: "Reg User",
        status: "active",
        item: entry,
        updatedAt: Timestamp.fromMillis(1_000),
        ...extra,
      });
    });
  };
  const navigation = (custom = [], shared = []) => ({
    version: 4,
    order: ["home", ...custom.map((entry) => entry.id), ...shared],
    hidden: [],
    custom,
    ...(shared.length ? { shared } : {}),
  });
  const seedNavigation = async (value, uid = "regular") => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users", uid), {
        preferences: { navigation: value },
      }, { mergeFields: ["preferences.navigation"] });
    });
  };

  it.each([
    "/", "/?tab=staff", "/#top", "/content/pages/home", "/media/images?search=NJ#results",
    "/admin/settings", "/account/profile", "/premiere/connect",
    "https://example.test", "https://example.test:8443/news?q=NJ#top",
  ])("denies a client share create for safe URL %s", async (url) => {
    await assertFails(setDoc(shareRef("regular"), body(item({ destination: { kind: "url", url } }))));
  });

  it.each([
    "http://example.test", "javascript:alert(1)", "data:text/html,hello", "mailto:staff@example.test",
    "//example.test", "/\\example.test", "https://staff:secret@example.test", "https://example.test\\@evil.test",
    "https://example.test/has space", "https://example.test/\nnext", "https://example.test/é",
    "/unknown", "/content-other", "/content/../admin", "/content/./pages", "/content/%2E%2e/admin",
    "/content/%2fexample.test", "/content/%5Cexample.test", "/content/\tpages",
    "https://example.test/../other", "https://example.test/%2Fother",
    `https://example.test/${"a".repeat(2048)}`,
  ])("denies a shared link with unsafe URL %s", async (url) => {
    await assertFails(setDoc(shareRef("regular"), body(item({ destination: { kind: "url", url } }))));
  });

  it("denies a client share of a section and of an unsafe child", async () => {
    const section = {
      id: "custom:shared-desk",
      label: "Shared desk",
      kind: "section",
      icon: "folder",
      links: [item({ id: "custom:shared-child", icon: "file" })],
    };
    await assertFails(setDoc(shareRef("regular", section.id), body(section)));
    const unsafe = {
      id: "custom:unsafe-desk",
      label: "Unsafe desk",
      kind: "section",
      links: [item({ id: "custom:unsafe-child", destination: { kind: "url", url: "javascript:alert(1)" } })],
    };
    await assertFails(setDoc(shareRef("regular", unsafe.id), body(unsafe)));
  });

  it.each([
    { label: "" },
    { label: " \t\n" },
    { label: "\u00a0\u2003" },
    { label: "a".repeat(61) },
    { icon: "invented-icon" },
    { id: "home" },
    { destination: { kind: "url", url: "https://example.test", extra: true } },
  ])("denies a malformed shared link %j", async (overrides) => {
    const entry = item(overrides);
    await assertFails(setDoc(doc(db("regular"), "navigationShares", entry.id), body(entry)));
  });

  it("denies a client share at the label and id limits and denies the next character", async () => {
    const entry = item({ id: `custom:${"a".repeat(73)}`, label: "a".repeat(60), icon: "link" });
    await assertFails(setDoc(shareRef("regular", entry.id), body(entry)));
    const over = item({ id: `custom:${"b".repeat(74)}` });
    await assertFails(setDoc(doc(db("regular"), "navigationShares", over.id), body(over)));
  });

  it("lets admitted staff list shares and denies anonymous, inactive, and revoked reads", async () => {
    await seedShare();
    await assertSucceeds(getDocs(query(collection(db("regular"), "navigationShares"), limit(20))));
    await assertSucceeds(getDoc(shareRef("editor")));
    await assertFails(getDoc(doc(db(null), "navigationShares/custom:shared-news")));
    await assertFails(getDocs(collection(db("inactive-regular"), "navigationShares")));
    await assertFails(getDoc(doc(db("revoked-admin", { auth_time: revokedAt }), "navigationShares/custom:shared-news")));
  });

  it("lets admitted staff query active shares and read a referenced tombstone by id", async () => {
    await seedShare();
    await seedShare(item({ id: "custom:retired", label: "Retired bulletin" }), {
      status: "removed",
      removedReason: "unshared",
    });
    const active = await assertSucceeds(getDocs(query(
      collection(db("regular"), "navigationShares"),
      where("status", "==", "active"),
    )));
    expect(active.docs.map((entry) => entry.id)).toEqual(["custom:shared-news"]);
    const tombstones = await assertSucceeds(getDocs(query(
      collection(db("editor"), "navigationShares"),
      where(documentId(), "in", ["custom:retired"]),
    )));
    expect(tombstones.docs.map((entry) => entry.id)).toEqual(["custom:retired"]);
    await assertFails(getDocs(query(collection(db(null), "navigationShares"), where("status", "==", "active"))));
    await assertFails(getDocs(query(
      collection(db("inactive-regular"), "navigationShares"),
      where(documentId(), "in", ["custom:retired"]),
    )));
    await assertFails(getDocs(query(
      collection(db("revoked-admin", { auth_time: revokedAt }), "navigationShares"),
      where("status", "==", "active"),
    )));
    await assertFails(getDocs(query(
      collection(db("revoked-admin", { auth_time: revokedAt }), "navigationShares"),
      where(documentId(), "in", ["custom:retired"]),
    )));
  });

  it("denies a client update, a write as another account, and a delete", async () => {
    await seedShare();
    await assertFails(setDoc(shareRef("regular"), body(item({ label: "Updated news" }))));
    await assertFails(setDoc(shareRef("regular"), {}));
    await assertFails(setDoc(shareRef("other"), body(item({ label: "Taken" }), { ownerUid: "other" })));
    await assertFails(setDoc(shareRef("admin"), body(item({ label: "Admin edit" }))));
    await assertFails(setDoc(shareRef("super"), body(item({ label: "Super edit" }))));
    await assertFails(setDoc(shareRef("regular"), body(item(), { ownerUid: "other" })));
    await assertFails(deleteDoc(shareRef("regular")));
    await assertFails(deleteDoc(shareRef("admin")));
  });

  it("denies a client tombstone for either removal reason", async () => {
    await seedShare();
    await assertFails(setDoc(shareRef("regular"), body(item(), { status: "removed", removedReason: "unshared" })));
    await seedShare();
    await assertFails(setDoc(shareRef("regular"), body(item(), { status: "removed", removedReason: "deleted" })));
    await assertFails(setDoc(shareRef("regular"), body(item(), { status: "removed", removedReason: "hidden" })));
    await assertFails(setDoc(shareRef("regular"), body(item(), { status: "removed" })));
    await assertFails(setDoc(shareRef("other", "custom:fresh"), body(item({ id: "custom:fresh" }), {
      ownerUid: "other",
      status: "removed",
      removedReason: "deleted",
    })));
  });

  it("lets an owner turn ten shared ids on and denies eleven, foreign ids, and custom edits", async () => {
    const links = Array.from({ length: 10 }, (_, index) => item({
      id: `custom:link-${index}`,
      icon: "external-link",
    }));
    const shared = Array.from({ length: 10 }, (_, index) => `custom:share-${index}`);
    const saved = navigation(links, shared);
    await seedNavigation(saved);
    await assertSucceeds(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": { ...saved, order: [...saved.order].reverse(), hidden: [shared[0]] },
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": { ...saved, shared: [...shared, "custom:share-10"] },
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": { ...saved, order: [...saved.order, "custom:missing"] },
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": { ...saved, shared: ["custom:share-0", "custom:share-0"] },
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": { ...saved, shared: ["home"] },
    }));
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": {
        ...saved,
        custom: links.map((entry, index) => index === 0 ? { ...entry, label: "Changed" } : entry),
      },
    }));
    await assertFails(updateDoc(doc(db("admin"), "users/regular"), {
      "preferences.navigation": { ...saved, order: [...saved.order].reverse() },
    }));
    await assertFails(updateDoc(doc(db("other"), "users/regular"), {
      "preferences.navigation": { ...saved, order: [...saved.order].reverse() },
    }));
  });

  it("denies one shared element that joins into two ids and still allows an empty list", async () => {
    const links = [item({ id: "custom:link-0", icon: "external-link" })];
    const saved = navigation(links);
    await seedNavigation(saved);
    await assertFails(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": {
        version: 4,
        order: ["home", "custom:link-0"],
        hidden: [],
        custom: links,
        shared: ["custom:a,custom:b"],
      },
    }));
    await assertSucceeds(updateDoc(doc(db("regular"), "users/regular"), {
      "preferences.navigation": {
        version: 4,
        order: ["home", "custom:link-0"],
        hidden: [],
        custom: links,
        shared: [],
      },
    }));
  });
});

describe("admin cannot grant", () => {
  it("admin updating another user's role is denied", async () => {
    const database = db("admin");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        role: "admin",
      }),
    );
  });

  it("admin updating another user's grants is denied", async () => {
    const database = db("admin");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        grants: [{ role: "editor", sections: ["news"] }],
      }),
    );
  });

  it("admin updating a non-privilege field succeeds", async () => {
    const database = db("admin");
    await assertSucceeds(
      updateDoc(doc(database, "users/other"), {
        displayName: "Renamed By Admin",
      }),
    );
  });

  // #195: a jobTitle is a display field, so an admin editing another user's byline is a
  // non-privilege write and is allowed; it grants no authorization.
  it("admin updating another user's display jobTitle succeeds", async () => {
    const database = db("admin");
    await assertSucceeds(
      updateDoc(doc(database, "users/other"), {
        jobTitle: "Segment producer",
      }),
    );
  });

  it("admin updating another user's display preference remains a non-privilege write", async () => {
    const database = db("admin");
    await assertSucceeds(
      updateDoc(doc(database, "users/other"), {
        "preferences.display.controlPresentation": "icons",
      }),
    );
  });

  it("admin changing another user's email is denied", async () => {
    const database = db("admin", { email: "fixture-51fddd0c91@example.org" });
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        email: "fixture-6465099eff@example.org",
      }),
    );
  });

  it("admin leaving another user's email unchanged succeeds", async () => {
    const database = db("admin", { email: "fixture-51fddd0c91@example.org" });
    await assertSucceeds(
      updateDoc(doc(database, "users/other"), {
        email: "fixture-36e6221c49@example.org",
        displayName: "Renamed By Admin",
      }),
    );
  });

  it("admin cannot self-escalate to super_admin", async () => {
    const database = db("admin");
    await assertFails(
      updateDoc(doc(database, "users/admin"), {
        role: "super_admin",
      }),
    );
  });
});

describe("super_admin client profile updates", () => {
  it("super_admin updating another user's role is denied", async () => {
    const database = db("super");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        role: "admin",
      }),
    );
  });

  it("super_admin updating another user's grants is denied", async () => {
    const database = db("super");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        grants: [{ role: "editor", sections: ["news", "sports"] }],
      }),
    );
  });

  it("super_admin cannot deactivate another user directly", async () => {
    const database = db("super");
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        active: false,
        tokensValidAfter: 1,
      }),
    );
  });

  it("super_admin revoking another user's role is denied", async () => {
    const database = db("super");
    await assertFails(
      updateDoc(doc(database, "users/admin"), {
        role: null,
      }),
    );
  });

  it("super_admin updating another user's profile field succeeds", async () => {
    const database = db("super");
    await assertSucceeds(
      updateDoc(doc(database, "users/other"), {
        displayName: "Renamed By Super",
      }),
    );
  });

  it("super_admin changing another user's email is denied", async () => {
    const database = db("super", { email: "fixture-d9bb0a65ad@example.org" });
    await assertFails(
      updateDoc(doc(database, "users/other"), {
        email: "fixture-6465099eff@example.org",
      }),
    );
  });
});

describe("functions-only collections enforce their server boundaries", () => {
  it("admin cannot read cmsVersionHistory directly", async () => {
    const database = db("admin");
    await assertFails(getDoc(doc(database, "cmsVersionHistory/v1")));
  });

  it("non-admin cannot read cmsVersionHistory", async () => {
    const database = db("regular");
    await assertFails(getDoc(doc(database, "cmsVersionHistory/v1")));
  });

  it("client cannot write cmsVersionHistory", async () => {
    const database = db("admin");
    await assertFails(
      setDoc(doc(database, "cmsVersionHistory/v2"), {
        field: "x",
      }),
    );
  });

  it("admin reads admin_logs; client write denied", async () => {
    const database = db("admin");
    await assertSucceeds(getDoc(doc(database, "admin_logs/l1")));
    await assertFails(
      setDoc(doc(database, "admin_logs/l2"), {
        action: "x",
      }),
    );
  });

  it("non-admin cannot read admin_logs", async () => {
    const database = db("regular");
    await assertFails(getDoc(doc(database, "admin_logs/l1")));
  });

  it("admin reads activity_logs; client write denied", async () => {
    const database = db("admin");
    await assertSucceeds(getDoc(doc(database, "activity_logs/al1")));
    await assertFails(
      setDoc(doc(database, "activity_logs/al2"), {
        action: "x",
      }),
    );
  });

  it("admin reads system_errors; client write denied", async () => {
    const database = db("admin");
    await assertSucceeds(getDoc(doc(database, "system_errors/e1")));
    await assertFails(
      setDoc(doc(database, "system_errors/e2"), {
        message: "x",
      }),
    );
  });

  // CMS content is server-only. cmsGetContent and cmsListContent authorize reads through the
  // shared capability model, while cmsSaveContent re-validates writes and owns canonical ids.
  // Keeping every browser role out of the collections prevents the old admin-only direct-read
  // path from becoming a second authorization model.
  for (const [name, seeded, fresh] of [
    ["cmsPages", "cmsPages/home", "cmsPages/about"],
    ["cmsPosts", "cmsPosts/p1", "cmsPosts/p2"],
    ["cmsPostTemplates", "cmsPostTemplates/p1", "cmsPostTemplates/p2"],
  ]) {
    it(`admin cannot read or create ${name} directly`, async () => {
      const database = db("admin");
      await assertFails(getDoc(doc(database, seeded)));
      await assertFails(setDoc(doc(database, fresh), { title: "x" }));
    });

    it(`non-admin cannot read ${name}`, async () => {
      const database = db("regular");
      await assertFails(getDoc(doc(database, seeded)));
    });

    it(`admin cannot update a ${name} doc directly`, async () => {
      const database = db("admin");
      await assertFails(updateDoc(doc(database, seeded), { title: "tampered" }));
    });
  }

  it("admin cannot query cmsPosts directly for the record library", async () => {
    const database = db("admin");
    await assertFails(
      getDocs(query(collection(database, "cmsPosts"), where("type", "==", "post"))),
    );
  });

  it("non-admin cannot query the cmsPosts record library", async () => {
    const database = db("regular");
    await assertFails(
      getDocs(query(collection(database, "cmsPosts"), where("type", "==", "post"))),
    );
  });
});

describe("media library server boundary", () => {
  for (const uid of ["admin", "super", "regular", null]) {
    it(`${uid ?? "unauthenticated"} cannot access the purge queue`, async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "mediaPurgeQueue/asset:asset-1"), {
          state: "pending",
        });
      });
      const database = db(uid);
      const entry = doc(database, "mediaPurgeQueue/asset:asset-1");
      await assertFails(getDoc(entry));
      await assertFails(getDocs(collection(database, "mediaPurgeQueue")));
      await assertFails(setDoc(doc(database, "mediaPurgeQueue/asset:asset-2"), { state: "pending" }));
      await assertFails(updateDoc(entry, { state: "cancelled" }));
      await assertFails(deleteDoc(entry));
    });
  }

  for (const uid of ["admin", "super", "regular", null]) {
    it(`${uid ?? "unauthenticated"} cannot read the private media record`, async () => {
      await assertFails(getDoc(doc(db(uid), "media_assets/asset-1")));
    });

    it(`${uid ?? "unauthenticated"} cannot read the build projection`, async () => {
      await assertFails(getDoc(doc(db(uid), "media_assets_public/asset-1")));
    });

    it(`${uid ?? "unauthenticated"} cannot read a hash-owner claim`, async () => {
      await assertFails(getDoc(doc(db(uid), "system/media/hashOwners/hash-1")));
    });

    it(`${uid ?? "unauthenticated"} cannot read a replacement lease`, async () => {
      await assertFails(getDoc(doc(db(uid), "system/media/replacements/asset-1")));
    });

    it(`${uid ?? "unauthenticated"} cannot read page media usage`, async () => {
      await assertFails(getDoc(doc(db(uid), "cmsPages/home/mediaUsage/working")));
    });

    it(`${uid ?? "unauthenticated"} cannot read post media usage`, async () => {
      await assertFails(getDoc(doc(db(uid), "cmsPosts/p1/mediaUsage/published")));
    });

    it(`${uid ?? "unauthenticated"} cannot read deployed media usage`, async () => {
      await assertFails(getDoc(doc(db(uid), "cmsPages/home/mediaUsage/deployed-1")));
      await assertFails(getDoc(doc(db(uid), "cmsSettings/site/mediaUsage/deployed-1")));
    });

    it(`${uid ?? "unauthenticated"} cannot read settings directly`, async () => {
      await assertFails(getDoc(doc(db(uid), "cmsSettings/fixture-settings")));
    });

    it(`${uid ?? "unauthenticated"} cannot read settings media usage`, async () => {
      await assertFails(getDoc(doc(
        db(uid),
        "cmsSettings/fixture-settings/mediaUsage/working",
      )));
    });
  }

  it("super_admin cannot create, update, or delete a media record directly", async () => {
    const database = db("super");
    await assertFails(setDoc(doc(database, "media_assets/asset-2"), { name: "Forged" }));
    await assertFails(updateDoc(doc(database, "media_assets/asset-1"), { lifecycle: "tombstoned" }));
    await assertFails(deleteDoc(doc(database, "media_assets/asset-1")));
  });

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot read or write personal media favorites directly",
    async (uid) => {
      const database = db(uid);
      const favorite = doc(database, "mediaFavorites/regular/items/favorite-1");
      await assertFails(getDoc(favorite));
      await assertFails(setDoc(favorite, { forged: true }));
    },
  );

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot read or write media collections directly",
    async (uid) => {
      const database = db(uid);
      const collectionRecord = doc(database, "mediaCollections/collection-1");
      const item = doc(database, "mediaCollections/collection-1/items/item-1");
      const receipt = doc(database, "mediaCollections/collection-1/requests/request-1");
      for (const reference of [collectionRecord, item, receipt]) {
        await assertFails(getDoc(reference));
        await assertFails(setDoc(reference, { forged: true }));
      }
    },
  );

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot bypass the media feedback API",
    async (uid) => {
      const reviewId = "b".repeat(64);
      const mediaId = "c".repeat(64);
      const commentId = "d".repeat(64);
      const paths = [
        `mediaReviews/regular/items/${reviewId}`,
        `mediaComments/${mediaId}/items/${commentId}`,
        `mediaComments/${mediaId}/requests/${commentId}`,
      ];
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const database = context.firestore();
        for (const path of paths) {
          await setDoc(doc(database, path), { schemaVersion: 1 });
        }
      });

      const database = db(uid);
      for (const path of paths) {
        const reference = doc(database, path);
        await assertFails(getDoc(reference));
        await assertFails(setDoc(reference, { forged: true }));
        await assertFails(updateDoc(reference, { forged: true }));
        await assertFails(deleteDoc(reference));
      }
      await assertFails(getDocs(collection(
        database,
        "mediaReviews/regular/items",
      )));
      await assertFails(getDocs(collection(
        database,
        `mediaComments/${mediaId}/items`,
      )));
      await assertFails(getDocs(collection(
        database,
        `mediaComments/${mediaId}/requests`,
      )));
      await assertFails(setDoc(
        doc(database, `mediaComments/${mediaId}/items/${"e".repeat(64)}`),
        { forged: true },
      ));
    },
  );

  it("super_admin cannot create or change a hash-owner claim directly", async () => {
    const database = db("super");
    await assertFails(setDoc(doc(database, "system/media/hashOwners/hash-2"), {
      state: "committed",
      assetId: "forged",
    }));
    await assertFails(updateDoc(doc(database, "system/media/hashOwners/hash-1"), {
      assetId: "forged",
    }));
  });

  it("super_admin cannot create, change, or delete a replacement lease directly", async () => {
    const database = db("super");
    await assertFails(setDoc(doc(database, "system/media/replacements/asset-2"), {
      operation: "replacement",
      state: "reserved",
      assetId: "asset-2",
    }));
    await assertFails(updateDoc(doc(database, "system/media/replacements/asset-1"), {
      state: "committed",
    }));
    await assertFails(deleteDoc(doc(database, "system/media/replacements/asset-1")));
  });

  it("super_admin cannot forge or delete a media usage record", async () => {
    const database = db("super");
    await assertFails(setDoc(doc(database, "cmsPages/home/mediaUsage/published"), {
      state: "published",
      sourceVersion: 99,
      assetIds: ["forged"],
      occurrenceCount: 1,
    }));
    await assertFails(deleteDoc(doc(database, "cmsPages/home/mediaUsage/working")));
    await assertFails(setDoc(doc(database, "cmsSettings/site/mediaUsage/deployed-2"), {
      state: "deployed",
      generation: 2,
      assetIds: ["forged"],
      occurrenceCount: 1,
    }));
    await assertFails(setDoc(
      doc(database, "cmsSettings/fixture-settings/mediaUsage/published"),
      {
        state: "published",
        sourceVersion: 99,
        assetIds: ["forged"],
        occurrenceCount: 1,
      },
    ));
    await assertFails(deleteDoc(doc(database, "cmsSettings/fixture-settings")));
  });
});

describe("media discovery server boundary", () => {
  it.each([
    { uid: null, label: "signed-out" },
    { uid: "regular", label: "regular" },
    { uid: "admin", label: "admin" },
    { uid: "super", label: "super_admin" },
  ])(
    "$label client cannot access cursor or readiness state",
    async ({ uid }) => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const database = ctx.firestore();
        await Promise.all([
          setDoc(doc(database, "mediaDiscoveryCursors/cursor-fixture"), {
            binding: "synthetic-binding",
            after: ["synthetic", "asset-fixture"],
          }),
          setDoc(doc(database, "system/mediaDiscovery"), {
            schema: 1,
            state: "ready",
            revision: 1,
          }),
        ]);
      });

      const database = db(uid);
      const cursor = doc(database, "mediaDiscoveryCursors/cursor-fixture");
      const readiness = doc(database, "system/mediaDiscovery");
      await assertFails(getDoc(cursor));
      await assertFails(getDocs(collection(database, "mediaDiscoveryCursors")));
      await assertFails(setDoc(
        doc(database, "mediaDiscoveryCursors/cursor-created"),
        { binding: "forged" },
      ));
      await assertFails(updateDoc(cursor, { binding: "forged" }));
      await assertFails(deleteDoc(cursor));
      await assertFails(getDoc(readiness));
      await assertFails(setDoc(readiness, { schema: 1, state: "ready" }));
      await assertFails(updateDoc(readiness, { revision: 2 }));
      await assertFails(deleteDoc(readiness));
    },
  );
});

describe("CMS editor courtesy locks", () => {
  const lockPath = "cmsEditorLocks/cmsPages:home";
  const session = "11111111-1111-4111-8111-111111111111";

  function lockPathFor(surfaceKey) {
    return `cmsEditorLocks/${surfaceKey}`;
  }

  function contentAddress(surfaceKey) {
    const [contentCollection, contentId] = surfaceKey.split(":");
    return { contentCollection, contentId };
  }

  function lockData(
    ownerId,
    ownerName,
    sessionId = session,
    force = false,
    surfaceKey = "cmsPages:home",
  ) {
    return {
      surfaceKey,
      ...contentAddress(surfaceKey),
      ownerId,
      ownerName,
      sessionId,
      acquiredAt: serverTimestamp(),
      heartbeatAt: serverTimestamp(),
      ...(force ? { takeoverAt: serverTimestamp() } : {}),
    };
  }

  function releasedLockData(
    ownerId,
    sessionId = session,
    surfaceKey = "cmsPages:home",
  ) {
    return {
      surfaceKey,
      ...contentAddress(surfaceKey),
      ownerId,
      sessionId,
      releasedAt: serverTimestamp(),
    };
  }

  function legacyLockData(
    ownerId,
    ownerName,
    sessionId = session,
    force = false,
    surfaceKey = "cmsPages:home",
  ) {
    const {
      contentCollection: _contentCollection,
      contentId: _contentId,
      ...legacy
    } = lockData(ownerId, ownerName, sessionId, force, surfaceKey);
    return legacy;
  }

  function legacyReleasedLockData(
    ownerId,
    sessionId = session,
    surfaceKey = "cmsPages:home",
  ) {
    const {
      contentCollection: _contentCollection,
      contentId: _contentId,
      ...legacy
    } = releasedLockData(ownerId, sessionId, surfaceKey);
    return legacy;
  }

  it.each([
    ["editor", "Eden Editor"],
    ["contributor", "Casey Contributor"],
  ])("lets site-wide %s claim, observe, heartbeat, and release a lease", async (
    uid,
    name,
  ) => {
    const database = db(uid);
    await assertSucceeds(setDoc(doc(database, lockPath), lockData(uid, name)));
    await assertSucceeds(getDoc(doc(database, lockPath)));
    await assertSucceeds(
      updateDoc(doc(database, lockPath), { heartbeatAt: serverTimestamp() }),
    );
    await assertSucceeds(
      setDoc(doc(database, lockPath), releasedLockData(uid)),
    );
  });

  it("lets a contributor use leases for their own existing page and post", async () => {
    const database = db("contributor");
    for (const surfaceKey of ["cmsPages:home", "cmsPosts:p1"]) {
      const path = lockPathFor(surfaceKey);
      await assertSucceeds(
        setDoc(
          doc(database, path),
          lockData("contributor", "Casey Contributor", session, false, surfaceKey),
        ),
      );
      await assertSucceeds(getDoc(doc(database, path)));
      await assertSucceeds(
        updateDoc(doc(database, path), { heartbeatAt: serverTimestamp() }),
      );
      await assertSucceeds(
        setDoc(
          doc(database, path),
          releasedLockData("contributor", session, surfaceKey),
        ),
      );
    }
  });

  it.each(["cmsPages:contact", "cmsPosts:foreign-post"])(
    "denies a contributor every lease operation for another contributor's %s",
    async (surfaceKey) => {
      const path = lockPathFor(surfaceKey);
      const database = db("contributor");
      await assertFails(
        setDoc(
          doc(database, path),
          lockData("contributor", "Casey Contributor", session, false, surfaceKey),
        ),
      );

      const expired = Timestamp.fromMillis(Date.now() - 125_000);
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), path), {
          ...lockData(
            "contributor-two",
            "Taylor Contributor",
            session,
            false,
            surfaceKey,
          ),
          acquiredAt: expired,
          heartbeatAt: expired,
        });
      });

      await assertFails(getDoc(doc(database, path)));
      await assertFails(
        updateDoc(doc(database, path), { heartbeatAt: serverTimestamp() }),
      );
      await assertFails(
        setDoc(
          doc(database, path),
          lockData(
            "contributor",
            "Casey Contributor",
            "22222222-2222-4222-8222-222222222222",
            false,
            surfaceKey,
          ),
        ),
      );
    },
  );

  it.each(["about","data-hub"])("allows an absent %s page lease but denies an absent post lease for a contributor", async pageId => {
    const database = db("contributor");
    const pageSurface = `cmsPages:${pageId}`;
    const pagePath = lockPathFor(pageSurface);
    await assertSucceeds(
      setDoc(
        doc(database, pagePath),
        lockData("contributor", "Casey Contributor", session, false, pageSurface),
      ),
    );
    await assertSucceeds(getDoc(doc(database, pagePath)));
    await assertSucceeds(
      updateDoc(doc(database, pagePath), { heartbeatAt: serverTimestamp() }),
    );
    await assertSucceeds(
      setDoc(
        doc(database, pagePath),
        releasedLockData("contributor", session, pageSurface),
      ),
    );

    const postSurface = "cmsPosts:missing-post";
    const postPath = lockPathFor(postSurface);
    await assertFails(
      setDoc(
        doc(database, postPath),
        lockData("contributor", "Casey Contributor", session, false, postSurface),
      ),
    );
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), postPath),
        lockData("editor", "Eden Editor", session, false, postSurface),
      );
    });
    await assertFails(getDoc(doc(database, postPath)));

    const unknownPageSurface = "cmsPages:not-a-page";
    await assertFails(
      setDoc(
        doc(database, lockPathFor(unknownPageSurface)),
        lockData(
          "contributor",
          "Casey Contributor",
          session,
          false,
          unknownPageSurface,
        ),
      ),
    );
  });

  it.each([
    ["editor", "cmsPages:missing-page"],
    ["editor", "cmsPosts:missing-post"],
    ["admin", "cmsPages:missing-page"],
    ["admin", "cmsPosts:missing-post"],
    ["super", "cmsPages:missing-page"],
    ["super", "cmsPosts:missing-post"],
  ])("requires content before %s can claim %s", async (uid, surfaceKey) => {
    const reference = doc(db(uid), lockPathFor(surfaceKey));
    await assertFails(setDoc(reference, lockData(uid, uid, session, false, surfaceKey)));
    await assertFails(setDoc(reference, lockData(uid, uid, session, true, surfaceKey)));
    await assertFails(getDoc(reference));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(doc(ctx.firestore(), lockPathFor(surfaceKey)))).exists()).toBe(false);
      const { contentCollection, contentId } = contentAddress(surfaceKey);
      await setDoc(doc(ctx.firestore(), contentCollection, contentId), {
        id: contentId,
        status: "draft",
        createdBy: "contributor-two",
      });
    });

    await assertSucceeds(getDoc(reference));
    await assertSucceeds(setDoc(reference, lockData(uid, uid, session, false, surfaceKey)));
    await assertSucceeds(updateDoc(reference, { heartbeatAt: serverTimestamp() }));
    await assertSucceeds(setDoc(reference, releasedLockData(uid, session, surfaceKey)));
  });

  it.each(["editor", "admin", "super"])(
    "lets edit-any account %s use an absent create-eligible page lease",
    async (uid) => {
      const surfaceKey = "cmsPages:about";
      const reference = doc(db(uid), lockPathFor(surfaceKey));
      await assertSucceeds(getDoc(reference));
      await assertSucceeds(setDoc(reference, lockData(uid, uid, session, false, surfaceKey)));
      await assertSucceeds(updateDoc(reference, { heartbeatAt: serverTimestamp() }));
      await assertSucceeds(setDoc(reference, releasedLockData(uid, session, surfaceKey)));
    },
  );

  it.each(["cmsPages:missing-page", "cmsPosts:missing-post"])(
    "denies takeover and renewal of an orphaned lease for %s",
    async (surfaceKey) => {
      const path = lockPathFor(surfaceKey);
      const expired = Timestamp.fromMillis(Date.now() - 125_000);
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), path), {
          ...lockData("editor", "Eden Editor", session, false, surfaceKey),
          acquiredAt: expired,
          heartbeatAt: expired,
        });
      });

      const reference = doc(db("admin"), path);
      await assertFails(setDoc(reference, lockData("admin", "Al Admin", session, true, surfaceKey)));
      await assertFails(setDoc(reference, lockData("admin", "Al Admin", session, false, surfaceKey)));
      await assertFails(updateDoc(reference, {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(db("editor"), path), { heartbeatAt: serverTimestamp() }));
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const stored = await getDoc(doc(ctx.firestore(), path));
        expect(stored.data().ownerId).toBe("editor");
        expect(stored.data().heartbeatAt.toMillis()).toBe(expired.toMillis());
      });
    },
  );

  // Every editor's first act on a surface is a subscription to a lease document that does not
  // exist yet. A read rule that only inspects `resource.data` raises a null-value error there,
  // which Firestore denies, so presence failed open and no lease was ever claimed (#1047).
  it("lets an eligible account observe a lease document that does not exist", async () => {
    await assertSucceeds(getDoc(doc(db("editor"), lockPathFor("cmsPages:about"))));
    await assertSucceeds(getDoc(doc(db("admin"), lockPathFor("cmsPosts:foreign-post"))));
    await assertSucceeds(
      getDoc(doc(db("contributor"), lockPathFor("cmsPages:about"))),
    );
  });

  it("denies an absent lease read the caller could never use", async () => {
    // A contributor cannot hold a lease on an absent post or on a page id that is not canonical,
    // so the absent-document read must refuse it rather than confirm the address exists.
    await assertFails(
      getDoc(doc(db("contributor"), lockPathFor("cmsPosts:missing-post"))),
    );
    await assertFails(
      getDoc(doc(db("contributor"), lockPathFor("cmsPages:not-a-page"))),
    );
    await assertFails(getDoc(doc(db("regular"), lockPathFor("cmsPages:about"))));
    await assertFails(getDoc(doc(db(null), lockPathFor("cmsPages:about"))));
    await assertFails(getDoc(doc(db("editor"), "cmsEditorLocks/not-an-address")));
  });

  it("lets a second eligible editor record and withdraw a takeover request", async () => {
    await assertSucceeds(setDoc(doc(db("editor"), lockPath), lockData("editor", "Eden Editor")));
    await assertSucceeds(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
      }),
    );
    // The holder keeps heartbeating with the request attached, then clears it on a decision.
    await assertSucceeds(
      updateDoc(doc(db("editor"), lockPath), { heartbeatAt: serverTimestamp() }),
    );
    await assertSucceeds(
      updateDoc(doc(db("editor"), lockPath), {
        requestedById: deleteField(),
        requestedByName: deleteField(),
        requestedAt: deleteField(),
      }),
    );
  });

  it("keeps the first waiting editor's request against a second asker", async () => {
    // The lease carries one ask and there is no queue behind it, so a later asker overwriting the
    // triple would silently drop the editor already waiting (#1047).
    await assertSucceeds(setDoc(doc(db("editor"), lockPath), lockData("editor", "Eden Editor")));
    await assertSucceeds(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(db("super"), lockPath), {
        requestedById: "super",
        requestedByName: "Sue Super",
        requestedAt: serverTimestamp(),
      }),
    );
    // The editor already waiting may refresh their own ask, and the holder may still answer it.
    await assertSucceeds(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db("editor"), lockPath), {
        requestedById: deleteField(),
        requestedByName: deleteField(),
        requestedAt: deleteField(),
      }),
    );
    // Once answered, the next asker is free to take the empty slot.
    await assertSucceeds(
      updateDoc(doc(db("super"), lockPath), {
        requestedById: "super",
        requestedByName: "Sue Super",
        requestedAt: serverTimestamp(),
      }),
    );
  });

  it("refuses a takeover request that forges its requester or edits the lease", async () => {
    await assertSucceeds(setDoc(doc(db("editor"), lockPath), lockData("editor", "Eden Editor")));
    await assertFails(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "editor",
        requestedByName: "Not Al",
        requestedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
        heartbeatAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(db("regular"), lockPath), {
        requestedById: "regular",
        requestedByName: "Rey Regular",
        requestedAt: serverTimestamp(),
      }),
    );
    // Only the holder may clear a request another account recorded.
    await assertSucceeds(
      updateDoc(doc(db("admin"), lockPath), {
        requestedById: "admin",
        requestedByName: "Al Admin",
        requestedAt: serverTimestamp(),
      }),
    );
    await assertFails(
      updateDoc(doc(db("contributor"), lockPath), {
        requestedById: deleteField(),
        requestedByName: deleteField(),
        requestedAt: deleteField(),
      }),
    );
  });

  it.each(["editor", "admin", "super"])(
    "lets edit-any account %s use a lease regardless of content ownership",
    async (uid) => {
      const surfaceKey = "cmsPosts:foreign-post";
      const name = uid === "editor" ? "Eden Editor" : uid === "admin" ? "Al Admin" : "Sue Super";
      const database = db(uid);
      await assertSucceeds(
        setDoc(
          doc(database, lockPathFor(surfaceKey)),
          lockData(uid, name, session, false, surfaceKey),
        ),
      );
      await assertSucceeds(getDoc(doc(database, lockPathFor(surfaceKey))));
    },
  );

  it("keeps exact legacy leases readable, renewable, and releasable only for edit-any users", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        legacyLockData("editor", "Eden Editor"),
      );
    });

    await assertSucceeds(getDoc(doc(db("editor"), lockPath)));
    await assertFails(getDoc(doc(db("contributor"), lockPath)));
    await assertSucceeds(
      updateDoc(doc(db("editor"), lockPath), { heartbeatAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(db("contributor"), lockPath), {
        heartbeatAt: serverTimestamp(),
      }),
    );
    await assertSucceeds(
      setDoc(
        doc(db("editor"), lockPath),
        legacyReleasedLockData("editor"),
      ),
    );
    await assertSucceeds(getDoc(doc(db("editor"), lockPath)));
    await assertFails(getDoc(doc(db("contributor"), lockPath)));
  });

  it("rejects an addressless new contributor claim", async () => {
    await assertFails(
      setDoc(
        doc(db("contributor"), lockPath),
        legacyLockData("contributor", "Casey Contributor"),
      ),
    );
  });

  it("rejects legacy rows with an unbound surface key or a noncanonical field set", async () => {
    const duplicatePath = "cmsEditorLocks/duplicate-home-lock";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await Promise.all([
        setDoc(
          doc(ctx.firestore(), duplicatePath),
          legacyLockData("editor", "Eden Editor"),
        ),
        setDoc(doc(ctx.firestore(), lockPath), {
          ...legacyLockData("editor", "Eden Editor"),
          unexpected: true,
        }),
      ]);
    });

    await assertFails(getDoc(doc(db("editor"), duplicatePath)));
    await assertFails(getDoc(doc(db("editor"), lockPath)));
    await assertFails(
      updateDoc(doc(db("editor"), lockPath), { heartbeatAt: serverTimestamp() }),
    );
  });

  it("lets a new client migrate its exact legacy lease to an addressed release marker", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        legacyLockData("editor", "Eden Editor"),
      );
    });

    await assertSucceeds(
      setDoc(doc(db("editor"), lockPath), releasedLockData("editor")),
    );
    const migrated = await getDoc(doc(db("editor"), lockPath));
    expect(migrated.data()).toMatchObject({
      surfaceKey: "cmsPages:home",
      contentCollection: "cmsPages",
      contentId: "home",
      ownerId: "editor",
    });
  });

  it("replaces a legacy release marker only with a strict addressed and authorized claim", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        legacyReleasedLockData("admin"),
      );
    });

    await assertSucceeds(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData(
          "contributor",
          "Casey Contributor",
          "22222222-2222-4222-8222-222222222222",
        ),
      ),
    );

    const foreignSurface = "cmsPages:contact";
    const foreignPath = lockPathFor(foreignSurface);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), foreignPath),
        legacyReleasedLockData("admin", session, foreignSurface),
      );
    });
    await assertFails(
      setDoc(
        doc(db("contributor"), foreignPath),
        lockData(
          "contributor",
          "Casey Contributor",
          "22222222-2222-4222-8222-222222222222",
          false,
          foreignSurface,
        ),
      ),
    );
  });

  it("applies same-owner, force, and stale replacement rules to legacy active leases", async () => {
    const replacementSession = "22222222-2222-4222-8222-222222222222";
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        legacyLockData("editor", "Eden Editor"),
      );
    });
    const adminDenial = await assertFails(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", replacementSession),
      ),
    );
    expect(adminDenial.message).not.toMatch(/maximum of \d+ expressions/i);
    const contributorDenial = await assertFails(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData("contributor", "Casey Contributor", replacementSession),
      ),
    );
    expect(contributorDenial.message).not.toMatch(/maximum of \d+ expressions/i);
    await assertSucceeds(
      setDoc(
        doc(db("editor"), lockPath),
        lockData("editor", "Eden Editor", replacementSession, true),
      ),
    );

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        legacyLockData("editor", "Eden Editor"),
      );
    });
    await assertSucceeds(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", replacementSession, true),
      ),
    );

    const expired = Timestamp.fromMillis(Date.now() - 125_000);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), lockPath), {
        ...legacyLockData("editor", "Eden Editor"),
        acquiredAt: expired,
        heartbeatAt: expired,
      });
    });
    await assertSucceeds(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", replacementSession),
      ),
    );
  });

  it.each([
    ["regular", "Reg User"],
    ["scoped-editor", "Nia News"],
    ["inactive-editor", "Inactive Editor"],
  ])("denies lock reads and claims for %s", async (uid, name) => {
    const database = db(uid);
    await assertFails(getDoc(doc(database, lockPath)));
    await assertFails(setDoc(doc(database, lockPath), lockData(uid, name)));
  });

  it("rejects a forged owner and malformed lease", async () => {
    const database = db("admin");
    await assertFails(setDoc(doc(database, lockPath), lockData("super", "Sue Super")));
    await assertFails(
      setDoc(
        doc(database, "cmsEditorLocks/duplicate-home-lock"),
        lockData("admin", "Al Admin"),
      ),
    );
    await assertFails(
      setDoc(doc(database, lockPath), {
        ...lockData("admin", "Al Admin"),
        sessionId: "short",
      }),
    );
    await assertFails(
      setDoc(doc(database, lockPath), {
        ...lockData("admin", "Al Admin"),
        contentId: "contact",
      }),
    );
    const partialAddress = lockData("admin", "Al Admin");
    delete partialAddress.contentId;
    await assertFails(setDoc(doc(database, lockPath), partialAddress));
  });

  it("lets only the owning session heartbeat without changing the claim", async () => {
    await assertSucceeds(
      setDoc(doc(db("admin"), lockPath), lockData("admin", "Al Admin")),
    );
    await assertSucceeds(
      updateDoc(doc(db("admin"), lockPath), { heartbeatAt: serverTimestamp() }),
    );
    await assertFails(
      updateDoc(doc(db("super"), lockPath), { heartbeatAt: serverTimestamp() }),
    );
  });

  it("allows edit-any and admin takeover but requires the exact session release marker", async () => {
    const takeoverSession = "22222222-2222-4222-8222-222222222222";
    await assertSucceeds(
      setDoc(doc(db("super"), lockPath), lockData("super", "Sue Super")),
    );
    await assertFails(deleteDoc(doc(db("admin"), lockPath)));
    await assertFails(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", takeoverSession),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db("editor"), lockPath),
        lockData("editor", "Eden Editor", takeoverSession, true),
      ),
    );
    await assertFails(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData("contributor", "Casey Contributor", takeoverSession, true),
      ),
    );
    await assertFails(
      setDoc(doc(db("admin"), lockPath), {
        ...lockData("admin", "Al Admin", takeoverSession, true),
        surfaceKey: "cmsPosts:wrong-record",
      }),
    );
    await assertSucceeds(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", takeoverSession, true),
      ),
    );
    await assertFails(deleteDoc(doc(db("admin"), lockPath)));
    await assertFails(
      setDoc(
        doc(db("admin"), lockPath),
        releasedLockData("admin", "33333333-3333-4333-8333-333333333333"),
      ),
    );
    await assertSucceeds(
      setDoc(doc(db("admin"), lockPath), releasedLockData("admin", takeoverSession)),
    );
  });

  it("lets a contributor recover their own other session without taking over another user", async () => {
    const replacementSession = "22222222-2222-4222-8222-222222222222";
    await assertSucceeds(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData("contributor", "Casey Contributor"),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData(
          "contributor",
          "Casey Contributor",
          replacementSession,
          true,
        ),
      ),
    );

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(
        doc(ctx.firestore(), lockPath),
        lockData("editor", "Eden Editor"),
      );
    });
    await assertFails(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData(
          "contributor",
          "Casey Contributor",
          replacementSession,
          true,
        ),
      ),
    );
  });

  it("lets server time, not a workstation clock, authorize stale replacement", async () => {
    const expired = Timestamp.fromMillis(Date.now() - 125_000);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), lockPath), {
        ...lockData("super", "Sue Super"),
        acquiredAt: expired,
        heartbeatAt: expired,
      });
    });

    await assertSucceeds(
      setDoc(
        doc(db("admin"), lockPath),
        lockData("admin", "Al Admin", "22222222-2222-4222-8222-222222222222"),
      ),
    );
  });

  it("lets a contributor replace a stale lease only for content they own", async () => {
    const expired = Timestamp.fromMillis(Date.now() - 125_000);
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), lockPath), {
        ...lockData("editor", "Eden Editor"),
        acquiredAt: expired,
        heartbeatAt: expired,
      });
    });

    await assertSucceeds(
      setDoc(
        doc(db("contributor"), lockPath),
        lockData(
          "contributor",
          "Casey Contributor",
          "22222222-2222-4222-8222-222222222222",
        ),
      ),
    );
  });
});

// #205: the log must stand as the record of who did what. The functions-only rule already
// denies client creates (above); these lock the append-only half of the invariant — a row that
// was recorded can never be updated or cleared by any client, including the highest-privilege
// admin and super_admin who are allowed to read it. A future rules edit that loosened these
// collections to a privileged-write model would fail here.
describe("audit streams are append-only (no client update or delete of a recorded row)", () => {
  const AUDIT_DOCS = [
    ["cmsVersionHistory", "cmsVersionHistory/v1"],
    ["admin_logs", "admin_logs/l1"],
    ["activity_logs", "activity_logs/al1"],
  ];

  for (const [name, path] of AUDIT_DOCS) {
    it(`admin cannot update a recorded ${name} row`, async () => {
      const database = db("admin");
      await assertFails(updateDoc(doc(database, path), { action: "tampered" }));
    });

    it(`admin cannot delete a recorded ${name} row`, async () => {
      const database = db("admin");
      await assertFails(deleteDoc(doc(database, path)));
    });

    it(`super_admin cannot update a recorded ${name} row`, async () => {
      const database = db("super");
      await assertFails(updateDoc(doc(database, path), { action: "tampered" }));
    });

    it(`super_admin cannot delete a recorded ${name} row`, async () => {
      const database = db("super");
      await assertFails(deleteDoc(doc(database, path)));
    });
  }
});

describe("cmsPublishQueue split", () => {
  it("admin reads the queue", async () => {
    const database = db("admin");
    await assertSucceeds(getDoc(doc(database, "cmsPublishQueue/q1")));
  });

  it("admin cannot create a pending item", async () => {
    const database = db("admin");
    await assertFails(
      setDoc(doc(database, "cmsPublishQueue/q2"), {
        status: "pending",
        triggeredBy: "admin",
      }),
    );
  });

  it("super_admin cannot create a pending item", async () => {
    const database = db("super");
    await assertFails(
      setDoc(doc(database, "cmsPublishQueue/q5"), {
        status: "pending",
        triggeredBy: "super",
      }),
    );
  });

  it("admin cannot create a non-pending item", async () => {
    const database = db("admin");
    await assertFails(
      setDoc(doc(database, "cmsPublishQueue/q3"), {
        status: "publishing",
      }),
    );
  });

  it("non-admin cannot create a queue item", async () => {
    const database = db("regular");
    await assertFails(
      setDoc(doc(database, "cmsPublishQueue/q4"), {
        status: "pending",
      }),
    );
  });

  it("no client can update queue status", async () => {
    const database = db("admin");
    await assertFails(
      updateDoc(doc(database, "cmsPublishQueue/q1"), {
        status: "publishing",
      }),
    );
  });
});

describe("cmsPreviewQueue server boundary", () => {
  it.each(["admin", "super", "regular", null])(
    "%s cannot read a captured preview snapshot directly",
    async (uid) => {
      const database = db(uid);
      await assertFails(getDoc(doc(database, "cmsPreviewQueue/q1")));
    },
  );

  it("admin cannot create or mutate a preview request", async () => {
    const database = db("admin");
    await assertFails(
      setDoc(doc(database, "cmsPreviewQueue/q2"), {
        status: "pending",
        pageId: "home",
      }),
    );
    await assertFails(
      updateDoc(doc(database, "cmsPreviewQueue/q1"), {
        previewUrl: "https://attacker.example",
      }),
    );
  });
});

describe("operator no-build admission", () => {
  it.each([undefined, "regular", "admin"])("denies direct admission reads and writes for %s", async uid => {
    const ref = doc(db(uid), "system/noBuildPostAdmission");
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { schemaVersion: 1, revision: 1, enabled: true,
      postId: "pilot-post", backgroundBucket: "private-fixture" }));
  });
});

describe("public change-log enrollment", () => {
  it.each([undefined, "regular", "admin"])("denies client enrollment reads and writes for %s", async uid => {
    const ref = doc(db(uid), "system/publicReleaseChangeLog");
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { schemaVersion: 2, enabled: false }));
    await assertFails(setDoc(ref, { schemaVersion: 2, enabled: true, activation: { buildBatchId: "build", pair: {} } }));
  });
});

describe("system billing flag", () => {
  it("admitted client reads system/billing", async () => {
    const database = db("regular");
    await assertSucceeds(getDoc(doc(database, "system/billing")));
  });

  it("inactive profile cannot read system/billing", async () => {
    const database = db("inactive-regular");
    await assertFails(getDoc(doc(database, "system/billing")));
  });

  it("revocation watermark denies the same-second session", async () => {
    const database = db("revoked-admin", { auth_time: revokedAt });
    await assertFails(getDoc(doc(database, "admin_logs/l1")));
  });

  it("revocation watermark admits a later active session", async () => {
    const database = db("revoked-admin", { auth_time: revokedAt + 1 });
    await assertSucceeds(getDoc(doc(database, "admin_logs/l1")));
  });

  it("signed-in account without an admitted profile cannot read system/billing", async () => {
    const database = db("not-admitted");
    await assertFails(getDoc(doc(database, "system/billing")));
  });

  it("non-admin cannot read system/bootstrap", async () => {
    const database = db("regular");
    await assertFails(getDoc(doc(database, "system/bootstrap")));
  });

  it("admin cannot read system/bootstrap", async () => {
    const database = db("admin");
    await assertFails(getDoc(doc(database, "system/bootstrap")));
  });

  it("unauthenticated cannot read system/billing", async () => {
    const database = db();
    await assertFails(getDoc(doc(database, "system/billing")));
  });

  it("client cannot write system/billing", async () => {
    const database = db("admin");
    await assertFails(
      setDoc(
        doc(database, "system/billing"),
        {
          disabled: true,
        },
        { merge: true },
      ),
    );
  });
});

describe("staff account request records", () => {
  it.each([
    { label: "anonymous", uid: undefined },
    { label: "pending", uid: "pending" },
    { label: "orientation staff", uid: "orientation-staff" },
    { label: "regular", uid: "regular" },
    { label: "contributor", uid: "contributor" },
    { label: "editor", uid: "editor" },
    { label: "admin", uid: "admin" },
    { label: "super admin", uid: "super" },
    { label: "disabled", uid: "inactive-editor" },
    {
      label: "revoked",
      uid: "revoked-admin",
      tokenOptions: { auth_time: revokedAt - 1 },
    },
  ])(
    "client $label cannot read or write request, onboarding, and email records",
    async ({ uid, tokenOptions }) => {
      const database = db(uid, tokenOptions);
      await assertFails(
        getDoc(doc(database, "staffAccessRequests/requester-1")),
      );
      await assertFails(getDocs(collection(database, "staffAccessRequests")));
      await assertFails(
        setDoc(doc(database, "staffAccessRequests/forged"), {
          state: "approved",
          role: "super_admin",
        }),
      );
      await assertFails(
        getDoc(
          doc(database, "staffAccessEmailOutbox/requester-1-1-received"),
        ),
      );
      await assertFails(
        getDocs(collection(database, "staffAccessEmailOutbox")),
      );
      await assertFails(
        setDoc(doc(database, "staffAccessEmailOutbox/forged"), {
          state: "sent",
        }),
      );
      await assertFails(
        getDoc(
          doc(
            database,
            "staffAccessNotificationOutbox/requester-1--1--pending",
          ),
        ),
      );
      await assertFails(
        getDocs(collection(database, "staffAccessNotificationOutbox")),
      );
      await assertFails(
        setDoc(doc(database, "staffAccessNotificationOutbox/forged"), {
          state: "delivered",
        }),
      );
      await assertFails(
        getDoc(doc(database, "staffAccessRequestCounters/requester-1")),
      );
      await assertFails(
        setDoc(doc(database, "staffAccessRequestCounters/requester-1"), {
          lastVersion: 999,
        }),
      );
      await assertFails(
        getDoc(doc(database, "staffAccessNotificationCooldowns/email-hash")),
      );
      await assertFails(
        setDoc(doc(database, "staffAccessNotificationCooldowns/forged"), {
          lastNotifiedAt: new Date(),
        }),
      );
      await assertFails(
        getDoc(doc(database, "staffSignInRefusedCooldowns/editor-1")),
      );
      await assertFails(
        setDoc(doc(database, "staffSignInRefusedCooldowns/forged"), {
          lastRefusedAt: new Date(),
        }),
      );
      await assertFails(
        getDoc(doc(database, "staffPasswordResetRequests/email-hash")),
      );
      await assertFails(
        setDoc(doc(database, "staffPasswordResetRequests/forged"), {
          lastRequestedAt: new Date(),
        }),
      );
      await assertFails(
        getDoc(doc(database, "staffOnboardingPlans/private-plan")),
      );
      await assertFails(getDocs(collection(database, "staffOnboardingPlans")));
      await assertFails(
        setDoc(doc(database, "staffOnboardingPlans/forged"), {
          employeeEmail: "forged@example.org",
          invitation: { state: "sent" },
        }),
      );
    },
  );
});

describe("CMS bug report records", () => {
  it.each(["regular", "admin", "super", undefined])(
    "client %s cannot read or write reports, evidence, delivery, mutation, or rate records",
    async (uid) => {
      const database = db(uid);
      const reportId = `br_${"a".repeat(32)}`;

      await assertFails(getDoc(doc(database, `bug_reports/${reportId}`)));
      await assertFails(getDocs(collection(database, "bug_reports")));
      await assertFails(
        setDoc(doc(database, "bug_reports/forged"), {
          status: "resolved",
        }),
      );
      await assertFails(
        getDoc(doc(database, `bugReportEvidence/${reportId}`)),
      );
      await assertFails(
        setDoc(doc(database, "bugReportEvidence/forged"), {
          bytes: "not-private",
        }),
      );
      await assertFails(
        getDoc(doc(database, "bugReportDeliveryOutbox/delivery-1")),
      );
      await assertFails(
        setDoc(doc(database, "bugReportDeliveryOutbox/forged"), {
          status: "delivered",
        }),
      );
      await assertFails(
        getDoc(doc(database, "bugReportGithubOutbox/github-1")),
      );
      await assertFails(
        setDoc(doc(database, "bugReportGithubOutbox/forged"), {
          state: "delivered",
        }),
      );
      await assertFails(
        getDoc(doc(database, `bugReportGithubLocks/${reportId}`)),
      );
      await assertFails(
        setDoc(doc(database, "bugReportGithubLocks/forged"), {
          jobId: "job-1",
        }),
      );
      await assertFails(
        getDoc(doc(database, "bugReportGithubWebhookReceipts/delivery-1")),
      );
      await assertFails(
        setDoc(doc(database, "bugReportGithubWebhookReceipts/forged"), {
          eventName: "issues",
        }),
      );
      await assertFails(
        getDoc(doc(database, `bugReportAutofixOutbox/${reportId}`)),
      );
      await assertFails(getDoc(doc(database, `bugReportFollowupOutbox/${reportId}--nudge`)));
      await assertFails(setDoc(doc(database, `bugReportFollowupOutbox/${reportId}--nudge`), { state: "pending" }));
      await assertFails(
        setDoc(doc(database, "bugReportAutofixOutbox/forged"), {
          state: "running",
        }),
      );
      await assertFails(
        getDoc(doc(database, "bugReportMutationReceipts/mutation-1")),
      );
      await assertFails(
        setDoc(doc(database, "bugReportMutationReceipts/forged"), {
          actorUid: uid ?? "anonymous",
        }),
      );
      await assertFails(
        getDoc(doc(database, "bugReportRateLimits/regular")),
      );
      await assertFails(
        setDoc(doc(database, "bugReportRateLimits/regular"), {
          windowCount: 0,
        }),
      );
    },
  );
});

describe("Cuez server-only transfer records", () => {
  it.each(["orientation-staff", "editor", "admin", "super", undefined])("client %s cannot read or enable the Cuez flag", async uid => {
    const database = db(uid);
    const flag = doc(database, "system", "cuezIntegration");
    await assertFails(getDoc(flag));
    await assertFails(setDoc(flag, { enabled: true }));
  });
  it.each(["orientation-staff", "editor", "admin", "super", undefined])(
    "client %s cannot get, list, create, update or delete transfer records",
    async (uid) => {
      const collections = ["cuezTransferOperations", "cuezMappings"];
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        for (const name of collections) {
          await setDoc(doc(ctx.firestore(), name, "existing"), { state: "queued" });
        }
      });
      const database = db(uid);
      for (const name of collections) {
        const existing = doc(database, name, "existing");
        await assertFails(getDoc(existing));
        await assertFails(getDocs(collection(database, name)));
        await assertFails(setDoc(doc(database, name, "new"), { state: "queued" }));
        await assertFails(setDoc(existing, { state: "complete" }));
        await assertFails(updateDoc(existing, { state: "complete" }));
        await assertFails(deleteDoc(existing));
      }
    },
  );
});

describe("UGC server-only records", () => {
  it.each(["regular", "admin", "super", undefined])(
    "client %s cannot read or write submissions or consent config",
    async (uid) => {
      const database = db(uid);
      for (const path of ["ugcSubmissions/submission-1", "ugcConfig/current"]) {
        await assertFails(getDoc(doc(database, path)));
        await assertFails(setDoc(doc(database, path), { open: true }));
      }
      await assertFails(getDocs(collection(database, "ugcSubmissions")));
      await assertFails(getDocs(collection(database, "ugcConfig")));
    },
  );
});

// The section registry is the one CMS-adjacent collection staff read straight from the
// browser, so the Staff access picker can offer real desks. It carries no identity and no
// content -- a desk id, a label and a description -- and it is read-only to every client.
describe("content section registry", () => {
  for (const uid of ["super", "admin", "regular", "contributor"]) {
    it(`${uid} reads the registry so the scoped-grant picker can be built`, async () => {
      await assertSucceeds(getDoc(doc(db(uid), "sections/watch")));
      await assertSucceeds(getDocs(collection(db(uid), "sections")));
    });
  }

  it("an unauthenticated reader gets nothing", async () => {
    await assertFails(getDoc(doc(db(null), "sections/watch")));
    await assertFails(getDocs(collection(db(null), "sections")));
  });

  it("a revoked session cannot read the registry", async () => {
    // hasValidStaffSession rejects a token minted before tokensValidAfter, the same gate
    // every other staff read uses.
    await assertFails(
      getDoc(doc(db("inactive-editor"), "sections/watch")),
    );
  });

  it("no client can add, change or remove a desk", async () => {
    // A browser that could write here could invent a scope nobody granted, and grantRole
    // validates against exactly this collection.
    for (const uid of ["super", "admin", "regular"]) {
      await assertFails(
        setDoc(doc(db(uid), "sections/news"), { id: "news", label: "News", order: 9 }),
      );
      await assertFails(updateDoc(doc(db(uid), "sections/watch"), { label: "Tampered" }));
      await assertFails(deleteDoc(doc(db(uid), "sections/watch")));
    }
  });
});

describe("default deny", () => {
  it("authed read of an unknown collection is denied", async () => {
    const database = db("regular");
    await assertFails(getDoc(doc(database, "randomCollection/x")));
  });

  it("authed write to an unknown collection is denied", async () => {
    const database = db("regular");
    await assertFails(
      setDoc(doc(database, "randomCollection/x"), {
        a: 1,
      }),
    );
  });

  it("unauthenticated write anywhere is denied", async () => {
    const database = db();
    await assertFails(
      setDoc(doc(database, "users/regular"), {
        role: "admin",
      }),
    );
  });
});

describe("voiceover review server boundary", () => {
  const paths = [
    "voiceoverLibrary/current",
    "voiceoverTakes/soft-spoken-watching-station-01",
    "voiceoverReviews/regular",
    "voiceoverReviews/regular/takes/soft-spoken-watching-station-01",
  ];

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot read or write voiceover records directly",
    async (uid) => {
      const database = db(uid);
      for (const path of paths) {
        await assertFails(getDoc(doc(database, path)));
        await assertFails(setDoc(doc(database, path), { forged: true }));
      }
    },
  );
});

// The author/staff/profile foundation (#1044) is entirely server-owned. These
// four collections carry account-to-author linkage, so a browser-writable path
// would let someone set their own authorId or claim another author's slug --
// and authorId is the permanent join key for every byline they ever publish.
// The public snapshot is server-only too: readers get it through the static
// build, not a client read.
describe("author profile collections", () => {
  const paths = [
    "cmsStaffRecords/regular",
    `cmsAuthorProfiles/${AUTHOR_ID}`,
    `cmsAuthorProfilesPublic/${AUTHOR_ID}`,
    "cmsAuthorSlugs/regular-person",
  ];

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot read any author profile document",
    async (uid) => {
      const database = db(uid);
      for (const path of paths) {
        await assertFails(getDoc(doc(database, path)));
      }
      await assertFails(getDocs(collection(database, "cmsAuthorProfilesPublic")));
      await assertFails(getDocs(collection(database, "cmsStaffRecords")));
    },
  );

  it.each(["regular", "editor", "admin", "super", undefined])(
    "client %s cannot write any author profile document",
    async (uid) => {
      const database = db(uid);
      for (const path of paths) {
        await assertFails(setDoc(doc(database, path), { forged: true }));
      }
    },
  );

  it("an owner cannot edit or publish their own profile directly", async () => {
    // The owner is the client most likely to be granted a shortcut here. They
    // must still go through the capability-checked callable, because the rules
    // cannot re-run the social-link allowlist or mint a redacted snapshot.
    const database = db("regular");
    await assertFails(
      updateDoc(doc(database, `cmsAuthorProfiles/${AUTHOR_ID}`), {
        displayName: "Someone Else",
      }),
    );
    await assertFails(
      setDoc(doc(database, `cmsAuthorProfilesPublic/${AUTHOR_ID}`), {
        authorId: AUTHOR_ID,
        slug: "regular-person",
        displayName: "Regular Person",
      }),
    );
    await assertFails(
      setDoc(doc(database, "cmsAuthorSlugs/stolen"), {
        slug: "stolen",
        authorId: AUTHOR_ID,
        state: "active",
      }),
    );
  });

  it("keeps all four collections explicitly server-only in the rules source", () => {
    for (const name of [
      "cmsStaffRecords/{uid}",
      "cmsAuthorProfiles/{authorId}",
      "cmsAuthorProfilesPublic/{authorId}",
      "cmsAuthorSlugs/{slug}",
    ]) {
      const escaped = name.replace(/[{}]/g, (brace) => "\\" + brace);
      expect(rulesSource).toMatch(
        new RegExp("match /" + escaped + " \\{\\s+allow read, write: if false;"),
      );
    }
  });
});

describe("byline projection rules", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const database = ctx.firestore();
      await setDoc(doc(database, `cmsBylineDirectory/${AUTHOR_ID}`), {
        authorId: AUTHOR_ID,
        displayName: "Regular Person",
        jobTitle: null,
        eligible: true,
      });
      await setDoc(doc(database, "cmsBylineSelf/regular"), {
        authorId: AUTHOR_ID,
      });
    });
  });

  it.each(["regular", "editor", "admin", "super", "orientation-staff"])(
    "lets admitted staff %s read only the narrow directory",
    async (uid) => {
      const database = db(uid);
      await assertSucceeds(getDoc(doc(database, `cmsBylineDirectory/${AUTHOR_ID}`)));
      await assertSucceeds(getDocs(query(
        collection(database, "cmsBylineDirectory"), limit(200),
      )));
      await assertFails(setDoc(doc(database, `cmsBylineDirectory/${AUTHOR_ID}`), {
        eligible: false,
      }));
    },
  );

  it.each(["inactive-editor", "revoked-admin", "unapproved", undefined])(
    "refuses directory reads from %s",
    async (uid) => {
      const database = db(uid, uid === "revoked-admin" ? { auth_time: revokedAt } : {});
      await assertFails(getDoc(doc(database, `cmsBylineDirectory/${AUTHOR_ID}`)));
      await assertFails(getDocs(query(
        collection(database, "cmsBylineDirectory"), limit(200),
      )));
    },
  );

  it("requires a bounded directory query", async () => {
    await assertFails(getDocs(collection(db("regular"), "cmsBylineDirectory")));
    await assertFails(getDocs(query(
      collection(db("regular"), "cmsBylineDirectory"), limit(201),
    )));
  });

  it("lets only the active owner get a self mapping and never list or write it", async () => {
    await assertSucceeds(getDoc(doc(db("regular"), "cmsBylineSelf/regular")));
    await assertFails(getDoc(doc(db("admin"), "cmsBylineSelf/regular")));
    await assertFails(getDoc(doc(db("inactive-editor"), "cmsBylineSelf/inactive-editor")));
    await assertFails(getDocs(collection(db("regular"), "cmsBylineSelf")));
    await assertFails(setDoc(doc(db("regular"), "cmsBylineSelf/regular"), {
      authorId: "forged",
    }));
  });
});


describe.each([
  ["cmsPreviewSerializerJournals", "existing"],
  ["cmsPublicationSerializerJournals", "existing"],
  ["cmsPreviewPublicContexts", "existing"],
  ["cmsPreviewEditorialContexts", "existing"],
  ["cmsPreviewEditorialSeals", "existing"],
  ["system", "cmsPreviewRuntime"],
  ["cmsDeploymentReceipts", "functions"],
])(
  "%s cloud preview server boundary",
  (collectionName, documentId) => {
    it.each(["admin", "super", "regular", null])(
      "%s cannot read, list, create, update, or delete server state",
      async (uid) => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          await setDoc(doc(ctx.firestore(), collectionName, documentId), { schemaVersion: 1 });
        });
        const database = db(uid);
        const existing = doc(database, collectionName, documentId);
        await assertFails(getDoc(existing));
        await assertFails(getDocs(collection(database, collectionName)));
        await assertFails(setDoc(doc(database, collectionName, "new"), { schemaVersion: 1 }));
        await assertFails(updateDoc(existing, { schemaVersion: 2 }));
        await assertFails(deleteDoc(existing));
      },
    );
  },
);


function costLine(overrides = {}) {
  return {
    label: "Claude",
    category: "ai",
    project: "tooling",
    source: "manual",
    currency: "USD",
    cadence: "monthly",
    amountCents: null,
    vendor: "Anthropic",
    notes: "",
    enabled: true,
    autoKey: null,
    freshnessStatus: "blank",
    freshnessAt: null,
    updatedAt: "2026-09-15T15:00:00.000Z",
    updatedBy: "super",
    ...overrides,
  };
}

describe("cost ledger rules", () => {
  const paths = [
    "costLedgerLines/claude",
    "costLedgerPeriods/2026-09",
    "costLedgerSnapshots/2026-09-15",
    "costLedgerComparisons/example",
    "costLedgerAssumptions/hardware",
  ];

  async function seedCostLedger() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const root = ctx.firestore();
      await setDoc(doc(root, "costLedgerLines/claude"), costLine());
      await setDoc(doc(root, "costLedgerPeriods/2026-09"), {
        period: "2026-09",
        status: "open",
        currency: "USD",
        entries: {},
        closedAt: null,
        closedBy: null,
        updatedAt: "2026-09-15T15:00:00.000Z",
      });
      await setDoc(doc(root, "costLedgerSnapshots/2026-09-15"), {
        period: "2026-09",
        takenAt: "2026-09-15T15:00:00.000Z",
        monthlyCents: 0,
        annualRunRateCents: 0,
        blankLineCount: 1,
        knownLineCount: 0,
        byCategory: {},
        byProject: {},
      });
      await setDoc(doc(root, "costLedgerComparisons/example"), {
        vendor: "Example",
        sourceUrl: "https://example.com/pricing",
      });
      await setDoc(doc(root, "costLedgerAssumptions/hardware"), { machines: [] });
    });
  }

  it("lets an admin or super admin read every cost collection", async () => {
    await seedCostLedger();
    for (const uid of ["admin", "super"]) {
      for (const path of paths) {
        await assertSucceeds(getDoc(doc(db(uid), path)));
      }
    }
  });

  it("denies other readers and every client write", async () => {
    await seedCostLedger();
    for (const uid of ["editor", "inactive-admin", null]) {
      await assertFails(getDoc(doc(db(uid), "costLedgerLines/claude")));
    }
    for (const uid of ["admin", "super", "editor", "inactive-admin", null]) {
      for (const path of paths) {
        const reference = doc(db(uid), path);
        await assertFails(setDoc(reference, costLine()));
        await assertFails(updateDoc(reference, { label: "Changed" }));
        await assertFails(deleteDoc(reference));
      }
    }
  });
});

describe("transcription credentials server boundary", () => {
  for (const uid of ["regular", "admin", "super", null]) {
    it(`${uid ?? "anonymous"} cannot read, list or write encrypted provider credentials`, async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "mediaTranscriptionCredentials/owned"), { ownerUid: uid, ciphertext: "synthetic-only" });
      });
      const database = db(uid);
      await assertFails(getDoc(doc(database, "mediaTranscriptionCredentials/owned")));
      await assertFails(getDocs(collection(database, "mediaTranscriptionCredentials")));
      await assertFails(setDoc(doc(database, "mediaTranscriptionCredentials/owned"), { ownerUid: uid }));
      await assertFails(deleteDoc(doc(database, "mediaTranscriptionCredentials/owned")));
    });
  }
});
