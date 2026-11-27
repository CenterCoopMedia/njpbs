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
const easternHour = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hourCycle: "h23" });
// Owner-tier accounts are the product team; every other account counts as newsroom.
const GROUPS = ["newsroom", "product"];
const ROLE = /^[a-z_]{1,32}$/;
const groupOf = profile => profile?.accessTier === "owner" ? "product" : "newsroom";
const roleOf = profile => typeof profile?.accessTier === "string" && ROLE.test(profile.accessTier) ? profile.accessTier : "none";
const SESSION_GAP_MS = 30 * 60_000;
const REPEAT_MS = 10 * 60_000;
const REPEAT_ACTIONS = { "content.publish.request": "publish", "preview.request": "preview" };
const PREVIEW_RETENTION_MS = 30 * DAY_MS;
const OPEN_REPORT_STATUSES = ["open", "acknowledged", "in_progress", "blocked"];
// Open draft age buckets in days: under 1, under 7, under 30, then older.
const DRAFT_AGES = [["day", 1], ["week", 7], ["month", 30], ["older", Infinity]];

// Eastern midnight as an instant. 05:00 UTC is before the 2 AM local DST switch, so its offset is midnight's.
function easternMidnight(day) {
  const offset = easternOffset.formatToParts(Date.parse(`${day}T05:00:00Z`)).find(part => part.type === "timeZoneName").value;
  return new Date(`${day}T00:00:00${offset.slice(3) || "Z"}`).toISOString();
}

// offsetMs: milliseconds between the event and its batch being sent (optional).
const validOffset = event => !own(event, "offsetMs") ||
  (Number.isInteger(event.offsetMs) && event.offsetMs >= 0 && event.offsetMs <= 600_000);

