"use strict";

const {
  SEED_COMPARISONS,
  SEED_LINES,
  applyAutoEntries,
  buildCsv,
  buildView,
  centsOrNull,
  comparisonDocument,
  freezePeriod,
  hasValidManualOverride,
  isPeriodLineEligible,
  hardwareDocument,
  hardwareMonthlyCents,
  lineDocument,
  periodFor,
  reopenPeriod,
  snapshotDocument,
  validId,
  validPeriod,
  validateComparisonInput,
  validateHardwareInput,
  validateLineInput,
} = require("./cost-ledger");

const { randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");

const LINES = "costLedgerLines";
const PERIODS = "costLedgerPeriods";
const SNAPSHOTS = "costLedgerSnapshots";
const COMPARISONS = "costLedgerComparisons";
const ASSUMPTIONS = "costLedgerAssumptions";
const ADMIN_LOGS = "admin_logs";

const AUDIT_ACTIONS = Object.freeze({
  seed: "costLedger.seed",
  saveLine: "costLedger.saveLine",
  savePeriodAmount: "costLedger.savePeriodAmount",
  saveHardware: "costLedger.saveHardware",
  saveComparison: "costLedger.saveComparison",
  closeMonth: "costLedger.closeMonth",
  reopenMonth: "costLedger.reopenMonth",
});

function rejection(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readCollection(db, name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function readDoc(db, name, id) {
  const snap = await db.collection(name).doc(id).get();
  if (!snap.exists) return null;
  return { id, ...snap.data() };
}

function actorFrom(actor) {
  const person = typeof actor === "string"
    ? { uid: actor, email: null, source: null }
    : { uid: actor?.uid, email: actor?.email ?? null, source: actor?.source ?? null };
  if (!person.uid) throw rejection(401, "A signed-in account is required.");
  return person;
}

function auditRecord(actor, action, target, before, after, nowIso) {
  return {
    actorUid: actor.uid,
    actorEmail: actor.email,
    action: action,
    target: target,
    before: before ?? null,
    after: after ?? null,
    source: actor.source,
    timestamp: FieldValue.serverTimestamp(),
    at: nowIso,
  };
}

function withoutId(document) {
  if (!document) return document;
  const rest = { ...document };
  delete rest.id;
  return rest;
}

async function transact(db, work) {
  return db.runTransaction(async (tx) => {
    const writes = [];
    const reader = {
      async get(ref) {
        return tx.get ? tx.get(ref) : ref.get();
      },
    };
    const result = await work(reader, (ref, data) => {
      writes.push({ ref, data });
    });
    for (const write of writes) {
      if (tx.set) await tx.set(write.ref, write.data);
      else await write.ref.set(write.data);
    }
    return result;
  });
}

async function ensureSeed(db, actor, nowIso) {
  const person = actorFrom(actor);
  return transact(db, async (reader, write) => {
    const created = [];
    for (const seed of [...SEED_LINES, ...SEED_COMPARISONS.map((row) => ({ ...row, kind: "comparison" }))]) {
      const name = seed.kind === "comparison" ? COMPARISONS : LINES;
      const ref = db.collection(name).doc(seed.id);
      const snap = await reader.get(ref);
      if (snap.exists) continue;
      write(ref, seed.kind === "comparison"
        ? comparisonDocument(seed, nowIso, person.uid)
        : lineDocument(seed, nowIso, person.uid));
      created.push(seed.id);
    }
    const hardwareRef = db.collection(ASSUMPTIONS).doc("hardware");
    const hardwareSnap = await reader.get(hardwareRef);
    if (!hardwareSnap.exists) {
      write(hardwareRef, hardwareDocument(nowIso, person.uid));
      created.push("hardware");
    }
    if (created.length > 0) {
      write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
        person, AUDIT_ACTIONS.seed, "costLedger", null, { created }, nowIso,
      ));
    }
    return { created };
  });
}

function stored(snap, id) {
  return snap.exists ? { id, ...snap.data() } : null;
}

async function saveLine(db, input, actor, nowIso) {
  const person = actorFrom(actor);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw rejection(400, "Line must be an object.");
  }
  if (!validId(input.id)) {
    throw rejection(400, "Line id must be lowercase letters, numbers, and hyphens.");
  }
  return transact(db, async (reader, write) => {
    const ref = db.collection(LINES).doc(input.id);
    const existing = stored(await reader.get(ref), input.id);
    const error = validateLineInput(input, { creating: !existing });
    if (error) throw rejection(400, error);
    if (!existing && input.id.startsWith("hardware-")) {
      throw rejection(400, "Hardware lines come from the fleet assumptions.");
    }
    if (
      existing?.id.startsWith("hardware-")
      && (
        input.amountCents !== existing.amountCents
        || input.cadence !== existing.cadence
        || input.label.trim() !== existing.label
      )
    ) {
      throw rejection(400, "Hardware amount, cadence and label come from the fleet assumptions.");
    }
    if (existing?.source === "auto" && input.amountCents !== null) {
      throw rejection(400, "An automatic line has no standing amount. Enter the amount on a month.");
    }
    const next = {
      label: input.label.trim(),
      category: input.category,
      project: input.project,
      source: existing?.source || "manual",
      currency: "USD",
      cadence: input.cadence,
      amountCents: input.amountCents,
      vendor: (input.vendor || "").trim(),
      notes: (input.notes || "").trim(),
      enabled: input.enabled,
      autoKey: existing?.autoKey ?? null,
      freshnessStatus: existing?.source === "auto"
        ? existing.freshnessStatus
        : input.amountCents === null ? "blank" : "manual",
      freshnessAt: existing?.freshnessAt ?? null,
      updatedAt: nowIso,
      updatedBy: person.uid,
    };
    write(ref, next);
    const after = { id: input.id, ...next };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.saveLine, `${LINES}/${input.id}`, existing, after, nowIso,
    ));
    return { before: existing, after };
  });
}

