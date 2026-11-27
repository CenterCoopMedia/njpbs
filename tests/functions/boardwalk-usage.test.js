import { createHash, randomUUID } from "node:crypto";
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
    // Day, week and person markers, screen and action person-days, and one publish repeat marker.
    const markers = await firestore.collection("cmsUsagePresence").get();
    expect(markers.docs.map(row => row.id.split("_")[0]).sort()).toEqual(["action", "day", "person", "repeat", "screen", "week"]);
    for (const row of markers.docs) {
      expect(row.data().purgeAt).toEqual(raw.purgeAt);
      expect(Object.keys(row.data()).every(key => ["purgeAt", "lastAt", "screens", "lastDay", "group", "role", "repeated", "grouped"].includes(key))).toBe(true);
      expect(`${row.id} ${JSON.stringify(row.data())}`).not.toMatch(/staff-1|post-123/);
    }
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
    expect(result.body.daily.at(-1)).toEqual({ date: "2026-11-02", timezone: "America/New_York", activeUsers: 2, newsroom: 2, product: 0 });
    expect(result.body.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 2, newsroom: 2, product: 0, byRole: [{ role: "none", activeUsers: 2 }] }]);
    expect(result.body.screens.find(row => row.id === "posts-list").views).toBe(3);
    time += 86_400_000;
    await invoke(collect, batch());
    result = await invoke(report, { days: 7 });
    expect(result.body.daily.at(-1).activeUsers).toBe(1);
    expect(result.body.weekly[0].activeUsers).toBe(2);
    time += 6 * 86_400_000;
    await invoke(collect, batch());
    expect((await invoke(report, { days: 7 })).body.weekly).toEqual([{ week: "2026-11-09", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0, byRole: [{ role: "none", activeUsers: 1 }] }]);
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
    expect(result.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 2, newsroom: 2, product: 0, byRole: [{ role: "none", activeUsers: 2 }] }]);
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
    expect(result.daily.find(row => row.date === "2026-11-02")).toEqual({ date: "2026-11-02", timezone: "UTC", activeUsers: 0, newsroom: null, product: null });
    // The switch date keeps its stored UTC row; staff-1 is counted again on the Eastern row.
    expect(result.daily.filter(row => row.date === "2026-11-03")).toEqual([{ date: "2026-11-03", timezone: "UTC", activeUsers: 1, newsroom: null, product: null },
      { date: "2026-11-03", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0 }]);
    expect(result.weekly.slice(-2)).toEqual([{ week: "2026-10-26", timezone: "UTC", activeUsers: 4, newsroom: null, product: null, byRole: [] },
      { week: "2026-11-02", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0, byRole: [{ role: "none", activeUsers: 1 }] }]);
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
    // Tabs opened before the split still send the combined ids; they count on the combined rows.
    expect((await invoke(handlers().collect, batch([{ name: "screen.view", screen: "posts" }]))).statusCode).toBe(200);
    expect((await invoke(handlers({ now: () => time + 120_000 }).report, { days: 7 })).body.screens.find(row => row.id === "posts").views).toBe(1);
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

  it("splits newsroom and product team counts by group and role", async () => {
    await firestore.collection("users").doc("staff-1").set({ accessTier: "editor" });
    await firestore.collection("users").doc("owner-1").set({ accessTier: "owner" });
    await firestore.collection("users").doc("idle-1").set({ accessTier: "editor" });
    await firestore.collection("users").doc("agent-1").set({ accessTier: "editor", usageAnalyticsExcluded: true });
    const events = [view, { name: "screen.duration", screen: "posts-list", durationMs: 60_000 }];
    await invoke(handlers().collect, batch(events));
    await invoke(handlers({ authorize: async () => actor("owner-1") }).collect, batch(events));
    const result = (await invoke(handlers().report, { days: 7 })).body;
    expect(result.daily.at(-1)).toMatchObject({ activeUsers: 2, newsroom: 1, product: 1 });
    expect(result.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 2, newsroom: 1, product: 1,
      byRole: [{ role: "editor", activeUsers: 1 }, { role: "owner", activeUsers: 1 }] }]);
    expect(result.weekCompare).toEqual({ thisWeek: { newsroom: 1, product: 1 }, lastWeek: { newsroom: null, product: null } });
    expect(result.activePeople).toEqual({ status: "ready", newsroom: 1, product: 1 });
    expect(result.sessions).toEqual({ newsroom: { sessions: 1, visibleMs: 60_000 }, product: { sessions: 1, visibleMs: 60_000 } });
    expect(result.roleActivity).toEqual({ status: "ready", rows: [
      { role: "editor", group: "newsroom", roster: 2, active: 1, sessions: 1, visibleMs: 60_000 },
      { role: "owner", group: "product", roster: 1, active: 1, sessions: 1, visibleMs: 60_000 }] });
    expect(result.excludedAccounts).toBe(1);
    expect(result.screens[0]).toMatchObject({ id: "posts-list", views: 2, visibleMs: 120_000, personDays: 2,
      newsroom: { views: 1, visibleMs: 60_000, personDays: 1 }, product: { views: 1, visibleMs: 60_000, personDays: 1 } });
  });

  it("counts a person once per screen and action per Eastern day", async () => {
    const { collect, report } = handlers();
    const publish = { name: "content.publish.request", screen: "posts-editor", objectType: "record", objectId: "post-1" };
    await invoke(collect, batch([view, publish]));
    await invoke(collect, batch([view, { name: "screen.duration", screen: "posts-list", durationMs: 1_000 }, publish]));
    await invoke(handlers({ authorize: async () => actor("staff-2") }).collect, batch([view]));
    time += 86_400_000;
    await invoke(collect, batch([view]));
    const result = (await invoke(report, { days: 7 })).body;
    expect(result.screens.find(row => row.id === "posts-list")).toMatchObject({ views: 4, personDays: 3, newsroom: { personDays: 3 } });
    expect(result.screens.find(row => row.id === "posts-editor")).toMatchObject({ views: 0, personDays: 0 });
    expect(result.actions.find(row => row.id === "content.publish.request")).toMatchObject({ count: 2, personDays: 1, lastUsed: "2026-11-02" });
    expect(result.actions.find(row => row.id === "search")).toMatchObject({ count: 0, personDays: 0, lastUsed: null });
  });

  it("starts a new session after a 30-minute gap between event times", async () => {
    const { collect, report } = handlers();
    await invoke(collect, batch());
    time = start + 29 * 60_000;
    await invoke(collect, batch());
    time = start + 59 * 60_000;
    await invoke(collect, batch());
    // Sent at 100 minutes; the first event happened 10 minutes earlier, 31 minutes after the last one.
    time = start + 100 * 60_000;
    await invoke(collect, batch([{ ...view, offsetMs: 600_000 }, view]));
    expect((await invoke(report, { days: 7 })).body.sessions.newsroom.sessions).toBe(3);
  });

  it("buckets visible time by the Eastern hour of the event, not of collection", async () => {
    time = Date.parse("2026-11-02T15:00:30Z"); // Monday 10:00:30 AM EST
    await invoke(handlers().collect, batch([{ name: "screen.duration", screen: "posts-list", durationMs: 5_000, offsetMs: 60_000 },
      { name: "screen.duration", screen: "posts-list", durationMs: 2_000 }]));
    const grid = (await invoke(handlers().report, { days: 7 })).body.hourMs.newsroom;
    expect(grid[0][9]).toBe(5_000);
    expect(grid[0][10]).toBe(2_000);
    expect(grid.flat().reduce((sum, value) => sum + value, 0)).toBe(7_000);
  });

  it("counts screen transitions and back-and-forth pairs across batches", async () => {
    const at = screen => ({ name: "screen.view", screen });
    const { collect, report } = handlers();
    await invoke(collect, batch([at("posts-list"), at("posts-editor"), at("posts-list"), at("posts-list"), at("images"), at("posts-list")]));
    await invoke(collect, batch([at("images")]));
    const friction = (await invoke(report, { days: 7 })).body.friction.current.newsroom;
    expect(friction).toMatchObject({ transitions: 5, backForth: 3 });
    expect(friction.pairs).toEqual([{ screens: ["Images", "Posts list"], count: 2 }, { screens: ["Post editor", "Posts list"], count: 1 }]);
  });

  it("counts repeat publish clicks within 10 minutes per item and keeps the prior period", async () => {
    await firestore.collection("cmsUsageDaily").doc("et-2026-10-26").set({ groups: { newsroom: { repeat: { publish: { items: 4, repeats: 1, repeatedItems: 1 } } } } });
    const publish = objectId => ({ name: "content.publish.request", screen: "posts-editor", objectType: "record", objectId });
    const { collect, report } = handlers();
    for (const [minute, events] of [[0, [publish("post-1")]], [5, [publish("post-1")]], [9, [publish("post-1")]],
      [25, [publish("post-1")]], [30, [publish("post-2"), { name: "preview.request", screen: "posts-editor", objectType: "record", objectId: "post-1" }]]]) {
      time = start + minute * 60_000;
      await invoke(collect, batch(events));
    }
    const body = (await invoke(report, { days: 7 })).body;
    expect(body.friction.current.newsroom.publish).toEqual({ items: 2, repeats: 2, repeatedItems: 1 });
    expect(body.friction.current.newsroom.preview).toEqual({ items: 1, repeats: 0, repeatedItems: 0 });
    expect(body.friction.prior.newsroom.publish).toEqual({ items: 4, repeats: 1, repeatedItems: 1 });
    expect(JSON.stringify(body)).not.toMatch(/staff-1|post-1|post-2|"(?:objectId|uid|lastAt)"/);
  });

  it("summarizes problem reports and content flow without IDs or text", async () => {
    await firestore.collection("users").doc("staff-1").set({ accessTier: "editor" });
    const reports = firestore.collection("bug_reports");
    await reports.add({ status: "open", createdAt: "2026-10-31T12:00:00.000Z", resolvedAt: null, route: { path: "/content/post/AbC123xyz" }, summary: "private words" });
    await reports.add({ status: "acknowledged", createdAt: "2026-11-01T12:00:00.000Z", resolvedAt: null, route: { path: "/content/post/abc-def" } });
    await reports.add({ status: "resolved", createdAt: "2026-10-20T12:00:00.000Z", resolvedAt: "2026-10-28T12:00:00.000Z", route: { path: "/media" } });
    await reports.add({ status: "resolved", createdAt: "2026-10-29T00:00:00.000Z", resolvedAt: "2026-10-30T00:00:00.000Z", route: { path: "/reports" } });
    await reports.add({ status: "dismissed", createdAt: "2026-10-30T00:00:00.000Z", resolvedAt: null, route: null });
    await reports.add({ status: "resolved", createdAt: "2026-09-01T00:00:00.000Z", resolvedAt: "2026-10-01T00:00:00.000Z", route: { path: "/media" } });
    const posts = firestore.collection("cmsPosts");
    await posts.add({ type: "post", status: "published", title: "Private title", createdAt: "2026-10-28T10:00:00.000Z", firstPublishedAt: "2026-10-28T13:00:00.000Z", firstPublishedBy: "staff-1" });
    await posts.add({ type: "post", status: "published", createdAt: "2026-11-01T10:00:00.000Z", firstPublishedAt: "2026-11-02T11:00:00.000Z", firstPublishedBy: "agent-x" });
    await posts.add({ type: "program", status: "published", createdAt: "2026-10-28T10:00:00.000Z", firstPublishedAt: "2026-10-28T11:00:00.000Z", firstPublishedBy: "staff-1" });
    await posts.add({ type: "post", status: "draft", createdAt: new Date(start - 2 * 3_600_000).toISOString(), createdBy: "agent-x" });
    await posts.add({ type: "post", status: "draft", createdAt: "2026-10-20T12:00:00.000Z", createdBy: "staff-1" });
    await posts.add({ type: "post", status: "draft", createdAt: "2026-10-20T12:00:00.000Z", createdBy: "staff-1", deleted: true });
    const body = (await invoke(handlers().report, { days: 7 })).body;
    expect(body.problemReports).toEqual({ status: "ready", open: 2, resolved: 2, medianDaysToResolve: 4.5, filed: 4,
      topPages: [{ page: "/content/post", count: 2 }, { page: "/reports", count: 1 }, { page: "Not from a Boardwalk page", count: 1 }] });
    expect(body.contentFlow).toEqual({ status: "ready", teams: "ready", medianHoursToFirstPublish: 14,
      publishedWeeks: [{ week: "2026-10-26", total: 1, newsroom: 1, product: 0, other: 0 }, { week: "2026-11-02", total: 1, newsroom: 0, product: 0, other: 1 }],
      openDrafts: [{ bucket: "day", total: 1, newsroom: 0, product: 0, other: 1 }, { bucket: "week", total: 0, newsroom: 0, product: 0, other: 0 },
        { bucket: "month", total: 1, newsroom: 1, product: 0, other: 0 }, { bucket: "older", total: 0, newsroom: 0, product: 0, other: 0 }] });
    expect(JSON.stringify(body)).not.toMatch(/AbC123|abc-def|private|Private|staff-1|agent-x/);
  });

  it("counts people for teams and roles once when their day and week markers predate team counts", async () => {
    const person = createHash("sha256").update("staff-1").digest("hex");
    const presence = firestore.collection("cmsUsagePresence");
    await presence.doc(`day_et-2026-11-02_${person}`).set({ purgeAt: Timestamp.fromMillis(start) });
    await presence.doc(`week_et-2026-11-02_${person}`).set({ purgeAt: Timestamp.fromMillis(start) });
    await firestore.collection("cmsUsageDaily").doc("et-2026-11-02").set({ activeUsers: 1 });
    await firestore.collection("cmsUsageWeekly").doc("et-2026-11-02").set({ activeUsers: 1 });
    const { collect, report } = handlers();
    await invoke(collect, batch());
    await invoke(collect, batch());
    const body = (await invoke(report, { days: 7 })).body;
    expect(body.daily.at(-1)).toEqual({ date: "2026-11-02", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0 });
    expect(body.weekly).toEqual([{ week: "2026-11-02", timezone: "America/New_York", activeUsers: 1, newsroom: 1, product: 0, byRole: [{ role: "none", activeUsers: 1 }] }]);
    expect(body.activePeople).toEqual({ status: "ready", newsroom: 1, product: 0 });
    expect((await presence.doc(`week_et-2026-11-02_${person}`).get()).data().grouped).toBe(true);
  });

  it("puts visible time in the hour and weekday of the event when its batch arrives after midnight", async () => {
    time = Date.parse("2026-11-03T05:00:30Z"); // Tuesday 12:00:30 AM EST
    await invoke(handlers().collect, batch([{ name: "screen.duration", screen: "posts-list", durationMs: 4_000, offsetMs: 60_000 },
      { name: "screen.duration", screen: "posts-list", durationMs: 1_000 }]));
    const grid = (await invoke(handlers().report, { days: 7 })).body.hourMs.newsroom;
    expect(grid[0][23]).toBe(4_000); // Monday 11 PM
    expect(grid[1][0]).toBe(1_000); // Tuesday midnight
    expect(grid.flat().reduce((sum, value) => sum + value, 0)).toBe(5_000);
  });

  it("counts Preview jobs only within their 30-day retention and reports the coverage", async () => {
    await firestore.collection("users").doc("staff-1").set({ accessTier: "editor" });
    const queue = firestore.collection("cmsPreviewQueue");
    await queue.add({ requestedBy: "staff-1", status: "failed", requestedAt: Timestamp.fromMillis(start - 10 * 86_400_000) });
    await queue.add({ requestedBy: "staff-1", status: "ready", requestedAt: Timestamp.fromMillis(start - 5 * 86_400_000) });
    await queue.add({ requestedBy: "staff-1", status: "failed", requestedAt: Timestamp.fromMillis(start - 40 * 86_400_000) });
    const jobs = async days => (await invoke(handlers().report, { days })).body.friction.jobs;
    const ninety = await jobs(90);
    expect(ninety.previewCoverage).toEqual({ current: { status: "partial", from: "2026-10-03" }, prior: { status: "unavailable" } });
    expect(ninety.current.newsroom).toMatchObject({ previews: 2, failed: 1 });
    const thirty = await jobs(30);
    expect(thirty.previewCoverage).toEqual({ current: { status: "full" }, prior: { status: "partial", from: "2026-10-03" } });
    // The 40-day-old job is in the prior window but outside retention, so it is not counted.
    expect(thirty.prior.newsroom).toMatchObject({ previews: 0, failed: 0 });
    expect((await jobs(7)).previewCoverage).toEqual({ current: { status: "full" }, prior: { status: "full" } });
  });

  it("keeps content totals and the median but no team split when the roster is unavailable", async () => {
    for (let offset = 0; offset < 501; offset += 250) {
      const write = firestore.batch();
      for (let index = offset; index < Math.min(501, offset + 250); index += 1) write.set(firestore.collection("users").doc(`user-${index}`), { accessTier: "editor" });
      await write.commit();
    }
    const posts = firestore.collection("cmsPosts");
    await posts.add({ type: "post", status: "published", createdAt: "2026-10-28T10:00:00.000Z", firstPublishedAt: "2026-10-28T13:00:00.000Z", firstPublishedBy: "user-1" });
    await posts.add({ type: "post", status: "draft", createdAt: "2026-10-20T12:00:00.000Z", createdBy: "user-1" });
    const body = (await invoke(handlers().report, { days: 7 })).body;
    expect(body.contentFlow).toEqual({ status: "ready", teams: "unavailable", medianHoursToFirstPublish: 3,
      publishedWeeks: [{ week: "2026-10-26", total: 1, newsroom: null, product: null, other: null }],
      openDrafts: [{ bucket: "day", total: 0, newsroom: null, product: null, other: null }, { bucket: "week", total: 0, newsroom: null, product: null, other: null },
        { bucket: "month", total: 1, newsroom: null, product: null, other: null }, { bucket: "older", total: 0, newsroom: null, product: null, other: null }] });
  });

  it.each([null, "2026-11-02T12:00:00.000Z", 1793620800000])("refuses null and non-native audit timestamps (%#)", async timestamp => {
    await firestore.collection("users").doc("person").set({ role: "staff" });
    await firestore.collection("admin_logs").add({ actorUid: "person", action: "auth.login", timestamp });
    const res = await invoke(handlers().report, { days: 7 });
    expect(res.body.history).toMatchObject({ status: "unavailable", actions: [] });
  });
});
