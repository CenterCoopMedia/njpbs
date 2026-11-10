// Read-time resolution of the activity stream's raw identifiers (#1038).
//
// The audit rows themselves are append-only compliance evidence and are never
// rewritten: every readable name here is derived when the page is read, from the
// directory as it stands now. These tests pin that, the privacy gate, and each
// fallback an editor can actually hit -- a renamed account, a deactivated one, a
// deleted one, deleted content, and a code nobody has a label for yet.

import { describe, expect, it, vi } from "vitest";

import activityDirectory from "../../functions/lib/activity-directory.js";

const {
  UNKNOWN_ACTOR_LABEL,
  DELETED_ACTOR_LABEL,
  DELETED_CONTENT_LABEL,
  UNAVAILABLE_LABEL,
  activityVisibility,
  describeActivityAction,
  describeActivitySource,
  parseActivityTarget,
  resolveActivityEntries,
} = activityDirectory;

// A Firestore double that answers batched reads and records every call, so a
// test can assert that resolution reads and never writes.
function makeDirectory({ users = {}, documents = {}, failGetAll = false } = {}) {
  const reads = [];
  const writes = [];
  const store = { users, ...documents };
  const snapshot = (collection, id) => {
    const data = store[collection]?.[id];
    return { id, exists: data !== undefined, data: () => data, ref: { collection, id } };
  };
  const firestore = {
    reads,
    writes,
    collection(name) {
      return {
        doc(id) {
          return {
            collection: name,
            id,
            async get() {
              reads.push(`${name}/${id}`);
              return snapshot(name, id);
            },
            set: (...args) => writes.push(["set", name, id, ...args]),
            update: (...args) => writes.push(["update", name, id, ...args]),
            delete: () => writes.push(["delete", name, id]),
          };
        },
        add: (...args) => writes.push(["add", name, ...args]),
      };
    },
    async getAll(...refs) {
      if (failGetAll) throw new Error("directory unavailable");
      return refs.map((ref) => {
        reads.push(`${ref.collection}/${ref.id}`);
        return snapshot(ref.collection, ref.id);
      });
    },
  };
  return firestore;
}

const silentLog = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

const savedEntry = (overrides = {}) => ({
  id: "log-1",
  actorUid: "editor-1",
  actorEmail: "fixture-9a367e962e@example.org",
  action: "cms.save",
  target: "cmsPages/watch",
  before: { status: "draft" },
  after: { status: "in_review" },
  source: "203.0.113.9",
  at: "2026-08-18T20:15:00.000Z",
  ...overrides,
});

async function resolveOne(entry, options = {}) {
  const { visibility = { people: true }, log = silentLog(), ...directory } = options;
  const firestore = makeDirectory(directory);
  const [resolved] = await resolveActivityEntries({
    firestore,
    entries: [entry],
    visibility,
    log,
  });
  return { resolved, firestore, log };
}

describe("activity action language", () => {
  it("translates known codes into newsroom language", () => {
    expect(describeActivityAction("cms.save")).toEqual({
      code: "cms.save",
      label: "Content saved",
      known: true,
    });
    expect(describeActivityAction("roles.grant").label).toBe("Role granted");
  });

  it("makes an unlabeled code readable instead of showing punctuation", () => {
    // The namespace is machine vocabulary, not a word: "Cms some new thing"
    // reads as a defect to the administrator looking at the card. The exact code
    // stays in the response and in the row's support details.
    expect(describeActivityAction("cms.some_new-thing")).toEqual({
      code: "cms.some_new-thing",
      label: "Some new thing",
      known: false,
    });
    expect(describeActivityAction("media.brand_new").label).toBe("Brand new");
    expect(describeActivityAction("author_profile.brand_new").label).toBe(
      "Brand new",
    );
  });

  it("keeps an unfamiliar namespace rather than guessing it away", () => {
    expect(describeActivityAction("newthing.happened").label).toBe(
      "Newthing happened",
    );
    expect(describeActivityAction("cms.").label).toBe("Cms");
  });

  it("names a missing or unusable action rather than printing a blank", () => {
    for (const value of [null, undefined, "", "   ", 7]) {
      expect(describeActivityAction(value)).toMatchObject({
        label: "Unknown action",
        known: false,
      });
    }
  });
});