async function savePeriodAmount(db, input, actor, nowIso) {
  const person = actorFrom(actor);
  if (!validId(input?.lineId) || !validPeriod(input?.period)) {
    throw rejection(400, "Period amount needs a line and a YYYY-MM period.");
  }
  if (centsOrNull(input.amountCents) === undefined) {
    throw rejection(400, "Period amount must be blank or a whole number of cents.");
  }
  return transact(db, async (reader, write) => {
    const lineRef = db.collection(LINES).doc(input.lineId);
    if (!(await reader.get(lineRef)).exists) {
      throw rejection(404, "That cost line does not exist.");
    }
    const ref = db.collection(PERIODS).doc(input.period);
    const current = stored(await reader.get(ref), input.period);
    if (current?.status === "closed") {
      throw rejection(409, "That month is closed. Reopen it before changing an amount.");
    }
    const entries = { ...(current?.entries || {}) };
    entries[input.lineId] = {
      amountCents: input.amountCents,
      source: "manual",
      pulledAt: nowIso,
    };
    const next = {
      period: input.period,
      status: "open",
      currency: "USD",
      entries,
      closedAt: null,
      closedBy: null,
      schedulerCloseBlockedAt: current?.schedulerCloseBlockedAt ?? null,
      updatedAt: nowIso,
    };
    write(ref, next);
    const after = { id: input.period, ...next };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.savePeriodAmount, `${PERIODS}/${input.period}`, current, after, nowIso,
    ));
    return { before: current, after };
  });
}

async function saveHardware(db, input, actor, nowIso) {
  const person = actorFrom(actor);
  const error = validateHardwareInput(input);
  if (error) throw rejection(400, error);
  const machines = input.machines.map((machine) => ({
    id: machine.id,
    label: machine.label.trim(),
    purchaseCents: machine.purchaseCents,
    lifeMonths: machine.lifeMonths,
    watts: machine.watts,
    hoursPerMonth: machine.hoursPerMonth,
    centsPerKwh: machine.centsPerKwh,
    internetShareCents: machine.internetShareCents,
  }));
  return transact(db, async (reader, write) => {
    const assumptionsRef = db.collection(ASSUMPTIONS).doc("hardware");
    const before = stored(await reader.get(assumptionsRef), "hardware");
    const next = { machines, updatedAt: nowIso, updatedBy: person.uid };
    const lines = [];
    for (const machine of machines) {
      const lineId = `hardware-${machine.id}`;
      const ref = db.collection(LINES).doc(lineId);
      const existing = stored(await reader.get(ref), lineId);
      const seed = SEED_LINES.find((line) => line.id === lineId);
      if (!existing && !seed) throw rejection(500, "That fleet machine has no cost line.");
      const amountCents = hardwareMonthlyCents(machine);
      const lineNext = {
        ...(existing ? withoutId(existing) : lineDocument(seed, nowIso, person.uid)),
        label: machine.label,
        amountCents,
        cadence: "monthly",
        freshnessStatus: amountCents === null ? "blank" : "manual",
        updatedAt: nowIso,
        updatedBy: person.uid,
      };
      write(ref, lineNext);
      lines.push({ id: lineId, amountCents });
    }
    write(assumptionsRef, next);
    const after = { assumptions: next, lines };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.saveHardware, `${ASSUMPTIONS}/hardware`, before, after, nowIso,
    ));
    return { before, after };
  });
}

