import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { beforeEach, describe, expect, it } from "vitest";
import { FieldValue } from "firebase-admin/firestore";
import endpoint from "../../functions/navigation-preferences.js";
import auth from "../../functions/lib/auth.js";
import firebase from "../../functions/lib/firebase.js";
import { createRequire } from "node:module";
const nativeAuth = createRequire(import.meta.url)("../../functions/lib/auth.js");

const caller = { uid: "staff-1", authTime: 200 };
const link = (id = "one", destination = { kind: "url", url: "https://example.test/news" }) => ({
  id: `custom:${id}`, kind: "link", label: "News", icon: "link", destination,
});
const navigation = (custom = [link()]) => ({ version: 4, order: ["home", ...custom.map((item) => item.id)], hidden: [], custom });
const approvedProfile = () => ({
  role: "staff", grants: [{ role: "staff" }], active: true, tokensValidAfter: 100,
  displayName: "Staff member", preferences: { appearance: "dark", navigation: { version: 3, order: ["home"], hidden: [] } },
});

function cloneValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (typeof value.isEqual === "function") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    try { return structuredClone(value); } catch { return value; }
  }
  const copy = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
  return copy;
}

function applyWrite(documents, { ref, data, options }) {
  if (!options?.mergeFields) {
    documents.set(ref.path, cloneValue(data));
    return;
  }
  const stored = cloneValue(documents.get(ref.path) ?? {});
  for (const field of options.mergeFields) {
    const parts = field.split(".");
    let target = stored;
    let source = data;
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) target[part] = {};
      target = target[part];
      source = source[part];
    }
    const key = parts.at(-1);
    const value = source[key];
    if (value?.isEqual?.(FieldValue.delete())) delete target[key];
    else target[key] = cloneValue(value);
  }
  documents.set(ref.path, stored);
}

// Firestore boundary fake: reads belong to a transaction, writes apply only the
// merge mask, and a concurrent document change retries against the new profile.
function firestore(profile = approvedProfile(), changeBeforeCommit) {
  const documents = new Map([["users/other-staff", approvedProfile()]]);
  if (profile !== undefined) documents.set("users/staff-1", structuredClone(profile));
  const reads = [];
  let version = 0;
  let changed = false;
  const database = {
    documents, reads,
    replace(path, value) {
      if (value === undefined) documents.delete(path); else documents.set(path, structuredClone(value));
      version += 1;
    },
    collection(name) {
      return {
        doc(id) { return { path: `${name}/${id}`, get() { throw new Error("A profile read must be transactional"); } }; },
        where(field, op, value) {
          if (field !== "ownerUid" || op !== "==") throw new Error(`Unexpected share query ${field} ${op}`);
          return { path: `${name}?ownerUid=${value}`, kind: "query", value };
        },
      };
    },
    async runTransaction(work) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshotVersion = version;
        const writes = [];
        await work({
          async get(ref) {
            reads.push(ref.path);
            if (ref.kind === "query") {
              const docs = [];
              for (const [path, stored] of documents) {
                if (!path.startsWith("navigationShares/")) continue;
                const data = cloneValue(stored);
                if (data?.ownerUid === ref.value) docs.push({ id: path.slice("navigationShares/".length), data: () => cloneValue(stored) });
              }
              return { forEach(visit) { for (const entry of docs) visit(entry); } };
            }
            const stored = documents.get(ref.path);
            return { exists: documents.has(ref.path), data: () => cloneValue(stored) };
          },
          set(ref, data, options) { writes.push({ ref, data, options }); },
        });
        if (!changed && changeBeforeCommit) { changed = true; changeBeforeCommit(database); }
        if (snapshotVersion !== version) continue;
        for (const write of writes) {
          applyWrite(documents, write);
          version += 1;
        }
        return;
      }
      throw new Error("The transaction could not settle");
    },
  };
  return database;
}