describe("activity source language", () => {
  it("names the automated and human origins in plain words", () => {
    expect(describeActivitySource("scheduler")).toMatchObject({
      label: "Scheduled automation",
    });
    expect(describeActivitySource("upload")).toMatchObject({ label: "Media upload" });
  });

  it("reports a request address as the admin app and keeps the address as detail", () => {
    expect(describeActivitySource("203.0.113.9")).toEqual({
      label: "Admin app",
      detail: "203.0.113.9",
    });
  });

  it("names an unrecorded source", () => {
    expect(describeActivitySource(null)).toEqual({ label: "Not recorded", detail: null });
  });
});

describe("activity target parsing", () => {
  it("reads a stored collection path", () => {
    expect(parseActivityTarget({ action: "cms.save", target: "cmsPages/watch" })).toMatchObject({
      kind: "content",
      collection: "cmsPages",
      documentId: "watch",
    });
  });

  it("reads a bare uid recorded by a role or staff action as a person", () => {
    expect(parseActivityTarget({ action: "roles.grant", target: "editor-1" })).toMatchObject({
      kind: "person",
      documentId: "editor-1",
    });
    expect(
      parseActivityTarget({ action: "staff.deactivate", target: "editor-1" }),
    ).toMatchObject({ kind: "person" });
  });

  it("reads a users path as a person", () => {
    expect(
      parseActivityTarget({ action: "roles.revoke", target: "users/editor-1" }),
    ).toMatchObject({ kind: "person", documentId: "editor-1" });
  });

  it("reads a staff record path as a person, because its id is the account id", () => {
    expect(
      parseActivityTarget({
        action: "author_profile.staff_resync",
        target: "cmsStaffRecords/editor-1",
      }),
    ).toMatchObject({ kind: "person", collection: "users", documentId: "editor-1" });
  });

  it("does not invent a record for a missing or unrecognized target", () => {
    expect(parseActivityTarget({ action: "cms.save", target: null })).toMatchObject({
      kind: "none",
    });
    expect(
      parseActivityTarget({ action: "cms.save", target: { id: "not-a-path" } }),
    ).toMatchObject({ kind: "none" });
    expect(
      parseActivityTarget({ action: "cms.save", target: "someOtherThing/abc" }),
    ).toMatchObject({ kind: "opaque", collection: "someOtherThing", documentId: "abc" });
  });
});

