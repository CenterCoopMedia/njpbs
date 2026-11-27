import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import usage from "../../functions/boardwalk-usage.js";

const firestore = isolatedFirestore("boardwalk-usage");
const start = Date.parse("2026-11-02T12:00:00Z"); // Monday
let time = start;
const actor = (uid = "staff-1", role = "staff") => ({ uid, approvedActive: true,
  principal: { id: uid, grants: [{ role }] } });
const view = { name: "screen.view", screen: "posts-list" };
const batch = (events = [view], extra = {}) => ({ batchId: randomUUID(), events, ...extra });
const request = body => ({ method: "POST", headers: {}, body });
function response() {
  return { statusCode: 0, body: null, set() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}
function handlers(overrides = {}) {
  return usage.createBoardwalkUsageHandlers({ firestore, authorize: async () => actor(),
    appCheck: async () => {}, analyticsEnabled: () => true, now: () => time, ...overrides });
}
async function invoke(handler, body) {
  const res = response();
  await handler(request(body), res);
  return res;
}
async function size(collection) { return (await firestore.collection(collection).get()).size; }
beforeEach(async () => {
  time = start;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, firestore);
});

describe("Boardwalk usage privacy and persistence contract (#4495)", () => {
  it("never writes while explicitly off", async () => {
    const disabled = handlers({ analyticsEnabled: () => false });
    expect((await invoke(disabled.collect, batch())).body).toEqual({ collected: false });
    expect(await size("cmsUsageEvents")).toBe(0);
    expect(await size("cmsUsagePresence")).toBe(0);
    expect(await size("cmsUsageDaily")).toBe(0);
  });

  it("records server identity, roles and time with 180-day raw and presence expiry", async () => {
    const { collect } = handlers();
    expect((await invoke(collect, batch([view,
      { name: "screen.duration", screen: "posts-list", durationMs: 12_000 },
      { name: "content.publish.request", screen: "posts-list", objectType: "record", objectId: "post-123" },
    ]))).statusCode).toBe(200);
    const raw = (await firestore.collection("cmsUsageEvents").get()).docs[0].data();
    expect(Object.keys(raw).sort()).toEqual(["collectedAt", "events", "purgeAt", "roles", "uid"]);
    expect(raw.uid).toBe("staff-1"); expect(raw.roles).toEqual(["staff"]);
    expect(raw.collectedAt.toMillis()).toBe(start);
    expect(raw.purgeAt.toMillis()).toBe(start + 180 * 86_400_000);
    const markers = await firestore.collection("cmsUsagePresence").get();
    expect(markers.size).toBe(2);
    for (const row of markers.docs) expect(row.data()).toEqual({ purgeAt: raw.purgeAt });
  });

  it("excludes agent and test accounts using the server-only profile field", async () => {
    await firestore.collection("users").doc("staff-1").set({ usageAnalyticsExcluded: true });
    expect((await invoke(handlers().collect, batch())).body).toEqual({ collected: false });
    for (const collection of ["cmsUsageEvents", "cmsUsagePresence", "cmsUsageDaily", "cmsUsageWeekly"]) expect(await size(collection)).toBe(0);
  });

  it("uses only the profile exclusion for collection, independently of automation guards", async () => {
    const { collect } = handlers();
    await firestore.collection("cmsAutomationAccounts").doc("staff-1").set({});
    await firestore.collection("users").doc("staff-1").set({ role: "staff", usageAnalyticsExcluded: false });
    expect((await invoke(collect, batch())).body).toEqual({ collected: true });
    await firestore.collection("users").doc("staff-1").update({ usageAnalyticsExcluded: true });
    expect((await invoke(collect, batch())).body).toEqual({ collected: false });
    expect(await size("cmsUsageEvents")).toBe(1);
  });

  it("deduplicates replays and counts distinct staff per day and week", async () => {
    const same = batch();
    const { collect, report } = handlers();
    await invoke(collect, same); await invoke(collect, same); await invoke(collect, batch());
    await invoke(handlers({ authorize: async () => actor("staff-2", "editor") }).collect, batch());
    let result = await invoke(report, { days: 7 });
    expect(result.body.daily.at(-1)).toEqual({ date: "2026-11-02", timezone: "America/New_York", activeUsers: 2 });
    expect(result.body.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 2 }]);
    expect(result.body.screens.find(row => row.id === "posts-list").views).toBe(3);
    time += 86_400_000;
    await invoke(collect, batch());
    result = await invoke(report, { days: 7 });
    expect(result.body.daily.at(-1).activeUsers).toBe(1);
    expect(result.body.weekly[0].activeUsers).toBe(2);
    time += 6 * 86_400_000;
    await invoke(collect, batch());
    expect((await invoke(report, { days: 7 })).body.weekly).toEqual([{ week: "2026-11-09", timezone: "America/New_York", activeUsers: 1 }]);
  });

  it("keys days and weeks by Eastern date and reports when Eastern keys began", async () => {
    await firestore.collection("cmsUsageDaily").doc("2026-10-31").set({ activeUsers: 1 });
    const { collect, report } = handlers();
    time = Date.parse("2026-11-03T02:30:00Z"); // Monday 9:30 PM EST
    await invoke(collect, batch());
    time = Date.parse("2026-11-09T04:30:00Z"); // Sunday 11:30 PM EST
    await invoke(handlers({ authorize: async () => actor("staff-2") }).collect, batch());
    const result = (await invoke(report, { days: 7 })).body;
    expect(result.timezone).toBe("America/New_York");
    expect(result.daily.map(row => [row.date, row.activeUsers])).toEqual([["2026-11-02", 1], ["2026-11-03", 0],
      ["2026-11-04", 0], ["2026-11-05", 0], ["2026-11-06", 0], ["2026-11-07", 0], ["2026-11-08", 1]]);
    expect(result.daily.every(row => row.timezone === "America/New_York")).toBe(true);
    expect(result.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 2 }]);
    expect(result.firstCollectedDate).toBe("2026-10-31");
    expect(result.easternFromDate).toBe("2026-11-02");
    // Window starts at Eastern midnight Nov. 2 (EST after the Nov. 1 DST change).
    expect(result.history.start).toBe("2026-11-02T05:00:00.000Z");
    time = Date.parse("2026-11-02T03:00:00Z"); // Sunday Nov. 1, 10 PM EST
    expect((await invoke(handlers().report, { days: 7 })).body.history.start).toBe("2026-10-26T04:00:00.000Z");
  });

  it("keeps UTC rows from before the change separate from Eastern rows", async () => {
    // UTC collector rows: Nov. 3 holds an evening Nov. 2 Eastern visit by staff-1.
    await firestore.collection("cmsUsageDaily").doc("2026-11-03").set({ activeUsers: 1, views: { posts: 1 } });
    await firestore.collection("cmsUsageWeekly").doc("2026-10-26").set({ activeUsers: 4 });
    time = Date.parse("2026-11-03T15:00:00Z");
    await invoke(handlers().collect, batch());
    const result = (await invoke(handlers().report, { days: 30 })).body;
    expect(result.easternFromDate).toBe("2026-11-03");
    expect(result.daily.find(row => row.date === "2026-11-02")).toEqual({ date: "2026-11-02", timezone: "UTC", activeUsers: 0 });
    // The switch date keeps its stored UTC row; staff-1 is counted again on the Eastern row.
    expect(result.daily.filter(row => row.date === "2026-11-03")).toEqual([{ date: "2026-11-03", timezone: "UTC", activeUsers: 1 },
      { date: "2026-11-03", timezone: "America/New_York", activeUsers: 1 }]);
    expect(result.weekly.slice(-2)).toEqual([{ week: "2026-10-26", timezone: "UTC", activeUsers: 4 },
      { week: "2026-11-02", timezone: "America/New_York", activeUsers: 1 }]);
    expect(result.screens.find(row => row.id === "posts-list").views).toBe(1);
    // The stored combined count keeps its own label instead of joining the list count.
    expect(result.screens.find(row => row.id === "posts")).toMatchObject({ label: "Posts, list and editor (before the split)", views: 1 });
  });

  it("preserves counters across batches and returns aggregate-only numeric projections to staff", async () => {
    const { collect, report } = handlers();
    const events = [view, { name: "screen.duration", screen: "posts-list", durationMs: 15_000 },
      { name: "preview.request", screen: "posts-list", objectType: "record", objectId: "private-post-id" }];
    await invoke(collect, batch(events)); await invoke(collect, batch(events));
    await firestore.collection("cmsUsageDaily").doc("2026-11-02").set({ uid: "private-user", events: events,
      actions: { unexpected: "private text" }, views: { guide: "not a count" } }, { merge: true });
    const res = await invoke(report, { days: 90 });
    expect(res.statusCode).toBe(200);
    expect(res.body.screens.find(row => row.id === "posts-list")).toMatchObject({ views: 2, visibleMs: 30_000 });
    expect(res.body.screens.find(row => row.id === "guide").views).toBe(0);
    expect(res.body.actions.find(row => row.id === "preview.request").count).toBe(2);
    expect(res.body.firstCollectedDate).toBe("2026-11-02");
    // 2026-11-02 has the stored UTC row and the new Eastern row.
    expect(res.body.daily).toHaveLength(91);
    expect(new Set(res.body.daily.map(row => row.date)).size).toBe(90);
    expect(JSON.stringify(res.body)).not.toMatch(/private-|unexpected|"(?:objectId|roles|uid)"/);
  });

  it("preserves view, duration and action counters when separate batches contain only one kind", async () => {
    const { collect, report } = handlers();
    await invoke(collect, batch([{ name: "screen.duration", screen: "posts-list", durationMs: 10_000 }]));
    await invoke(collect, batch([{ name: "content.publish.request", screen: "posts-list", objectType: "record", objectId: "post-1" }]));
    await invoke(collect, batch([view]));
    const res = await invoke(report, { days: 7 });
    expect(res.body.screens.find(row => row.id === "posts-list")).toMatchObject({ views: 1, visibleMs: 10_000 });
    expect(res.body.actions.find(row => row.id === "content.publish.request").count).toBe(1);
  });

  it("accepts event offsets, object-free actions and split editor and media screens", async () => {
    const events = [{ name: "screen.view", screen: "posts-editor", offsetMs: 4_000 },
      { name: "screen.duration", screen: "media-collections", durationMs: 1_000, offsetMs: 0 },
      { name: "media.upload.start", screen: "images", offsetMs: 600_000 },
      { name: "search", screen: "media-submissions" },
      { name: "content.schedule.request", screen: "pages-editor", objectType: "page", objectId: "page-1", offsetMs: 10 }];
    expect((await invoke(handlers().collect, batch(events))).statusCode).toBe(200);
    expect((await firestore.collection("cmsUsageEvents").get()).docs[0].data().events).toEqual(events);
    const res = (await invoke(handlers().report, { days: 7 })).body;
    expect(res.screens.find(row => row.id === "posts-editor").views).toBe(1);
    expect(res.screens.some(row => row.id === "posts")).toBe(false);
    expect(res.screens.find(row => row.id === "media-collections").visibleMs).toBe(1_000);
    for (const id of ["media.upload.start", "search", "content.schedule.request"]) {
      expect(res.actions.find(row => row.id === id).count).toBe(1);
    }
  });

  it.each([
    batch([view], { uid: "another-user" }),
    batch([{ ...view, title: "private title" }]),
    batch([{ ...view, path: "/content/post/private" }]),
    batch([{ ...view, screen: "private-search" }]),
    batch([{ ...view, screen: ["posts-list"] }]),
    batch([{ name: ["content.publish.request"], screen: "posts-list", objectType: "record", objectId: "id" }]),
    batch([{ name: "content.publish.request", screen: "posts-list", objectType: "record", objectId: ["id"] }]),
    batch([{ name: "content.publish.request", screen: "posts-list", objectType: "record", objectId: 123 }]),
    batch([{ name: "screen.duration", screen: "posts-list", durationMs: 60_001 }]),
    batch([{ name: "screen.duration", screen: "posts-list", durationMs: -1 }]),
    batch([{ name: "content.publish.request", screen: "posts-list", objectType: "invalid", objectId: "id" }]),
    batch([{ name: "media.upload", screen: "images", objectType: "media", objectId: "private field value" }]),
    batch([{ ...view, screen: "posts" }]),
    batch([{ ...view, offsetMs: -1 }]),
    batch([{ ...view, offsetMs: 600_001 }]),
    batch([{ ...view, offsetMs: "5" }]),
    batch([{ name: "search", screen: "images", query: "private search text" }]),
    batch([{ name: "media.upload.start", screen: "images", objectType: "record" }]),
    batch([{ name: "media.upload.start", screen: "images", objectId: "id" }]),
    batch([{ name: "media.upload.start", screen: "images", durationMs: 5 }]),
    batch(Array.from({ length: 21 }, () => view)),
    batch([], { batchId: "bad" }),
  ])("rejects content capture, spoofed identity and invalid event schemas (%#)", async body => {
    expect((await invoke(handlers().collect, body)).statusCode).toBe(400);
    expect(await size("cmsUsageEvents")).toBe(0);
  });

  it.each([
    { appCheck: async () => { throw { status: 401 }; } },
    { authorize: async () => { throw { status: 403 }; } },
    { authorize: async () => ({ ...actor(), approvedActive: false }) },
    { authorize: async () => actor("no-access", "unknown") },
  ])("requires current approved authority and App Check for collection and reports (%#)", async overrides => {
    const { collect, report } = handlers(overrides);
    for (const [handler, body] of [[collect, batch()], [report, { days: 7 }]]) {
      expect([401, 403]).toContain((await invoke(handler, body)).statusCode);
    }
    expect(await size("cmsUsageEvents")).toBe(0);
  });

  it.each([{ days: 7, uid: "other" }, { days: 7, perPerson: true }, { days: 180 }, null])("refuses person-level or unbounded report requests (%#)", async body => {
    expect((await invoke(handlers().report, body)).statusCode).toBe(400);
  });

  it("admits section-scoped staff with Reports authority", async () => {
    const scoped = actor();
    scoped.principal.grants = [{ role: "editor", sections: ["news"] }];
    const { collect, report } = handlers({ authorize: async () => scoped });
    expect((await invoke(collect, batch())).body).toEqual({ collected: true });
    expect((await invoke(report, { days: 7 })).statusCode).toBe(200);
  });

  it("reuses historical operations and excludes automation and unknown actors", async () => {
    for (const uid of ["person", "agent"]) await firestore.collection("users").doc(uid).set({ role: "editor" });
    await firestore.collection("cmsAutomationAccounts").doc("person").set({});
    await firestore.collection("users").doc("agent").update({ usageAnalyticsExcluded: true });
    const audit = firestore.collection("admin_logs");
    for (const actorUid of ["person", "agent", "unknown", "system:publisher"]) {
      await audit.add({ actorUid, timestamp: Timestamp.fromMillis(start - 1000), at: new Date(start - 1000).toISOString(), action: "media.upload", before: { draft: "private content" } });
    }
    await audit.add({ actorUid: "person", timestamp: Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z")), at: "2026-01-01T00:00:00.000Z", action: "media.upload" });
    await audit.add({ actorUid: "person", timestamp: Timestamp.fromMillis(start), at: null, action: "auth.login" });
    const res = await invoke(handlers().report, { days: 7 });
    expect(res.body.analyticsEnabled).toBe(true);
    expect(res.body.history.status).toBe("ready");
    expect(res.body.history.actions.find(row => row.id === "media.upload").count).toBe(1);
    expect(res.body.history.actions.find(row => row.id === "auth.login").count).toBe(1);
    expect(JSON.stringify(res.body.history)).not.toMatch(/person|actorUid|before|private|system:|unknown/);
    expect(await size("cmsUsageEvents")).toBe(0);
  });

  it("shows incomplete historical data as unavailable, while new analytics remain usable", async () => {
    await firestore.collection("admin_logs").add({ action: "auth.login", actorUid: "person" });
    await invoke(handlers().collect, batch());
    const res = await invoke(handlers().report, { days: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.body.history).toMatchObject({ status: "unavailable", actions: [] });
    expect(res.body.screens.find(row => row.id === "posts-list").views).toBe(1);
  });

  it("shares concurrent report snapshots per window for 60 seconds and rechecks authority on cache hits", async () => {
    await firestore.collection("users").doc("person").set({ role: "staff" });
    let approvedActive = true;
    const { report } = handlers({ now: () => time++,
      authorize: async () => ({ ...actor(), approvedActive }) });
    const results = await Promise.all(Array.from({ length: 3 }, () => invoke(report, { days: 7 })));
    for (const result of results) {
      expect(result.statusCode).toBe(200);
      expect(result.body).toEqual(results[0].body);
    }
    const signIns = result => result.body.history.actions.find(row => row.id === "auth.login").count;
    expect(signIns(results[0])).toBe(0);
    await firestore.collection("admin_logs").add({ actorUid: "person", action: "auth.login", timestamp: Timestamp.fromMillis(start) });
    time = start + 59_999;
    expect((await invoke(report, { days: 7 })).body).toEqual(results[0].body);
    expect(signIns(await invoke(report, { days: 30 }))).toBe(1);
    time = start + 60_010;
    const refreshed = await invoke(report, { days: 7 });
    expect(signIns(refreshed)).toBe(1);
    expect(refreshed.body.generatedAt).not.toBe(results[0].body.generatedAt);
    approvedActive = false;
    expect((await invoke(report, { days: 7 })).statusCode).toBe(403);
  });

  it.each([null, "2026-11-02T12:00:00.000Z", 1793620800000])("refuses null and non-native audit timestamps (%#)", async timestamp => {
    await firestore.collection("users").doc("person").set({ role: "staff" });
    await firestore.collection("admin_logs").add({ actorUid: "person", action: "auth.login", timestamp });
    const res = await invoke(handlers().report, { days: 7 });
    expect(res.body.history).toMatchObject({ status: "unavailable", actions: [] });
  });
});