async function submit(database, body = { action: "save", navigation: navigation() }, overrides = {}) {
  const request = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-token", "x-firebase-appcheck": "synthetic-appcheck" },
    body, rawBody: Buffer.from(JSON.stringify(body)),
    ...overrides.request,
  };
  const response = {
    statusCode: null, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader(key, value) { this.headers[key] = value; },
  };
  const handler = endpoint.createCmsSetNavigationPreferencesHandler({
    firestore: database,
    verifyAuthTokenFn: overrides.verifyAuthTokenFn ?? (async () => caller),
    verifyAppCheckTokenFn: overrides.verifyAppCheckTokenFn ?? (async () => ({ appId: "synthetic" })),
    getAuthUser: overrides.getAuthUser ?? (async () => { throw new Error("getAuthUser was not expected"); }),
    log: { error() {} },
  });
  await handler(request, response);
  return response;
}

describe("navigation preferences server write boundary", () => {
  it("saves only the caller's navigation and preserves profile authority and sibling preferences", async () => {
    const database = firestore();
    const before = structuredClone(database.documents.get("users/staff-1"));
    const other = structuredClone(database.documents.get("users/other-staff"));
    const saved = navigation([link("post", { kind: "post", id: "post-immutable-id" }), link("page", { kind: "page", id: "page-immutable-id" })]);
    const response = await submit(database, { action: "save", navigation: saved });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(database.documents.get("users/staff-1")).toEqual({ ...before, preferences: { ...before.preferences, navigation: saved } });
    expect(database.documents.get("users/other-staff")).toEqual(other);
    expect(database.reads).toEqual(["users/staff-1", "navigationShares?ownerUid=staff-1"]);
    expect(response.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("accepts ten links, ten sections and a section with nine child links without content reads", async () => {
    for (const custom of [Array.from({ length: 10 }, (_, index) => link(`link-${index}`)),
      Array.from({ length: 10 }, (_, index) => ({ id: `custom:section-${index}`, kind: "section", label: "Editorial", links: [] })),
      [{ id: "custom:section", kind: "section", label: "Editorial", icon: "resize", links: Array.from({ length: 9 }, (_, index) => link(`child-${index}`)) }]]) {
      const database = firestore();
      const saved = navigation(custom);
      saved.hidden = custom.length === 1 ? [custom[0].links[8].id] : [custom[9].id];
      expect((await submit(database, { action: "save", navigation: saved })).statusCode).toBe(200);
      expect(database.documents.get("users/staff-1").preferences.navigation).toEqual(saved);
      expect(database.reads).toEqual(["users/staff-1", "navigationShares?ownerUid=staff-1"]);
    }
  });

  it("accepts ten shared ids beside ten custom links and rejects eleven", async () => {
    const custom = Array.from({ length: 10 }, (_, index) => link(`link-${index}`));
    const shared = Array.from({ length: 10 }, (_, index) => `custom:share-${index}`);
    const saved = {
      version: 4,
      order: ["home", ...custom.map((item) => item.id), ...shared],
      hidden: [shared[0]],
      custom,
      shared,
    };
    const database = firestore();
    const response = await submit(database, { action: "save", navigation: saved });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(database.documents.get("users/staff-1").preferences.navigation).toEqual(saved);
    expect(database.reads).toEqual(["users/staff-1", "navigationShares?ownerUid=staff-1"]);

    const tooMany = {
      ...saved,
      shared: [...shared, "custom:share-10"],
      order: [...saved.order, "custom:share-10"],
    };
    expect((await submit(firestore(), { action: "save", navigation: tooMany })).statusCode).toBe(400);
    const stray = navigation();
    stray.order = [...stray.order, "custom:share-0"];
    expect((await submit(firestore(), { action: "save", navigation: stray })).statusCode).toBe(400);
  });

  it("repairs malformed preferences without replacing profile fields", async () => {
    for (const preferences of [null, "legacy", []]) {
      const profile = { ...approvedProfile(), preferences };
      const database = firestore(profile);
      expect((await submit(database)).statusCode).toBe(200);
      expect(database.documents.get("users/staff-1")).toEqual({ ...profile, preferences: { navigation: navigation() } });
    }
  });

  it("resets only navigation and keeps the existing profile", async () => {
    const database = firestore();
    const profile = structuredClone(database.documents.get("users/staff-1"));
    expect((await submit(database, { action: "reset" })).statusCode).toBe(200);
    expect(database.documents.get("users/staff-1")).toEqual({ ...profile, preferences: { appearance: "dark" } });
  });

  it("denies missing, inactive, malformed and revoked staff sessions without recreating a profile", async () => {
    for (const profile of [undefined, { ...approvedProfile(), active: false }, { ...approvedProfile(), active: null },
      { ...approvedProfile(), tokensValidAfter: 200 }, { ...approvedProfile(), tokensValidAfter: 201 },
      { ...approvedProfile(), tokensValidAfter: "100" }]) {
      const database = firestore();
      database.replace("users/staff-1", profile);
      const before = [...database.documents];
      expect((await submit(database)).statusCode).toBe(403);
      expect([...database.documents]).toEqual(before);
    }
    for (const authTime of [null, undefined, 0]) {
      expect((await submit(firestore(), undefined, { verifyAuthTokenFn: async () => ({ ...caller, authTime }) })).statusCode).toBe(403);
    }
  });

  it("matches admission defaults for profiles without active or revocation fields", async () => {
    const profile = approvedProfile(); delete profile.active; delete profile.tokensValidAfter;
    expect((await submit(firestore(profile))).statusCode).toBe(200);
  });

  it("rechecks admission when a concurrent profile change forces a transaction retry", async () => {
    for (const changedProfile of [undefined, { ...approvedProfile(), active: false }, { ...approvedProfile(), tokensValidAfter: 200 }]) {
      const database = firestore(approvedProfile(), (current) => current.replace("users/staff-1", changedProfile));
      expect((await submit(database)).statusCode).toBe(403);
      expect(database.documents.get("users/staff-1")).toEqual(changedProfile);
      expect(database.reads).toEqual(["users/staff-1", "navigationShares?ownerUid=staff-1", "users/staff-1"]);
    }
  });

  it("rejects target and authority injection and unknown action fields before database reads", async () => {
    for (const body of [{ action: "save", navigation: navigation(), targetUid: "other-staff" },
      { action: "save", navigation: navigation(), role: "super_admin" },
      { action: "reset", navigation: navigation() }, { action: "delete" },
      { action: "save", preferences: { navigation: navigation() } }, [], null]) {
      const database = firestore();
      const before = [...database.documents];
      expect((await submit(database, body)).statusCode).toBe(400);
      expect(database.reads).toEqual([]);
      expect([...database.documents]).toEqual(before);
    }
  });

  it("admits the gated live production address through the shared HTTP validator", async () => {
    const database = firestore();
    const saved = navigation([link("studio", { kind: "url", url: "/live-production" })]);
    expect((await submit(database, { action: "save", navigation: saved })).statusCode).toBe(200);
    expect(database.documents.get("users/staff-1").preferences.navigation).toEqual(saved);
  });

  it("refuses unsafe addresses at the HTTP boundary", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hello", "http://example.test", "//example.test",
      "/content/../account", "/content/%2faccount", "/unknown", "https://user:password@example.test", "https://example.test\\evil", "https://example.test/has space"]) {
      const database = firestore();
      expect((await submit(database, { action: "save", navigation: navigation([link("bad", { kind: "url", url })]) })).statusCode).toBe(400);
      expect(database.reads).toEqual([]);
    }
  });

  it("refuses malformed shapes, excess counts and duplicate IDs", async () => {
    const section = { id: "custom:section", kind: "section", label: "Group", links: [link()] };
    const invalid = [
      { ...navigation(), extra: true }, { ...navigation(), version: 3 }, { ...navigation(), custom: undefined },
      { ...navigation(), order: ["invented"] }, { ...navigation(), order: ["home", "home"] }, { ...navigation(), hidden: ["custom:missing"] },
      navigation([link(), link()]), navigation([{ ...link(), label: " " }]), navigation([{ ...link(), label: "x".repeat(61) }]),
      navigation([{ ...link(), icon: "invented" }]), navigation([{ ...link(), id: "home" }]), navigation([{ ...link(), role: "admin" }]),
      navigation([link("bad", { kind: "url", url: `https://example.test/${"x".repeat(2048)}` })]),
      navigation([link("bad", { kind: "post", id: "../other" })]), navigation([link("bad", { kind: "page", id: "x".repeat(129) })]),
      navigation([link("bad", { kind: "url", url: "/content", id: "other" })]),
      navigation([{ ...section, links: [section] }]), navigation([section, link()]),
      navigation(Array.from({ length: 11 }, (_, index) => link(`link-${index}`))),
      navigation([{ ...section, links: Array.from({ length: 10 }, (_, index) => link(`child-${index}`)) }]),
      navigation([section, ...Array.from({ length: 9 }, (_, index) => link(`link-${index}`))]),
      navigation(Array.from({ length: 10 }, (_, index) => link(`link-${index}`,
        { kind: "url", url: index === 9 ? "javascript:alert(1)" : "/content" }))),
      navigation([{ ...section, links: Array.from({ length: 9 }, (_, index) => link(`child-${index}`,
        { kind: "url", url: index === 8 ? "javascript:alert(1)" : "/content" })) }]),
    ];
    for (const record of invalid) {
      const database = firestore();
      expect((await submit(database, { action: "save", navigation: record })).statusCode).toBe(400);
      expect(database.reads).toEqual([]);
    }
  });

  it("enforces POST, bounded uncompressed JSON and both authentication gates before reads", async () => {
    for (const [request, status] of [[{ method: "GET" }, 405],
      [{ headers: { "content-type": "text/plain" } }, 415],
      [{ headers: { "content-type": "application/json", "content-encoding": "gzip" } }, 415],
      [{ rawBody: Buffer.alloc(32 * 1024 + 1) }, 413]]) {
      const database = firestore();
      expect((await submit(database, undefined, { request })).statusCode).toBe(status);
      expect(database.reads).toEqual([]);
    }
    for (const gate of ["verifyAuthTokenFn", "verifyAppCheckTokenFn"]) {
      const database = firestore();
      expect((await submit(database, undefined, { [gate]: async () => { throw new auth.AuthError("Invalid token"); } })).statusCode).toBe(401);
      expect(database.reads).toEqual([]);
    }
  });

  it("does not report infrastructure failures as an authentication failure", async () => {
    const database = firestore();
    const response = await submit(database, undefined, { verifyAuthTokenFn: async () => { throw new Error("Private backend details"); } });
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: "Navigation could not be saved." });
    expect(database.reads).toEqual([]);
  });

  it("carries verified token expiry without reading navigation or confusing revocation", async () => {
    for (const reason of ["token_expired", undefined]) {
      const database = firestore();
      const response = await submit(database, undefined, { verifyAuthTokenFn: async () => {
        throw new nativeAuth.AuthError("Invalid token", "session_expired", reason);
      } });
      expect(response.statusCode).toBe(401);
      expect(response.body).toEqual({ error: "Invalid token", code: "session_expired", ...(reason ? { reason } : {}) });
      expect(database.reads).toEqual([]);
    }
  });

  it("rejects a request ownerName before any read", async () => {
    const database = firestore();
    let authReads = 0;
    const saved = navigation();
    const before = [...database.documents];
    const response = await submit(database, { action: "save", navigation: saved, ownerName: "Sasha Mercer" }, {
      getAuthUser: async () => { authReads += 1; return { displayName: "Auth Name" }; },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "Use save with valid navigation, or reset without additional fields." });
    expect(authReads).toBe(0);
    expect(database.reads).toEqual([]);
    expect([...database.documents]).toEqual(before);
  });

  it("rejects a share toggle that also sends navigation before any read", async () => {
    const database = firestore();
    const before = [...database.documents];
    const response = await submit(database, {
      action: "share",
      itemId: "custom:desk",
      shared: true,
      navigation: navigation([link("desk")]),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "Use save with valid navigation, or reset without additional fields." });
    expect(database.reads).toEqual([]);
    expect([...database.documents]).toEqual(before);
  });

  it("rejects another account's item id before any read", async () => {
    const database = firestore();
    database.replace("navigationShares/custom:theirs", {
      ownerUid: "other-staff", ownerName: "Other", status: "active", item: link("theirs"),
    });
    const before = [...database.documents];
    const response = await submit(database, {
      action: "save", navigation: navigation(), sharedItemIds: ["custom:theirs"],
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "Use save with valid navigation, or reset without additional fields." });
    expect(database.reads).toEqual([]);
    expect([...database.documents]).toEqual(before);
  });
});