function validEvent(event) {
  if (!only(event, ["name", "screen", "durationMs", "objectType", "objectId", "offsetMs"]) ||
      typeof event.name !== "string" || typeof event.screen !== "string" ||
      !(own(config.screens, event.screen) || own(config.earlierScreens, event.screen))) return false;
  if (!validOffset(event)) return false;
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

async function collectBatch(firestore, actor, profile, body, now) {
  const today = dayOf(now);
  const day = `${EASTERN_PREFIX}${today}`;
  const week = `${EASTERN_PREFIX}${mondayOf(today)}`;
  const person = hash(actor.uid);
  const group = groupOf(profile);
  const role = roleOf(profile);
  const raw = firestore.collection("cmsUsageEvents").doc(hash(`${actor.uid}:${body.batchId}`));
  const presence = firestore.collection("cmsUsagePresence");
  const dayPerson = presence.doc(`day_${day}_${person}`);
  const weekPerson = presence.doc(`week_${week}_${person}`);
  const purgeAt = Timestamp.fromMillis(now + RETENTION_MS);
  // Event time is collection time minus offsetMs; process the batch in event order.
  const events = body.events.map(event => ({ event, at: now - (event.offsetMs ?? 0) })).sort((a, b) => a.at - b.at);
  // Distinct person-day markers for screens and actions, and per-item repeat markers for publish and Preview.
  const markerIds = new Set();
  for (const item of events) {
    const { event } = item;
    if (own(config.actions, event.name)) {
      item.marker = `action_${day}_${event.name}_${person}`;
      if (own(REPEAT_ACTIONS, event.name) && event.objectId) {
        item.repeat = `repeat_${day}_${hash(`${actor.uid}:${event.name}:${event.objectType}:${event.objectId}`)}`;
        markerIds.add(item.repeat);
      }
    } else item.marker = `screen_${day}_${event.screen}_${person}`;
    markerIds.add(item.marker);
  }
  const ids = [...markerIds];
  await firestore.runTransaction(async tx => {
    const [existing, dailyPresence, weeklyPresence, ...found] = await tx.getAll(raw, dayPerson, weekPerson, ...ids.map(id => presence.doc(id)));
    if (existing.exists) return;
    const markers = new Map(ids.map((id, index) => [id, found[index].exists ? found[index].data() : null]));
    const created = new Set();
    const counts = {};
    // Hour counters belong to the Eastern date of the event, which can be before the collection date.
    const eventDays = new Map();
    const bump = (path, value = 1, tree = counts) => {
      let node = tree;
      for (const key of path.slice(0, -1)) node = node[key] ??= {};
      node[path.at(-1)] = (node[path.at(-1)] ?? 0) + value;
    };
    const mine = ["groups", group];
    const previous = dailyPresence.data() ?? {};
    const lastAt = Number.isFinite(previous.lastAt) ? previous.lastAt : null;
    let recent = Array.isArray(previous.screens) ? previous.screens.filter(screen => own(config.screens, screen)).slice(-2) : [];
    // A day marker without lastAt was written before team and role counts; count this person for them once.
    const teamCounted = dailyPresence.exists && lastAt !== null;
    if (!teamCounted) { bump([...mine, "activeUsers"]); bump(["roles", role, "activeUsers"]); }
    // A batch starts a new session on a person's first batch of the day or 30 minutes after their last event.
    if (lastAt === null || events[0].at - lastAt >= SESSION_GAP_MS) { bump([...mine, "sessions"]); bump(["roles", role, "sessions"]); }
    for (const item of events) {
      const { event, at } = item;
      if (event.name === "screen.view") {
        bump(["views", event.screen]); bump([...mine, "views", event.screen]);
        const last = recent.at(-1);
        // A view of the screen already open is not navigation.
        if (last && last !== event.screen) {
          bump([...mine, "transitions"]);
          if (recent.length === 2 && recent[0] === event.screen) {
            bump([...mine, "backForth"]);
            bump([...mine, "pairs", [event.screen, last].sort().join("~")]);
          }
        }
        if (last !== event.screen) recent = [...recent, event.screen].slice(-2);
      } else if (event.name === "screen.duration") {
        bump(["visibleMs", event.screen], event.durationMs); bump([...mine, "visibleMs", event.screen], event.durationMs);
        const eventDay = `${EASTERN_PREFIX}${dayOf(at)}`;
        if (eventDay !== day && !eventDays.has(eventDay)) eventDays.set(eventDay, {});
        bump([...mine, "hourMs", easternHour.format(at)], event.durationMs, eventDay === day ? counts : eventDays.get(eventDay));
        bump(["roles", role, "visibleMs"], event.durationMs);
      } else {
        bump(["actions", event.name]); bump([...mine, "actions", event.name]);
      }
      if (markers.get(item.marker) === null) {
        markers.set(item.marker, {});
        created.add(item.marker);
        if (own(config.actions, event.name)) bump([...mine, "actionDays", event.name]);
        else bump([...mine, "screenDays", event.screen]);
      }
      if (item.repeat) {
        const kind = REPEAT_ACTIONS[event.name];
        const state = markers.get(item.repeat);
        if (!state) {
          bump([...mine, "repeat", kind, "items"]);
          markers.set(item.repeat, { lastAt: at, repeated: false });
        } else {
          if (at - state.lastAt <= REPEAT_MS) {
            bump([...mine, "repeat", kind, "repeats"]);
            if (!state.repeated) bump([...mine, "repeat", kind, "repeatedItems"]);
            state.repeated = true;
          }
          state.lastAt = at;
        }
      }
    }
    const increments = node => Object.fromEntries(Object.entries(node).map(([key, value]) =>
      [key, typeof value === "number" ? FieldValue.increment(value) : increments(value)]));
    tx.create(raw, { uid: actor.uid, roles: [...new Set(actor.principal.grants.map(grant => grant.role))],
      collectedAt: Timestamp.fromMillis(now), purgeAt, events: body.events });
    tx.set(firestore.collection("cmsUsageDaily").doc(day),
      { activeUsers: FieldValue.increment(dailyPresence.exists ? 0 : 1), ...increments(counts) }, { merge: true });
    for (const [eventDay, tree] of eventDays) tx.set(firestore.collection("cmsUsageDaily").doc(eventDay), increments(tree), { merge: true });
    tx.set(dayPerson, { purgeAt, lastAt: Math.max(lastAt ?? 0, events.at(-1).at), screens: recent });
    if (!teamCounted) tx.set(presence.doc(`person_${person}`), { lastDay: today, group, role, purgeAt });
    for (const id of created) tx.create(presence.doc(id), { purgeAt });
    for (const id of ids.filter(id => id.startsWith("repeat_"))) tx.set(presence.doc(id), { purgeAt, ...markers.get(id) });
    // A week marker without grouped was written before team and role counts; count this person for them once.
    if (weeklyPresence.data()?.grouped !== true) {
      tx.set(weekPerson, { purgeAt, grouped: true }, { merge: true });
      tx.set(firestore.collection("cmsUsageWeekly").doc(week), { ...(weeklyPresence.exists ? {} : { activeUsers: FieldValue.increment(1) }),
        groups: { [group]: { activeUsers: FieldValue.increment(1) } }, roles: { [role]: { activeUsers: FieldValue.increment(1) } } }, { merge: true });
    }
  });
}

// Project known numeric fields explicitly: stored raw or person data cannot enter a response.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const millis = value => typeof value === "string" ? Date.parse(value) : typeof value?.toMillis === "function" ? value.toMillis() : NaN;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round1 = value => value === null ? null : Math.round(value * 10) / 10;
const byGroup = make => Object.fromEntries(GROUPS.map(group => [group, make(group)]));
// Group counts exist only on Eastern rows collected after the split began; other rows report null.
const split = data => plain(data?.groups) ? byGroup(group => count(data.groups[group]?.activeUsers)) : byGroup(() => null);
const roleKeys = data => plain(data) ? Object.keys(data).filter(key => ROLE.test(key)) : [];

async function readReport(firestore, days, now) {
  const today = dayOf(now);
  const dates = Array.from({ length: days }, (_, index) => shiftDay(today, index - days + 1));
  const priorDates = dates.map(value => shiftDay(value, -days));
  // Include calendar weeks that start within the chosen window; the current week is partial.
  const weeks = dates.filter(value => mondayOf(value) === value);
  const thisWeek = mondayOf(today);
  const start = easternMidnight(dates[0]);
  const priorStart = easternMidnight(priorDates[0]);
  const end = new Date(now).toISOString();
  const daily = firestore.collection("cmsUsageDaily");
  const weekly = firestore.collection("cmsUsageWeekly");
  const both = keys => keys.flatMap(key => [key, `${EASTERN_PREFIX}${key}`]);
  const [dailyRows, weeklyRows, priorRows, compareRows, first, firstEastern, staff] = await Promise.all([
    firestore.getAll(...both(dates).map(key => daily.doc(key))),
    firestore.getAll(...both(weeks).map(key => weekly.doc(key))),
    firestore.getAll(...priorDates.map(key => daily.doc(`${EASTERN_PREFIX}${key}`))),
    firestore.getAll(weekly.doc(`${EASTERN_PREFIX}${thisWeek}`), weekly.doc(`${EASTERN_PREFIX}${shiftDay(thisWeek, -7)}`)),
    daily.orderBy("__name__").limit(1).get(),
    daily.where("__name__", ">=", daily.doc(EASTERN_PREFIX)).orderBy("__name__").limit(1).get(),
    readStaff(firestore),
  ]);
  const groupOfUid = uid => staff?.groups.get(uid) ?? null;
  const [history, active, problemReports, contentFlow, jobs] = await Promise.all([
    staff ? readActivityHistory(firestore, [...staff.groups.keys()], start, end) : { status: "unavailable", start, end, actions: [] },
    optional(() => readActivePeople(firestore, dates[0])),
    optional(() => readProblemReports(firestore, start)),
    optional(() => readContentFlow(firestore, staff ? groupOfUid : null, start, now)),
    staff ? optional(() => readJobs(firestore, groupOfUid, Date.parse(priorStart), Date.parse(start), now)) : { status: "unavailable" },
  ]);
  const easternFromDate = firstEastern.docs[0]?.id.startsWith(EASTERN_PREFIX) ? firstEastern.docs[0].id.slice(EASTERN_PREFIX.length) : null;
  const eastern = dates.map((date, index) => ({ date, data: dailyRows[index * 2 + 1].data() ?? {} }));
  const prior = priorRows.map(row => ({ data: row.data() ?? {} }));
  const groupData = (data, group) => plain(data.groups?.[group]) ? data.groups[group] : {};

  const screens = Object.entries({ ...config.screens, ...config.earlierScreens }).map(([id, label]) =>
    ({ id, label, views: 0, visibleMs: 0, personDays: 0, ...byGroup(() => ({ views: 0, visibleMs: 0, personDays: 0 })) }));
  const actions = Object.entries(config.actions).map(([id, label]) =>
    ({ id, label, count: 0, personDays: 0, lastUsed: null, ...byGroup(() => ({ count: 0, personDays: 0 })) }));
  // Each event is in exactly one UTC or Eastern row, so totals add both.
  dailyRows.forEach((row, index) => {
    const data = row.data() ?? {};
    for (const screen of screens) {
      screen.views += count(data.views?.[screen.id]);
      screen.visibleMs += count(data.visibleMs?.[screen.id]);
    }
    for (const action of actions) {
      action.count += count(data.actions?.[action.id]);
      if (count(data.actions?.[action.id])) action.lastUsed = dates[Math.floor(index / 2)];
    }
  });
  for (const { data } of eastern) {
    for (const group of GROUPS) {
      const stored = groupData(data, group);
      for (const screen of screens) {
        screen[group].views += count(stored.views?.[screen.id]);
        screen[group].visibleMs += count(stored.visibleMs?.[screen.id]);
        screen[group].personDays += count(stored.screenDays?.[screen.id]);
      }
      for (const action of actions) {
        action[group].count += count(stored.actions?.[action.id]);
        action[group].personDays += count(stored.actionDays?.[action.id]);
      }
    }
  }
  for (const row of [...screens, ...actions]) row.personDays = GROUPS.reduce((sum, group) => sum + row[group].personDays, 0);

  const sessions = byGroup(group => eastern.reduce((totals, { data }) => {
    const stored = groupData(data, group);
    totals.sessions += count(stored.sessions);
    totals.visibleMs += Object.keys(config.screens).reduce((sum, id) => sum + count(stored.visibleMs?.[id]), 0);
    return totals;
  }, { sessions: 0, visibleMs: 0 }));
  // Visible milliseconds by Eastern weekday (Monday first) and hour.
  const hourMs = byGroup(group => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const { date, data } of eastern) {
      const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const stored = groupData(data, group).hourMs;
      for (let hour = 0; hour < 24; hour += 1) grid[weekday][hour] += count(stored?.[String(hour).padStart(2, "0")]);
    }
    return grid;
  });
  const frictionOf = rows => byGroup(group => {
    const totals = { transitions: 0, backForth: 0, pairs: {}, ...Object.fromEntries(Object.values(REPEAT_ACTIONS)
      .map(kind => [kind, { items: 0, repeats: 0, repeatedItems: 0 }])) };
    for (const { data } of rows) {
      const stored = groupData(data, group);
      totals.transitions += count(stored.transitions);
      totals.backForth += count(stored.backForth);
      for (const [pair, value] of Object.entries(plain(stored.pairs) ? stored.pairs : {})) {
        const [a, b] = pair.split("~");
        if (own(config.screens, a) && own(config.screens, b) && a < b) totals.pairs[pair] = (totals.pairs[pair] ?? 0) + count(value);
      }
      for (const kind of Object.values(REPEAT_ACTIONS)) {
        for (const field of ["items", "repeats", "repeatedItems"]) totals[kind][field] += count(stored.repeat?.[kind]?.[field]);
      }
    }
    totals.pairs = Object.entries(totals.pairs).filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
      .map(([pair, value]) => ({ screens: pair.split("~").map(id => config.screens[id]), count: value }));
    return totals;
  });
  const roster = new Map();
  for (const role of staff?.roles.values() ?? []) roster.set(role, (roster.get(role) ?? 0) + 1);
  const roleRows = new Map([...roster.keys(), ...(active.status === "ready" ? active.roles.keys() : []),
    ...eastern.flatMap(({ data }) => roleKeys(data.roles))].map(role => [role,
    { role, group: role === "owner" ? "product" : "newsroom", roster: roster.get(role) ?? 0,
      active: active.status === "ready" ? active.roles.get(role) ?? 0 : 0, sessions: 0, visibleMs: 0 }]));
  for (const { data } of eastern) {
    for (const role of roleKeys(data.roles)) {
      roleRows.get(role).sessions += count(data.roles[role]?.sessions);
      roleRows.get(role).visibleMs += count(data.roles[role]?.visibleMs);
    }
  }

  // Distinct people cannot be added across conventions, so a key can have a UTC row and an Eastern row.
  // UTC rows appear before the switch and wherever a UTC row is stored; Eastern rows from the switch on.
  const people = (rows, keys, isEastern, extra) => keys.flatMap((key, index) => {
    const [utc, et] = [rows[index * 2], rows[index * 2 + 1]];
    return [
      ...(!isEastern(key) || utc.exists ? [{ key, timezone: "UTC", activeUsers: count(utc.data()?.activeUsers), ...split(null), ...extra(null) }] : []),
      ...(isEastern(key) ? [{ key, timezone: TIMEZONE, activeUsers: count(et.data()?.activeUsers), ...split(et.data()), ...extra(et.data()) }] : []),
    ];
  });
  const switched = value => easternFromDate !== null && value >= easternFromDate;
  return { days, analyticsEnabled: config.analyticsEnabled, generatedAt: end,
    firstCollectedDate: first.docs[0]?.id.replace(EASTERN_PREFIX, "") ?? null, easternFromDate, timezone: TIMEZONE,
    daily: people(dailyRows, dates, switched, () => ({})).map(({ key, ...row }) => ({ date: key, ...row })),
    weekly: people(weeklyRows, weeks, value => easternFromDate !== null && value >= mondayOf(easternFromDate),
      data => ({ byRole: roleKeys(data?.roles).sort().map(role => ({ role, activeUsers: count(data.roles[role]?.activeUsers) })) }))
      .map(({ key, ...row }) => ({ week: key, ...row })),
    weekCompare: { thisWeek: split(compareRows[0].data()), lastWeek: split(compareRows[1].data()) },
    sessions,
    activePeople: active.status === "ready" ? { status: "ready", ...active.groups } : { status: "unavailable" },
    roleActivity: staff && active.status === "ready"
      ? { status: "ready", rows: [...roleRows.values()].sort((a, b) => b.roster - a.roster || a.role.localeCompare(b.role)) }
      : { status: "unavailable", rows: [] },
    hourMs,
    history,
    // Earlier combined destinations appear only in windows that include their stored counts.
    screens: screens.filter(row => !own(config.earlierScreens, row.id) || row.views || row.visibleMs)
      .sort((a, b) => b.personDays - a.personDays || b.visibleMs - a.visibleMs || a.label.localeCompare(b.label)),
    actions: actions.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    friction: { current: frictionOf(eastern), prior: frictionOf(prior), jobs },
    contentFlow,
    problemReports,
    excludedAccounts: staff ? staff.excluded : null };
}

