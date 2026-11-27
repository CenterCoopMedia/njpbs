"use strict";

const { createHash } = require("node:crypto");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { hasCapability } = require("./lib/rbac");
const config = require("./lib/boardwalk-usage-config.json");
const HISTORY_ACTIONS = {
  "auth.login": "Accepted sign-ins",
  "cms.publish": "Publish requests (all content)",
  "cms.preview.request": "Preview jobs requested",
  "media.upload": "Media items added (includes approved submissions)",
  "bug_report.create": "Problem reports filed",
};

const DAY_MS = 86_400_000;
const RETENTION_MS = 180 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const own = (object, key) => Object.hasOwn(object, key);
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const hash = value => createHash("sha256").update(value).digest("hex");
const TIMEZONE = "America/New_York";
// Day and week keys are newsroom (Eastern) calendar dates, so evening work stays on its own day.
const easternDate = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const easternOffset = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "longOffset" });
const dayOf = ms => easternDate.format(ms);
const calendarDay = ms => new Date(ms).toISOString().slice(0, 10);
const shiftDay = (day, days) => calendarDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
const mondayOf = day => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
// Eastern aggregates and presence markers use their own keys; earlier UTC-keyed rows stay as stored.
const EASTERN_PREFIX = "et-";

// Eastern midnight as an instant. 05:00 UTC is before the 2 AM local DST switch, so its offset is midnight's.
function easternMidnight(day) {
  const offset = easternOffset.formatToParts(Date.parse(`${day}T05:00:00Z`)).find(part => part.type === "timeZoneName").value;
  return new Date(`${day}T00:00:00${offset.slice(3) || "Z"}`).toISOString();
}

function validEvent(event) {
  if (!only(event, ["name", "screen", "durationMs", "objectType", "objectId", "offsetMs"]) ||
      typeof event.name !== "string" || typeof event.screen !== "string" ||
      !own(config.screens, event.screen)) return false;
  // offsetMs: milliseconds between the event and its batch being sent (optional).
  if (own(event, "offsetMs") && !(Number.isInteger(event.offsetMs) && event.offsetMs >= 0 && event.offsetMs <= 600_000)) return false;
  const size = Object.keys(event).length - (own(event, "offsetMs") ? 1 : 0);
  if (event.name === "screen.view") return size === 2;
  if (event.name === "screen.duration") return size === 3 &&
    Number.isInteger(event.durationMs) && event.durationMs > 0 && event.durationMs <= 60_000;
  if (!own(config.actions, event.name) || own(event, "durationMs")) return false;
  // An action names its object only when it has one; both fields or neither.
  if (size === 2) return true;
  return size === 4 && ["page", "record"].includes(event.objectType) &&
    typeof event.objectId === "string" && ID.test(event.objectId);
}

async function collectBatch(firestore, actor, body, now) {
  const day = `${EASTERN_PREFIX}${dayOf(now)}`;
  const week = `${EASTERN_PREFIX}${mondayOf(dayOf(now))}`;
  const raw = firestore.collection("cmsUsageEvents").doc(hash(`${actor.uid}:${body.batchId}`));
  const presence = firestore.collection("cmsUsagePresence");
  const dayPerson = presence.doc(`day_${day}_${hash(actor.uid)}`);
  const weekPerson = presence.doc(`week_${week}_${hash(actor.uid)}`);
  const purgeAt = Timestamp.fromMillis(now + RETENTION_MS);
  await firestore.runTransaction(async tx => {
    const [existing, dailyPresence, weeklyPresence] = await tx.getAll(raw, dayPerson, weekPerson);
    if (existing.exists) return;
    const views = {};
    const visibleMs = {};
    const actions = {};
    for (const event of body.events) {
      const target = event.name === "screen.view" ? views : event.name === "screen.duration" ? visibleMs : actions;
      const key = own(config.actions, event.name) ? event.name : event.screen;
      target[key] = (target[key] ?? 0) + (event.durationMs ?? 1);
    }
    const increments = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, FieldValue.increment(value)]));
    tx.create(raw, { uid: actor.uid, roles: [...new Set(actor.principal.grants.map(grant => grant.role))],
      collectedAt: Timestamp.fromMillis(now), purgeAt, events: body.events });
    const totals = { activeUsers: FieldValue.increment(dailyPresence.exists ? 0 : 1) };
    for (const [field, counts] of Object.entries({ views, visibleMs, actions })) {
      if (Object.keys(counts).length) totals[field] = increments(counts);
    }
    tx.set(firestore.collection("cmsUsageDaily").doc(day), totals, { merge: true });
    if (!dailyPresence.exists) tx.create(dayPerson, { purgeAt });
    if (!weeklyPresence.exists) {
      tx.create(weekPerson, { purgeAt });
      tx.set(firestore.collection("cmsUsageWeekly").doc(week), { activeUsers: FieldValue.increment(1) }, { merge: true });
    }
  });
}