describe("resolveActivityEntries", () => {
  it("shows the current name for a renamed account rather than the stored one", async () => {
    const { resolved } = await resolveOne(savedEntry(), {
      users: {
        "editor-1": {
          displayName: "Alex Sample",
          email: "alex.sample@example.org",
          active: true,
        },
      },
      documents: { cmsPages: { watch: { title: "Watch", type: "page" } } },
    });

    expect(resolved.resolved.actor).toMatchObject({
      label: "Alex Sample",
      status: "active",
      email: "alex.sample@example.org",
      uid: "editor-1",
    });
    expect(resolved.resolved.target).toMatchObject({
      label: "Watch",
      type: "Page",
      status: "found",
      id: "cmsPages/watch",
    });
    expect(resolved.resolved.action).toMatchObject({ label: "Content saved" });
    expect(resolved.resolved.source).toMatchObject({ label: "Admin app" });
  });

  it("marks a deactivated account without hiding who acted", async () => {
    const { resolved } = await resolveOne(savedEntry(), {
      users: {
        "editor-1": {
          displayName: "Alex Sample",
          email: "alex.sample@example.org",
          active: false,
        },
      },
      documents: { cmsPages: { watch: { title: "Watch", type: "page" } } },
    });
    expect(resolved.resolved.actor).toMatchObject({
      label: "Alex Sample",
      status: "deactivated",
    });
  });

  it("falls back clearly for an account that no longer exists", async () => {
    const { resolved } = await resolveOne(savedEntry());
    expect(resolved.resolved.actor).toMatchObject({
      label: DELETED_ACTOR_LABEL,
      status: "deleted",
      uid: "editor-1",
    });
  });

  it("names an unrecorded actor instead of leaving the row anonymous", async () => {
    const { resolved } = await resolveOne(savedEntry({ actorUid: null, actorEmail: null }));
    expect(resolved.resolved.actor).toMatchObject({
      label: UNKNOWN_ACTOR_LABEL,
      status: "unknown",
      uid: null,
    });
  });

  it("names the automated scheduler rather than a system uid", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ actorUid: "system:scheduler", actorEmail: null, source: "scheduler" }),
    );
    expect(resolved.resolved.actor).toMatchObject({
      label: "Scheduled publishing",
      status: "system",
    });
  });

  it("uses a safe email when the account has no display name", async () => {
    const { resolved } = await resolveOne(savedEntry(), {
      users: { "editor-1": { email: "alex.sample@example.org", active: true } },
    });
    expect(resolved.resolved.actor.label).toBe("alex.sample@example.org");
  });

  it("masks that email for a caller who may not see accounts", async () => {
    const { resolved } = await resolveOne(savedEntry(), {
      visibility: { people: false },
      users: { "editor-1": { email: "alex.sample@example.org", active: true } },
    });
    expect(resolved.resolved.actor.label).toBe("a•••@example.org");
    expect(resolved.resolved.actor.email).toBeNull();
    expect(resolved.resolved.actor.uid).toBeNull();
  });

  it("resolves template action labels and names from their canonical paths", async () => {
    for (const action of ["capture", "update", "remove"]) {
      const { resolved } = await resolveOne(savedEntry({ action: `post_template_${action}`, target: "cmsPostTemplates/brief" }), {
        documents: { cmsPostTemplates: { brief: { type: "post", title: "", name: "Monthly brief" } } },
      });
      expect(describeActivityAction(`post_template_${action}`).known).toBe(true);
      expect(resolved.resolved.target).toMatchObject({ label: "Monthly brief", type: "Post template", status: "found", id: "cmsPostTemplates/brief" });
    }
  });

  it("keeps a deleted record readable and keeps its immutable id", async () => {
    const { resolved } = await resolveOne(savedEntry({ target: "cmsPosts/gone-1" }));
    expect(resolved.resolved.target).toMatchObject({
      label: DELETED_CONTENT_LABEL,
      type: "Post",
      status: "deleted",
      id: "cmsPosts/gone-1",
    });
  });

  it("names an untitled record by its type instead of showing an empty label", async () => {
    const { resolved } = await resolveOne(savedEntry({ target: "cmsPosts/post-1" }), {
      documents: { cmsPosts: { "post-1": { title: "   ", type: "post" } } },
    });
    expect(resolved.resolved.target).toMatchObject({
      label: "Untitled post",
      type: "Post",
      status: "found",
    });
  });

  it("bounds resolved content labels by UTF-8 bytes", async () => {
    const oversizedTitle = "é".repeat(400_000);
    const { resolved } = await resolveOne(savedEntry({ target: "cmsPosts/post-1" }), {
      documents: { cmsPosts: { "post-1": { title: oversizedTitle, type: "post" } } },
    });

    expect(resolved.resolved.target.label).toBe(`${"é".repeat(126)}…`);
    expect(Buffer.byteLength(resolved.resolved.target.label, "utf8")).toBeLessThanOrEqual(256);
  });

  it("resolves a person target through the same directory", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ action: "roles.grant", target: "editor-1" }),
      {
        users: {
          "editor-1": { displayName: "Alex Sample", email: "fixture-00676e0e77@example.org", active: true },
          "super-1": { displayName: "Jordan Example", email: "jordan@example.org", active: true },
        },
      },
    );
    expect(resolved.resolved.target).toMatchObject({
      label: "Alex Sample",
      type: "Staff account",
      status: "found",
    });
  });

  it("resolves an onboarding-provision target as a staff account", async () => {
    const { resolved } = await resolveOne(
      savedEntry({
        action: "staff_access.onboarding_provision",
        target: "users/new-staffer",
      }),
      {
        users: {
          "new-staffer": {
            displayName: "New staffer",
            email: "fixture-b73e573251@example.org",
            active: true,
          },
        },
      },
    );

    expect(resolved.resolved.target).toMatchObject({
      label: "New staffer",
      type: "Staff account",
      status: "found",
    });
  });

  it("withholds a person target's immutable id from a caller who may not see accounts", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ action: "roles.grant", target: "editor-1" }),
      {
        visibility: { people: false },
        users: { "editor-1": { displayName: "Alex Sample", active: true } },
      },
    );
    expect(resolved.resolved.target.label).toBe("Alex Sample");
    expect(resolved.resolved.target.id).toBeNull();
  });

  it("names an author profile target by the profile's display name", async () => {
    const { resolved } = await resolveOne(
      savedEntry({
        action: "author_profile.publish",
        target: "cmsAuthorProfiles/author-7",
      }),
      {
        documents: {
          cmsAuthorProfiles: {
            "author-7": { displayName: "Alex Sample", slug: "alex-sample" },
          },
        },
      },
    );
    expect(resolved.resolved.target).toMatchObject({
      label: "Alex Sample",
      type: "Author profile",
      status: "found",
      id: "cmsAuthorProfiles/author-7",
    });
  });

  it("resolves a staff record target through the account it belongs to", async () => {
    const { resolved } = await resolveOne(
      savedEntry({
        action: "author_profile.staff_resync",
        target: "cmsStaffRecords/editor-1",
      }),
      { users: { "editor-1": { displayName: "Alex Sample", active: true } } },
    );
    expect(resolved.resolved.target).toMatchObject({
      label: "Alex Sample",
      type: "Staff account",
      status: "found",
    });
  });

  it("keeps the stored path readable when the collection is not one it knows", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ target: "someOtherThing/abc-1" }),
    );
    expect(resolved.resolved.target).toMatchObject({
      label: "someOtherThing/abc-1",
      status: "unknown",
      id: "someOtherThing/abc-1",
    });
  });

  it("names a queue reference by what was requested", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ action: "cms.publish", target: "queue-9f2" }),
    );
    expect(resolved.resolved.target).toMatchObject({
      label: "Publish request",
      type: "Request",
      id: "queue-9f2",
    });
  });

  it("names the public deployment system actor", async () => {
    const { resolved } = await resolveOne(
      savedEntry({ actorUid: "system:public-deployment", actorEmail: null }),
    );
    expect(resolved.resolved.actor).toMatchObject({
      label: "Public deployment",
      status: "system",
    });
  });

  it("reads the directory once per distinct account and record", async () => {
    const firestore = makeDirectory({
      users: { "editor-1": { displayName: "Alex Sample", active: true } },
      documents: { cmsPages: { watch: { title: "Watch", type: "page" } } },
    });
    await resolveActivityEntries({
      firestore,
      entries: [savedEntry(), savedEntry({ id: "log-2" }), savedEntry({ id: "log-3" })],
      visibility: { people: true },
      log: silentLog(),
    });
    expect(firestore.reads.sort()).toEqual(["cmsPages/watch", "users/editor-1"]);
  });

  it("never writes while resolving, so the recorded evidence stays exactly as stored", async () => {
    const entry = savedEntry();
    const stored = JSON.parse(JSON.stringify(entry));
    const { resolved, firestore } = await resolveOne(entry, {
      users: { "editor-1": { displayName: "Alex Sample", active: true } },
      documents: { cmsPages: { watch: { title: "Watch", type: "page" } } },
    });
    expect(firestore.writes).toEqual([]);
    expect(entry).toEqual(stored);
    for (const field of ["id", "action", "target", "before", "after", "source", "at"]) {
      expect(resolved[field]).toEqual(stored[field]);
    }
  });

  it("degrades to an unavailable label instead of leaking raw ids when the directory read fails", async () => {
    const log = silentLog();
    const { resolved } = await resolveOne(savedEntry(), { failGetAll: true, log });
    expect(resolved.resolved.actor).toMatchObject({
      label: UNAVAILABLE_LABEL,
      status: "unknown",
    });
    expect(resolved.resolved.target).toMatchObject({ label: UNAVAILABLE_LABEL });
    expect(resolved.resolved.action.label).toBe("Content saved");
    expect(log.error).toHaveBeenCalled();
  });
});

describe("activityVisibility", () => {
  it("opens account fields only to a principal who may view users", () => {
    expect(activityVisibility({ id: "a", grants: [{ role: "admin" }] })).toEqual({
      people: true,
    });
  });

  it("fails closed for a principal with no readable grants", () => {
    for (const principal of [null, undefined, {}, { grants: [] }, { grants: [{ role: "editor" }] }]) {
      expect(activityVisibility(principal)).toEqual({ people: false });
    }
  });
});