// An optional section that cannot be read completely is reported as unavailable, never as zeros.
async function optional(read) {
  try {
    return { status: "ready", ...await read() };
  } catch {
    return { status: "unavailable" };
  }
}

async function readStaff(firestore) {
  try {
    const users = await firestore.collection("users").select("role", "accessTier", "grants", "usageAnalyticsExcluded").limit(501).get();
    if (users.size > 500) return null;
    const groups = new Map();
    const roles = new Map();
    let excluded = 0;
    for (const row of users.docs) {
      const profile = row.data();
      if (profile.usageAnalyticsExcluded === true) { excluded += 1; continue; }
      if (row.id.startsWith("system:")) continue;
      if (["staff", "contributor", "editor", "admin", "super_admin"].includes(profile.role) ||
          ["viewer", "contributor", "editor", "publisher", "admin", "owner"].includes(profile.accessTier) ||
          (Array.isArray(profile.grants) && profile.grants.some(grant => ["staff", "contributor", "editor", "admin", "super_admin"].includes(grant?.role)))) {
        groups.set(row.id, groupOf(profile));
        roles.set(row.id, roleOf(profile));
      }
    }
    return { groups, roles, excluded };
  } catch {
    return null;
  }
}

// Distinct people in the window, from each person's last active Eastern day.
async function readActivePeople(firestore, firstDay) {
  const markers = await firestore.collection("cmsUsagePresence").where("lastDay", ">=", firstDay).select("group", "role").limit(1001).get();
  if (markers.size > 1000) throw new Error("Too many active people to count");
  const roles = new Map();
  const groups = byGroup(() => 0);
  for (const row of markers.docs) {
    const { group, role } = row.data();
    if (GROUPS.includes(group)) groups[group] += 1;
    if (typeof role === "string" && ROLE.test(role)) roles.set(role, (roles.get(role) ?? 0) + 1);
  }
  return { roles, groups };
}