const ownerCaller = { uid: "owner-1", authTime: 200 };
const otherUid = "other-1";
const localEmulatorHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function emulatorHostname(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 1 ? value.slice(1, end) : "";
  }
  const portAt = value.lastIndexOf(":");
  return portAt > 0 && /^\d+$/.test(value.slice(portAt + 1)) ? value.slice(0, portAt) : value;
}

function requireEmulator() {
  if (!localEmulatorHosts.has(emulatorHostname(process.env.FIRESTORE_EMULATOR_HOST))) {
    throw new Error("FIRESTORE_EMULATOR_HOST must use 127.0.0.1, localhost, or ::1");
  }
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (project !== "demo-njpbs") throw new Error("Emulator project must be demo-njpbs");
}

function staffProfile(displayName = "Profile Name", navigationRecord) {
  return {
    role: "staff",
    grants: [{ role: "staff" }],
    active: true,
    tokensValidAfter: 100,
    displayName,
    preferences: navigationRecord === undefined
      ? { appearance: "dark" }
      : { appearance: "dark", navigation: navigationRecord },
  };
}

function expectShare(data, expected) {
  expect(typeof data.updatedAt?.toMillis).toBe("function");
  expect(data.updatedAt.toMillis()).toBeGreaterThan(0);
  const { updatedAt, ...rest } = data;
  expect(rest).toEqual(expected);
}