async function readReport(firestore, days, now) {
  const today = dayOf(now);
  const dates = Array.from({ length: days }, (_, index) => shiftDay(today, index - days + 1));
  // Include calendar weeks that start within the chosen window; the current week is partial.
  const weeks = dates.filter(value => mondayOf(value) === value);
  const daily = firestore.collection("cmsUsageDaily");
  const weekly = firestore.collection("cmsUsageWeekly");
  const both = keys => keys.flatMap(key => [key, `${EASTERN_PREFIX}${key}`]);
  const [dailyRows, weeklyRows, first, firstEastern, history] = await Promise.all([
    firestore.getAll(...both(dates).map(key => daily.doc(key))),
    firestore.getAll(...both(weeks).map(key => weekly.doc(key))),
    daily.orderBy("__name__").limit(1).get(),
    daily.where("__name__", ">=", daily.doc(EASTERN_PREFIX)).orderBy("__name__").limit(1).get(),
    readActivityHistory(firestore, easternMidnight(dates[0]), new Date(now).toISOString()),
  ]);
  const easternFromDate = firstEastern.docs[0]?.id.startsWith(EASTERN_PREFIX) ? firstEastern.docs[0].id.slice(EASTERN_PREFIX.length) : null;
  const screens = Object.entries({ ...config.screens, ...config.earlierScreens }).map(([id, label]) => ({ id, label, views: 0, visibleMs: 0 }));
  const actions = Object.entries(config.actions).map(([id, label]) => ({ id, label, count: 0 }));
  // Project known numeric fields explicitly: stored raw or person data cannot enter this response.
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  // Each event is in exactly one UTC or Eastern row, so totals add both.
  for (const row of dailyRows) {
    const data = row.data() ?? {};
    for (const screen of screens) {
      screen.views += count(data.views?.[screen.id]);
      screen.visibleMs += count(data.visibleMs?.[screen.id]);
    }
    for (const action of actions) action.count += count(data.actions?.[action.id]);
  }
  // Distinct people cannot be added across conventions, so a key can have a UTC row and an Eastern row.
  // UTC rows appear before the switch and wherever a UTC row is stored; Eastern rows from the switch on.
  const people = (rows, keys, eastern) => keys.flatMap((key, index) => {
    const [utc, et] = [rows[index * 2], rows[index * 2 + 1]];
    return [
      ...(!eastern(key) || utc.exists ? [{ key, timezone: "UTC", activeUsers: count(utc.data()?.activeUsers) }] : []),
      ...(eastern(key) ? [{ key, timezone: TIMEZONE, activeUsers: count(et.data()?.activeUsers) }] : []),
    ];
  });
  const switched = value => easternFromDate !== null && value >= easternFromDate;
  return { days, analyticsEnabled: config.analyticsEnabled, generatedAt: new Date(now).toISOString(),
    firstCollectedDate: first.docs[0]?.id.replace(EASTERN_PREFIX, "") ?? null, easternFromDate, timezone: TIMEZONE,
    daily: people(dailyRows, dates, switched).map(({ key, ...row }) => ({ date: key, ...row })),
    weekly: people(weeklyRows, weeks, value => easternFromDate !== null && value >= mondayOf(easternFromDate))
      .map(({ key, ...row }) => ({ week: key, ...row })),
    history,
    // Earlier combined destinations appear only in windows that include their stored counts.
    screens: screens.filter(row => !own(config.earlierScreens, row.id) || row.views || row.visibleMs).sort((a, b) => b.views - a.views || a.label.localeCompare(b.label)),
    actions: actions.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)) };
}