async function readProblemReports(firestore, start) {
  const reports = firestore.collection("bug_reports");
  const [open, resolved, filed] = await Promise.all([
    reports.where("status", "in", OPEN_REPORT_STATUSES).count().get(),
    reports.where("resolvedAt", ">=", start).select("createdAt", "resolvedAt").limit(2001).get(),
    reports.where("createdAt", ">=", start).select("route.path").limit(2001).get(),
  ]);
  if (resolved.size > 2000 || filed.size > 2000) throw new Error("Too many problem reports to summarize");
  const days = resolved.docs.map(row => (millis(row.data().resolvedAt) - millis(row.data().createdAt)) / DAY_MS)
    .filter(value => Number.isFinite(value) && value >= 0);
  // Pages keep their first two path segments; anything that is not a plain word is replaced so IDs never appear.
  const pages = new Map();
  for (const row of filed.docs) {
    const path = row.data().route?.path;
    const page = typeof path === "string"
      ? `/${path.split("/").filter(Boolean).slice(0, 2).map(part => /^[a-z][a-z-]{0,39}$/.test(part) ? part : ":id").join("/")}`
      : "Not from a Boardwalk page";
    pages.set(page, (pages.get(page) ?? 0) + 1);
  }
  return { open: count(open.data().count), resolved: days.length, medianDaysToResolve: round1(median(days)), filed: filed.size,
    topPages: [...pages].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([page, value]) => ({ page, count: value })) };
}