async function clearEmulator() {
  const response = await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(`Emulator clear failed: ${response.status}`);
}

async function seedUser(uid, value) {
  await firebase.db.collection("users").doc(uid).set(value);
}

async function seedShare(id, value) {
  await firebase.db.collection("navigationShares").doc(id).set({ ...value, updatedAt: new Date("2026-01-01T00:00:00.000Z") });
}

async function readUser(uid) {
  return (await firebase.db.collection("users").doc(uid).get()).data();
}

async function readShare(id) {
  const snap = await firebase.db.collection("navigationShares").doc(id).get();
  return snap.exists ? snap.data() : null;
}

function submitOwned(body, overrides = {}) {
  return submit(firebase.db, body, {
    verifyAuthTokenFn: async () => ownerCaller,
    getAuthUser: async () => ({ displayName: "Auth Name" }),
    ...overrides,
  });
}

describe("navigation share writes on the Firestore emulator", () => {
  beforeEach(async () => {
    requireEmulator();
    await clearEmulator();
  });

  it("stores the auth display name and updates the share body in one call", async () => {
    const previous = navigation();
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", previous));
    const created = navigation([link("desk", { kind: "url", url: "https://example.test/desk" })]);
    created.custom[0].label = "Desk link";
    const createdResponse = await submitOwned({
      action: "save", navigation: created, sharedItemIds: ["custom:desk"],
    });
    expect(createdResponse.statusCode).toBe(200);
    expect(createdResponse.body).toEqual({ success: true });
    expect((await readUser(ownerCaller.uid)).preferences.navigation).toEqual(created);
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "active",
      item: created.custom[0],
    });

    const edited = navigation([{ ...created.custom[0], label: "Updated desk link" }]);
    const editedResponse = await submitOwned({
      action: "save", navigation: edited, sharedItemIds: ["custom:desk"],
    }, { getAuthUser: async () => ({ displayName: "  Auth   Name  " }) });
    expect(editedResponse.statusCode).toBe(200);
    expect((await readUser(ownerCaller.uid)).preferences.navigation).toEqual(edited);
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "active",
      item: edited.custom[0],
    });
  });

  it("uses the profile name when auth has none, and Staff member when both are empty", async () => {
    await seedUser(ownerCaller.uid, staffProfile("Casey Editor"));
    const saved = navigation([link("desk")]);
    const profileName = await submitOwned(
      { action: "save", navigation: saved, sharedItemIds: ["custom:desk"] },
      { getAuthUser: async () => ({ displayName: "   " }) },
    );
    expect(profileName.statusCode).toBe(200);
    expect((await readShare("custom:desk")).ownerName).toBe("Casey Editor");

    await clearEmulator();
    await seedUser(ownerCaller.uid, staffProfile("  "));
    const fallback = await submitOwned(
      { action: "save", navigation: saved, sharedItemIds: ["custom:desk"] },
      { getAuthUser: async () => ({ displayName: null }) },
    );
    expect(fallback.statusCode).toBe(200);
    expect((await readShare("custom:desk")).ownerName).toBe("Staff member");
  });

  it("uses the profile name when the auth user does not exist", async () => {
    await seedUser(ownerCaller.uid, staffProfile("Casey Editor"));
    const response = await submitOwned(
      { action: "save", navigation: navigation([link("desk")]), sharedItemIds: ["custom:desk"] },
      { getAuthUser: async () => { const error = new Error("missing"); error.code = "auth/user-not-found"; throw error; } },
    );
    expect(response.statusCode).toBe(200);
    expect((await readShare("custom:desk")).ownerName).toBe("Casey Editor");
  });

  it("writes nothing when auth lookup fails for another reason", async () => {
    const previous = navigation();
    await seedUser(ownerCaller.uid, staffProfile("Casey Editor", previous));
    const response = await submitOwned(
      { action: "save", navigation: navigation([link("desk")]), sharedItemIds: ["custom:desk"] },
      { getAuthUser: async () => { const error = new Error("Private auth detail"); error.code = "auth/internal-error"; throw error; } },
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: "Navigation could not be saved." });
    expect(await readShare("custom:desk")).toBeNull();
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Casey Editor", previous));
  });

  it("caps the trusted name at 100 characters", async () => {
    await seedUser(ownerCaller.uid, staffProfile("Profile Name"));
    const response = await submitOwned(
      { action: "save", navigation: navigation([link("desk")]), sharedItemIds: ["custom:desk"] },
      { getAuthUser: async () => ({ displayName: "N".repeat(120) }) },
    );
    expect(response.statusCode).toBe(200);
    expect((await readShare("custom:desk")).ownerName).toBe("N".repeat(100));
  });

  it("tombstones an unshare with the last shared body, not the private edit in that save", async () => {
    const original = link("desk");
    original.label = "Public title";
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", navigation([original])));
    await seedShare("custom:desk", {
      ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "active", item: original,
    });
    const edited = link("desk");
    edited.label = "Current title";
    const unshared = await submitOwned({
      action: "save", navigation: navigation([edited]), sharedItemIds: [],
    });
    expect(unshared.statusCode).toBe(200);
    expect((await readUser(ownerCaller.uid)).preferences.navigation).toEqual(navigation([edited]));
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "removed",
      removedReason: "unshared",
      item: original,
    });

    const removed = await submitOwned({ action: "save", navigation: navigation([]) });
    expect(removed.statusCode).toBe(200);
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "removed",
      removedReason: "deleted",
      item: original,
    });
  });

  it("leaves an already removed share unchanged when a later save shares a different item", async () => {
    const original = link("desk");
    original.label = "Public title";
    const privatelyEdited = link("desk");
    privatelyEdited.label = "Private title";
    const notes = link("notes");
    notes.label = "Desk notes";
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", navigation([original])));
    await seedShare("custom:desk", {
      ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "removed", removedReason: "unshared", item: original,
    });
    const before = await readShare("custom:desk");
    const response = await submitOwned({
      action: "save",
      navigation: navigation([privatelyEdited, notes]),
      sharedItemIds: ["custom:notes"],
    });
    expect(response.statusCode).toBe(200);
    const stored = await readShare("custom:desk");
    expect(stored.ownerName).toBe("Old Name");
    expect(stored.status).toBe("removed");
    expect(stored.removedReason).toBe("unshared");
    expect(stored.item).toEqual(original);
    expect(stored.updatedAt.toMillis()).toBe(before.updatedAt.toMillis());
    expect((await readUser(ownerCaller.uid)).preferences.navigation).toEqual(navigation([privatelyEdited, notes]));
    expectShare(await readShare("custom:notes"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "active",
      item: notes,
    });
  });

  it("leaves an unshared tombstone unchanged when a later save omits the share list", async () => {
    const original = link("desk");
    original.label = "Public title";
    const privatelyEdited = link("desk");
    privatelyEdited.label = "Private title";
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", navigation([original])));
    await seedShare("custom:desk", {
      ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "removed", removedReason: "unshared", item: original,
    });
    const response = await submitOwned({ action: "save", navigation: navigation([privatelyEdited]) });
    expect(response.statusCode).toBe(200);
    const stored = await readShare("custom:desk");
    expect(stored.ownerName).toBe("Old Name");
    expect(stored.status).toBe("removed");
    expect(stored.removedReason).toBe("unshared");
    expect(stored.item).toEqual(original);
    expect((await readUser(ownerCaller.uid)).preferences.navigation).toEqual(navigation([privatelyEdited]));
  });

  it("refreshes an active share when the save omits the share list", async () => {
    const original = link("desk");
    original.label = "Public title";
    const current = link("desk");
    current.label = "Current title";
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", navigation([original])));
    await seedShare("custom:desk", {
      ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "active", item: original,
    });
    const response = await submitOwned({ action: "save", navigation: navigation([current]) });
    expect(response.statusCode).toBe(200);
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "active",
      item: current,
    });
  });

  it("tombstones every share this owner has when navigation is reset", async () => {
    const desk = link("desk");
    const notes = link("notes");
    notes.label = "Desk notes";
    const foreign = link("foreign");
    foreign.label = "Other desk";
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", navigation([desk, notes])));
    await seedUser(otherUid, staffProfile("Other Person", navigation([foreign])));
    await seedShare("custom:desk", { ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "active", item: desk });
    await seedShare("custom:notes", { ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "active", item: notes });
    await seedShare("custom:foreign", { ownerUid: otherUid, ownerName: "Other Person", status: "active", item: foreign });
    const response = await submitOwned({ action: "reset" });
    expect(response.statusCode).toBe(200);
    expect((await readUser(ownerCaller.uid)).preferences).toEqual({ appearance: "dark" });
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid, ownerName: "Auth Name", status: "removed", removedReason: "deleted", item: desk,
    });
    expectShare(await readShare("custom:notes"), {
      ownerUid: ownerCaller.uid, ownerName: "Auth Name", status: "removed", removedReason: "deleted", item: notes,
    });
    const untouched = await readShare("custom:foreign");
    expect(untouched.ownerUid).toBe(otherUid);
    expect(untouched.status).toBe("active");
    expect(untouched.item).toEqual(foreign);
    expect(await readUser(otherUid)).toEqual(staffProfile("Other Person", navigation([foreign])));
  });

  it("does not change another account's share or this profile when the item id is not owned", async () => {
    const foreign = link("foreign");
    const previous = navigation();
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", previous));
    await seedUser(otherUid, staffProfile("Other Person", navigation([foreign])));
    await seedShare("custom:foreign", {
      ownerUid: otherUid, ownerName: "Other Person", status: "active", item: foreign,
    });
    const missing = await submitOwned({
      action: "save", navigation: navigation([link("desk")]), sharedItemIds: ["custom:foreign"],
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toEqual({ error: "Use save with valid navigation, or reset without additional fields." });
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Profile Name", previous));
    expect((await readShare("custom:foreign")).ownerUid).toBe(otherUid);
    expect(await readShare("custom:desk")).toBeNull();

    const collidedItem = link("foreign");
    collidedItem.label = "Taken link";
    const collided = await submitOwned({
      action: "save",
      navigation: navigation([collidedItem]),
      sharedItemIds: ["custom:foreign"],
    });
    expect(collided.statusCode).toBe(409);
    expect(collided.body).toEqual({ error: "This plank is already shared by another account." });
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Profile Name", previous));
    const stored = await readShare("custom:foreign");
    expect(stored.ownerUid).toBe(otherUid);
    expect(stored.ownerName).toBe("Other Person");
    expect(stored.status).toBe("active");
    expect(stored.item).toEqual(foreign);
  });

  it("writes nothing for an unsafe URL or a section child id", async () => {
    const previous = navigation();
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", previous));
    const unsafe = await submitOwned({
      action: "save",
      navigation: navigation([link("bad", { kind: "url", url: "javascript:alert(1)" })]),
      sharedItemIds: ["custom:bad"],
    });
    expect(unsafe.statusCode).toBe(400);
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Profile Name", previous));
    expect(await readShare("custom:bad")).toBeNull();

    const section = {
      id: "custom:section", kind: "section", label: "Editorial", icon: "folder", links: [link("child")],
    };
    const child = await submitOwned({
      action: "save",
      navigation: navigation([section]),
      sharedItemIds: ["custom:child"],
    });
    expect(child.statusCode).toBe(400);
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Profile Name", previous));
    expect(await readShare("custom:section")).toBeNull();
    expect(await readShare("custom:child")).toBeNull();
  });

  it("toggles one share from the stored record and does not write navigation", async () => {
    const desk = link("desk");
    desk.label = "Stored desk";
    const notes = link("notes");
    notes.label = "Stored notes";
    const storedNav = {
      version: 4,
      order: ["pages", "custom:desk", "custom:notes", "home"],
      hidden: ["pages"],
      custom: [desk, notes],
    };
    const profile = staffProfile("Profile Name", storedNav);
    await seedUser(ownerCaller.uid, profile);
    await seedShare("custom:notes", {
      ownerUid: ownerCaller.uid, ownerName: "Old Name", status: "active", item: notes,
    });

    const shared = await submitOwned({ action: "share", itemId: "custom:desk", shared: true });
    expect(shared.statusCode).toBe(200);
    expect(await readUser(ownerCaller.uid)).toEqual(profile);
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid, ownerName: "Auth Name", status: "active", item: desk,
    });
    const notesShare = await readShare("custom:notes");
    expect(notesShare.status).toBe("active");
    expect(notesShare.item).toEqual(notes);
    expect(notesShare.ownerName).toBe("Old Name");

    const edited = link("desk");
    edited.label = "Private title";
    const editedNav = { ...storedNav, custom: [edited, notes] };
    await seedUser(ownerCaller.uid, staffProfile("Profile Name", editedNav));
    const stopped = await submitOwned({ action: "share", itemId: "custom:desk", shared: false });
    expect(stopped.statusCode).toBe(200);
    expect(await readUser(ownerCaller.uid)).toEqual(staffProfile("Profile Name", editedNav));
    expectShare(await readShare("custom:desk"), {
      ownerUid: ownerCaller.uid,
      ownerName: "Auth Name",
      status: "removed",
      removedReason: "unshared",
      item: desk,
    });
    expect((await readShare("custom:notes")).status).toBe("active");
    expect((await readShare("custom:notes")).ownerName).toBe("Old Name");
  });

  it("rejects a share id the caller does not own and a section child", async () => {
    const childLink = link("child");
    const section = {
      id: "custom:section", kind: "section", label: "Editorial", icon: "folder", links: [childLink],
    };
    const storedNav = navigation([section]);
    const profile = staffProfile("Profile Name", storedNav);
    await seedUser(ownerCaller.uid, profile);
    const foreign = link("foreign");
    foreign.label = "Other desk";
    await seedShare("custom:foreign", {
      ownerUid: otherUid, ownerName: "Other Person", status: "active", item: foreign,
    });

    const notOwned = await submitOwned({ action: "share", itemId: "custom:foreign", shared: true });
    expect(notOwned.statusCode).toBe(400);
    expect(notOwned.body).toEqual({ error: "Share one of your top-level planks or spans." });
    expect(await readUser(ownerCaller.uid)).toEqual(profile);
    expect((await readShare("custom:foreign")).ownerUid).toBe(otherUid);
    expect((await readShare("custom:foreign")).item).toEqual(foreign);

    const child = await submitOwned({ action: "share", itemId: "custom:child", shared: true });
    expect(child.statusCode).toBe(400);
    expect(child.body).toEqual({ error: "Share one of your top-level planks or spans." });
    expect(await readUser(ownerCaller.uid)).toEqual(profile);
    expect(await readShare("custom:section")).toBeNull();
    expect(await readShare("custom:child")).toBeNull();

    const taken = link("foreign");
    taken.label = "Taken link";
    const takenNav = navigation([taken]);
    const takenProfile = staffProfile("Profile Name", takenNav);
    await seedUser(ownerCaller.uid, takenProfile);
    const collided = await submitOwned({ action: "share", itemId: "custom:foreign", shared: true });
    expect(collided.statusCode).toBe(409);
    expect(collided.body).toEqual({ error: "This plank is already shared by another account." });
    expect(await readUser(ownerCaller.uid)).toEqual(takenProfile);
    expect((await readShare("custom:foreign")).ownerUid).toBe(otherUid);
    expect((await readShare("custom:foreign")).item).toEqual(foreign);
  });
});