async function readActivityHistory(firestore, start, end) {
  try {
    return await firestore.runTransaction(async tx => {
      const count = async query => {
        const value = (await tx.get(query.count())).data().count;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Incomplete activity count");
        return value;
      };
      const [users, total, dated] = await Promise.all([
        tx.get(firestore.collection("users").select("role", "accessTier", "grants", "usageAnalyticsExcluded").limit(501)),
        count(firestore.collection("admin_logs")),
        count(firestore.collection("admin_logs")
          .where("timestamp", ">=", Timestamp.fromDate(new Date("0001-01-01T00:00:00.000Z")))
          .where("timestamp", "<=", Timestamp.fromDate(new Date("9999-12-31T23:59:59.999Z")))),
      ]);
      if (users.size > 500 || total !== dated) throw new Error("Incomplete activity coverage");
      const staffIds = users.docs.filter(row => {
        const profile = row.data();
        return profile.usageAnalyticsExcluded !== true && !row.id.startsWith("system:") &&
          (["staff", "contributor", "editor", "admin", "super_admin"].includes(profile.role) ||
            ["viewer", "contributor", "editor", "publisher", "admin", "owner"].includes(profile.accessTier) ||
            (Array.isArray(profile.grants) && profile.grants.some(grant => ["staff", "contributor", "editor", "admin", "super_admin"].includes(grant?.role))));
      }).map(row => row.id);
      const groups = [];
      for (let index = 0; index < staffIds.length; index += 30) groups.push(staffIds.slice(index, index + 30));
      // Native count queries never hydrate audit before/after, messages, IPs or identities.
      const actions = await Promise.all(Object.entries(HISTORY_ACTIONS).map(async ([id, label]) => {
        const counts = await Promise.all(groups.map(ids => count(firestore.collection("admin_logs")
          .where("actorUid", "in", ids).where("action", "==", id)
          .where("timestamp", ">=", Timestamp.fromDate(new Date(start)))
          .where("timestamp", "<=", Timestamp.fromDate(new Date(end))))));
        return { id, label, count: counts.reduce((sum, value) => sum + value, 0) };
      }));
      return { status: "ready", start, end, actions };
    }, { readOnly: true });
  } catch {
    // A missing index, timestamp or roster cannot be represented as zero staff activity.
    return { status: "unavailable", start, end, actions: [] };
  }
}

function createBoardwalkUsageHandlers({ firestore = db, authorize = requirePrincipal,
  appCheck = verifyAppCheckToken, now = Date.now, analyticsEnabled = () => config.analyticsEnabled } = {}) {
  const reports = new Map();
  const boundary = action => async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      await appCheck(req.headers?.["x-firebase-appcheck"]);
      const actor = await authorize(req, { includeAccountStatus: true });
      if (actor.approvedActive !== true || !hasCapability(actor.principal, "reports.view")) {
        return res.status(403).json({ error: "Staff Reports access is required." });
      }
      return await action(req, res, actor);
    } catch (error) {
      const status = [401, 403].includes(error?.status) ? error.status : 503;
      return res.status(status).json({ error: status === 503 ? "Boardwalk usage is unavailable." : "Staff session required." });
    }
  };
  return {
    collect: boundary(async (req, res, actor) => {
      if (!analyticsEnabled()) return res.status(200).json({ collected: false });
      const body = req.body;
      if (!only(body, ["batchId", "events"]) || typeof body.batchId !== "string" || !UUID.test(body.batchId) ||
          !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 20 || !body.events.every(validEvent)) {
        return res.status(400).json({ error: "Invalid usage events." });
      }
      const profile = await firestore.collection("users").doc(actor.uid).get();
      if (profile.data()?.usageAnalyticsExcluded === true) return res.status(200).json({ collected: false });
      await collectBatch(firestore, actor, body, now());
      return res.status(200).json({ collected: true });
    }),
    report: boundary(async (req, res) => {
      if (!only(req.body, ["days"]) || ![7, 30, 90].includes(req.body.days)) {
        return res.status(400).json({ error: "Choose 7, 30 or 90 days." });
      }
      const days = req.body.days;
      let entry = reports.get(days);
      if (!entry || entry.expires <= now()) {
        // Three admitted windows bound memory. Share pending reads as well as
        // results; each request still passes fresh authorization above.
        entry = { expires: Infinity };
        entry.promise = readReport(firestore, days, now()).then(result => {
          entry.expires = now() + 60_000;
          return result;
        }, error => {
          reports.delete(days);
          throw error;
        });
        reports.set(days, entry);
      }
      return res.status(200).json(await entry.promise);
    }),
  };
}

const handlers = createBoardwalkUsageHandlers();
const options = { region: "us-central1", cors: true, memory: "256MiB", maxInstances: 5 };
exports.cmsCollectBoardwalkUsage = cmsOnRequest(options, handlers.collect);
exports.cmsGetBoardwalkUsage = cmsOnRequest(options, handlers.report);
exports.createBoardwalkUsageHandlers = createBoardwalkUsageHandlers;