async function saveComparison(db, input, actor, nowIso) {
  const person = actorFrom(actor);
  const error = validateComparisonInput(input);
  if (error) throw rejection(400, error);
  return transact(db, async (reader, write) => {
    const ref = db.collection(COMPARISONS).doc(input.id);
    const before = stored(await reader.get(ref), input.id);
    const next = {
      vendor: input.vendor.trim(),
      product: input.product.trim(),
      scope: "platform-and-hosting",
      status: input.status,
      priceLabel: input.priceLabel.trim(),
      monthlyCents: input.monthlyCents,
      annualCents: input.annualCents,
      rangeNote: (input.rangeNote || "").trim(),
      sourceUrl: input.sourceUrl,
      sourceReadOn: input.sourceReadOn,
      excludes: "labor",
      notes: (input.notes || "").trim(),
      updatedAt: nowIso,
      updatedBy: person.uid,
    };
    write(ref, next);
    const after = { id: input.id, ...next };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.saveComparison, `${COMPARISONS}/${input.id}`, before, after, nowIso,
    ));
    return { before, after };
  });
}

async function closeMonth(db, period, actor, nowIso, options = {}) {
  const person = actorFrom(actor);
  if (!validPeriod(period)) throw rejection(400, "Period must be YYYY-MM.");
  const onlyIfExists = options.onlyIfExists === true;
  const respectSchedulerBlock = options.respectSchedulerBlock === true;
  return transact(db, async (reader, write) => {
    const ref = db.collection(PERIODS).doc(period);
    const current = stored(await reader.get(ref), period);
    if (!current && onlyIfExists) return { changed: false, period: null };
    if (
      respectSchedulerBlock
      && (current?.status !== "open" || current.schedulerCloseBlockedAt)
    ) return { changed: false, period: current };
    const linesSnap = await reader.get(db.collection(LINES));
    const lines = linesSnap.docs.map((item) => ({ id: item.id, ...item.data() }));
    if (respectSchedulerBlock) {
      const missing = [];
      const stale = [];
      for (const line of lines) {
        if (!isPeriodLineEligible(line) || line.source !== "auto") continue;
        const entry = current.entries?.[line.id];
        if (hasValidManualOverride(entry)) continue;
        if (entry?.source !== "auto" || !Number.isSafeInteger(entry.amountCents)
          || centsOrNull(entry.amountCents) === undefined) {
          missing.push(line.id);
          continue;
        }
        const pulledAt = new Date(entry.pulledAt || "");
        if (entry.estimated === true || !Number.isFinite(pulledAt.getTime())
          || periodFor(pulledAt) <= period) stale.push(line.id);
      }
      const lineIds = missing.length ? missing : stale;
      if (lineIds.length) {
        const reason = missing.length ? "missing" : "stale-or-estimated";
        return { changed: false, period: current, blocked: { reason, lineIds } };
      }
    }

    const frozen = freezePeriod(lines, current, period, person.uid, nowIso);
    if (!frozen.changed) return { changed: false, period: current };
    write(ref, frozen.period);
    const after = { id: period, ...frozen.period };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.closeMonth, `${PERIODS}/${period}`, current, after, nowIso,
    ));
    return { changed: true, before: current, after };
  });
}

async function reopenMonth(db, period, actor, nowIso) {
  const person = actorFrom(actor);
  if (!validPeriod(period)) throw rejection(400, "Period must be YYYY-MM.");
  return transact(db, async (reader, write) => {
    const ref = db.collection(PERIODS).doc(period);
    const current = stored(await reader.get(ref), period);
    const opened = reopenPeriod(current, nowIso);
    if (!opened.changed) return { changed: false, period: current };
    const next = withoutId(opened.period);
    write(ref, next);
    const after = { id: period, ...next };
    write(db.collection(ADMIN_LOGS).doc(randomUUID()), auditRecord(
      person, AUDIT_ACTIONS.reopenMonth, `${PERIODS}/${period}`, current, after, nowIso,
    ));
    return { changed: true, before: current, after };
  });
}

