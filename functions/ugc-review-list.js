"use strict";

const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { hasGlobalCapability } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "rejected", "imported"];
const IN_PROGRESS = ["importing", "rejecting"];
const QUEUE_PHASES = [...STATUSES, ...IN_PROGRESS];
const PAGE_SIZE = 20;
const STALE_DECISION_MS = 10 * 60_000;

class ReviewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function submissionId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new ReviewError(400, "Invalid submission id");
  return value.toLowerCase();
}

function iso(value) {
  return value?.toDate?.().toISOString() ?? null;
}

function row(id, value, nowMs) {
  return {
    id, name: value.name ?? null, message: value.message ?? null,
    ...(value.status === "pending" ? { email: value.email } : {}),
    ...(value.status === "importing" ? { decisionCategory: value.decisionCategory } : {}),
    consentVersion: value.consentVersion, consentedAt: iso(value.consentedAt),
    scopes: value.scopes, file: value.file, status: value.status,
    createdAt: iso(value.createdAt),
    ...((IN_PROGRESS.includes(value.status)) ? {
      staleDecision: Date.parse(value.decisionStartedAt ?? "") <= nowMs - STALE_DECISION_MS,
    } : {}),
    ...(value.importedAsset ? { importedAsset: value.importedAsset } : {}),
  };
}

function cursorEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cursorDecode(value, status) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 1024) throw new ReviewError(400, "Invalid cursor");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString());
    if (decoded.filter !== status || !QUEUE_PHASES.includes(decoded.phase) ||
        !ID.test(decoded.id) || !Number.isSafeInteger(decoded.seconds) ||
        !Number.isInteger(decoded.nanoseconds) || decoded.nanoseconds < 0 ||
        decoded.nanoseconds >= 1_000_000_000) throw new Error();
    return decoded;
  } catch {
    throw new ReviewError(400, "Invalid cursor");
  }
}

async function listUgcSubmissions(firestore, now, req, res) {
    const filter = req.body.status ?? "pending";
    if (![...STATUSES, "all"].includes(filter)) throw new ReviewError(400, "Invalid status");
    const limit = req.body.limit ?? PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ReviewError(400, "Invalid limit");
    let cursor = cursorDecode(req.body.cursor, filter);
    const phases = filter === "all"
      ? ["pending", ...IN_PROGRESS, "rejected", "imported"]
      : filter === "pending" ? ["pending", ...IN_PROGRESS] : [filter];
    let phaseIndex = cursor ? phases.indexOf(cursor.phase) : 0;
    if (phaseIndex < 0) throw new ReviewError(400, "Invalid cursor");
    const rows = [];
    let nextCursor = null;
    while (phaseIndex < phases.length && rows.length < limit + 1) {
      const phase = phases[phaseIndex];
      let query = firestore.collection("ugcSubmissions")
        .where("status", "==", phase)
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
        .limit(limit + 1 - rows.length);
      if (cursor) query = query.startAfter(new Timestamp(cursor.seconds,
        cursor.nanoseconds), cursor.id);
      const page = await query.get();
      rows.push(...page.docs.map((doc) => ({ doc, phase })));
      if (page.size < limit + 1 - (rows.length - page.size)) {
        phaseIndex += 1;
        cursor = null;
      } else {
        break;
      }
    }
    if (rows.length > limit) {
      const last = rows[limit - 1];
      nextCursor = cursorEncode({ filter, phase: last.phase, id: last.doc.id,
        seconds: last.doc.data().createdAt.seconds,
        nanoseconds: last.doc.data().createdAt.nanoseconds });
    } else if (phaseIndex < phases.length && rows.length) {
      const last = rows[rows.length - 1];
      nextCursor = cursorEncode({ filter, phase: last.phase, id: last.doc.id,
        seconds: last.doc.data().createdAt.seconds,
        nanoseconds: last.doc.data().createdAt.nanoseconds });
    }
    res.status(200).json({ success: true,
      records: rows.slice(0, limit).map(({ doc }) => row(doc.id, doc.data(), now().getTime())), nextCursor });
  }

function createUgcListHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const authenticate = deps.requirePrincipalFn ?? requirePrincipal;
  const verifyAppCheck = deps.verifyAppCheckFn ?? verifyAppCheckToken;
  const now = deps.now ?? (() => new Date());
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (req.method !== "POST") throw new ReviewError(405, "Method not allowed");
      validateBoundedJsonRequest(req, 4096);
      await verifyAppCheck(req.headers?.["x-firebase-appcheck"]);
      const actor = await authenticate(req);
      if (!hasGlobalCapability(actor.principal, "submissions.review")) {
        throw new ReviewError(403, "Global media management access required");
      }
      await listUgcSubmissions(firestore, now, req, res);
    } catch (error) {
      if ((error.status ?? 500) >= 500) logger.error("UGC list failed", { error });
      res.status(error.status ?? 500).json({ error: error.status && error.status < 500
        ? error.message : "Submission review is unavailable" });
    }
  };
}

const cmsListUgcSubmissions = cmsOnRequest({ memory: "256MiB", concurrency: 10,
  maxInstances: 5 }, createUgcListHandler());
module.exports = { createUgcListHandler, listUgcSubmissions, cmsListUgcSubmissions,
  ID, IN_PROGRESS, STALE_DECISION_MS, ReviewError, submissionId };