async function readContentFlow(firestore, groupOfUid, start, now) {
  const posts = firestore.collection("cmsPosts");
  const [published, drafts] = await Promise.all([
    posts.where("firstPublishedAt", ">=", start).select("type", "createdAt", "firstPublishedAt", "firstPublishedBy").limit(5001).get(),
    posts.where("status", "==", "draft").select("type", "createdAt", "createdBy", "deleted").limit(5001).get(),
  ]);
  if (published.size > 5000 || drafts.size > 5000) throw new Error("Too many posts to summarize");
  // Without the staff roster, accounts cannot be assigned to teams; only totals are returned.
  const label = uid => groupOfUid(uid) ?? "other";
  const blank = () => ({ total: 0, ...(groupOfUid ? { newsroom: 0, product: 0, other: 0 } : { newsroom: null, product: null, other: null }) });
  const weeks = new Map();
  const hours = [];
  for (const row of published.docs) {
    const post = row.data();
    const at = millis(post.firstPublishedAt);
    if (post.type !== "post" || !Number.isFinite(at)) continue;
    const week = mondayOf(dayOf(at));
    const counts = weeks.get(week) ?? { week, ...blank() };
    counts.total += 1;
    if (groupOfUid) counts[label(post.firstPublishedBy)] += 1;
    weeks.set(week, counts);
    const hoursToPublish = (at - millis(post.createdAt)) / 3_600_000;
    if (Number.isFinite(hoursToPublish) && hoursToPublish >= 0) hours.push(hoursToPublish);
  }
  const ages = Object.fromEntries(DRAFT_AGES.map(([bucket]) => [bucket, blank()]));
  for (const row of drafts.docs) {
    const post = row.data();
    const age = (now - millis(post.createdAt)) / DAY_MS;
    if (post.type !== "post" || post.deleted === true || !Number.isFinite(age)) continue;
    const bucket = ages[DRAFT_AGES.find(([, limit]) => age < limit)[0]];
    bucket.total += 1;
    if (groupOfUid) bucket[label(post.createdBy)] += 1;
  }
  return { teams: groupOfUid ? "ready" : "unavailable", publishedWeeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    medianHoursToFirstPublish: round1(median(hours)), openDrafts: DRAFT_AGES.map(([bucket]) => ({ bucket, ...ages[bucket] })) };
}