async function loadView(db, period) {
  if (!validPeriod(period)) throw rejection(400, "Period must be YYYY-MM.");
  const [lines, periods, snapshots, comparisons, hardware] = await Promise.all([
    readCollection(db, LINES),
    readCollection(db, PERIODS),
    readCollection(db, SNAPSHOTS),
    readCollection(db, COMPARISONS),
    readDoc(db, ASSUMPTIONS, "hardware"),
  ]);
  lines.sort((left, right) => left.label.localeCompare(right.label));
  comparisons.sort((left, right) => left.vendor.localeCompare(right.vendor) || left.product.localeCompare(right.product));
  const view = buildView({ lines, periods, snapshots, comparisons, period });
  return {
    ...view,
    csv: buildCsv(view),
    hardware: hardware || { machines: [] },
  };
}

async function loadPeriod(db, period) {
  if (!validPeriod(period)) throw rejection(400, "Period must be YYYY-MM.");
  return readDoc(db, PERIODS, period);
}

async function writeAutomaticPeriod(db, period, updates, pulledAt) {
  if (!validPeriod(period)) throw rejection(400, "Period must be YYYY-MM.");
  if (!Array.isArray(updates)) throw rejection(400, "Automatic updates must be an array.");
  return transact(db, async (reader, write) => {
    const ref = db.collection(PERIODS).doc(period);
    const current = stored(await reader.get(ref), period);
    if (current?.status === "closed") return { skipped: true, period: current, appliedLineIds: [] };
    const automaticUpdates = [];
    const eligibleLineIds = [];
    for (const update of updates) {
      if (!validId(update?.lineId) || centsOrNull(update.amountCents) === undefined) {
        throw rejection(400, "Automatic updates need a line and a whole number of cents.");
      }
      const line = stored(await reader.get(db.collection(LINES).doc(update.lineId)), update.lineId);
      if (!isPeriodLineEligible(line)) continue;
      eligibleLineIds.push(update.lineId);
      if (
        line.source === "auto"
        && line.autoKey === update.lineId
        && line.category !== "hardware"
        && !update.lineId.startsWith("hardware-")
      ) {
        automaticUpdates.push(update);
      }
    }
    if (automaticUpdates.length === 0) return { skipped: true, period: current, appliedLineIds: [], eligibleLineIds };
    const applied = applyAutoEntries(current, period, automaticUpdates, pulledAt);
    if (!applied.skipped) write(ref, applied.period);
    const appliedLineIds = applied.skipped ? [] : automaticUpdates
      .filter((update) => applied.period.entries[update.lineId]?.source === "auto"
        && Number.isSafeInteger(applied.period.entries[update.lineId].amountCents))
      .map((update) => update.lineId);
    const manualLineIds = applied.skipped ? [] : automaticUpdates
      .filter((update) => hasValidManualOverride(applied.period.entries[update.lineId]))
      .map((update) => update.lineId);
    return { ...applied, appliedLineIds, manualLineIds, eligibleLineIds };
  });
}

async function writeLineFreshness(db, lineId, freshnessStatus, freshnessAt) {
  if (!validId(lineId)) return null;
  return transact(db, async (reader, write) => {
    const ref = db.collection(LINES).doc(lineId);
    const line = stored(await reader.get(ref), lineId);
    if (
      !line
      || line.source !== "auto"
      || line.autoKey !== lineId
      || line.category === "hardware"
      || lineId.startsWith("hardware-")
    ) return null;
    const next = { ...withoutId(line), freshnessStatus, freshnessAt };
    write(ref, next);
    return next;
  });
}

async function writeSnapshot(db, snapshotId, document) {
  await db.collection(SNAPSHOTS).doc(snapshotId).set(document);
  return document;
}

module.exports = {
  ADMIN_LOGS,
  ASSUMPTIONS,
  AUDIT_ACTIONS,
  COMPARISONS,
  LINES,
  PERIODS,
  SNAPSHOTS,
  closeMonth,
  ensureSeed,
  loadPeriod,
  loadView,
  reopenMonth,
  saveComparison,
  saveHardware,
  saveLine,
  savePeriodAmount,
  snapshotDocument,
  writeAutomaticPeriod,
  writeLineFreshness,
  writeSnapshot,
};