// Preview job outcomes and uploads left active over a day, for staff accounts in this and the prior window.
async function readJobs(firestore, groupOfUid, priorStart, start, now) {
  // Preview queue records expire 30 days after the request, so only the last 30 days are counted.
  const previewFrom = now - PREVIEW_RETENTION_MS;
  const coverage = (from, to) => to <= previewFrom ? { status: "unavailable" }
    : from < previewFrom ? { status: "partial", from: dayOf(previewFrom) } : { status: "full" };
  const [previews, uploads] = await Promise.all([
    firestore.collection("cmsPreviewQueue").where("requestedAt", ">=", Timestamp.fromMillis(Math.max(priorStart, previewFrom)))
      .select("status", "requestedAt", "requestedBy").limit(5001).get(),
    firestore.collection("mediaSourceUploads").where("status", "==", "active").select("createdAt", "actorUid").limit(1001).get(),
  ]);
  if (previews.size > 5000 || uploads.size > 1000) throw new Error("Too many jobs to summarize");
  const empty = () => byGroup(() => ({ previews: 0, failed: 0, expired: 0, stuckUploads: 0 }));
  const periods = { current: empty(), prior: empty() };
  const periodOf = at => at >= start ? periods.current : at >= priorStart ? periods.prior : null;
  for (const row of previews.docs) {
    const job = row.data();
    const group = groupOfUid(job.requestedBy);
    const period = periodOf(millis(job.requestedAt));
    if (!group || !period) continue;
    period[group].previews += 1;
    if (job.status === "failed") period[group].failed += 1;
    if (job.status === "expired") period[group].expired += 1;
  }
  for (const row of uploads.docs) {
    const upload = row.data();
    const at = millis(upload.createdAt);
    const group = groupOfUid(upload.actorUid);
    const period = periodOf(at);
    if (group && period && now - at > DAY_MS) period[group].stuckUploads += 1;
  }
  return { ...periods, previewCoverage: { current: coverage(start, now), prior: coverage(priorStart, start) } };
}

async function readActivityHistory(firestore, staffIds, start, end) {
  try {
    return await firestore.runTransaction(async tx => {
      const count = async query => {
        const value = (await tx.get(query.count())).data().count;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Incomplete activity count");
        return value;
      };
      const [total, dated] = await Promise.all([
        count(firestore.collection("admin_logs")),
        count(firestore.collection("admin_logs")
          .where("timestamp", ">=", Timestamp.fromDate(new Date("0001-01-01T00:00:00.000Z")))
          .where("timestamp", "<=", Timestamp.fromDate(new Date("9999-12-31T23:59:59.999Z")))),
      ]);
      if (total !== dated) throw new Error("Incomplete activity coverage");
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
      const profile = (await firestore.collection("users").doc(actor.uid).get()).data() ?? {};
      if (profile.usageAnalyticsExcluded === true) return res.status(200).json({ collected: false });
      await collectBatch(firestore, actor, profile, body, now());
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
