"use strict";

const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const {
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  PUBLIC_SOURCE_VERSION_FIELD,
  addressedPublishChanges,
} = require("./publish-build-state");

const CONTENT_SOURCE = "cms-runtime";
const DEFAULT_MAX_WAIT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_500;

// Add a surface only after its runtime HTML and assets are active together.
// The publication boundary is shared by Pages, Posts, and public Settings;
// Contact is the first route whose complete runtime is active at the apex.
const ACTIVE_RUNTIME_SURFACES = new Map([
  [
    "cmsPages/contact",
    { label: "Contact", url: "https://njpbs.org/contact/" },
  ],
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runtimeCandidate(changes) {
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development") return null;
  const raw = Array.isArray(changes) ? changes : [];
  const addressed = addressedPublishChanges(raw);
  if (raw.length !== 1 || addressed.length !== 1) return null;
  const change = addressed[0];
  if (change.operation === "withdraw") return null;
  const surface = ACTIVE_RUNTIME_SURFACES.get(
    `${change.collection}/${change.id}`,
  );
  return surface ? { change, surface } : null;
}

async function boundedFetch(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, {
        credentials: "omit",
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    controller.abort();
  }
}

async function waitForExactRuntimeReceipt(candidate, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const delay = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + Math.max(0, maxWaitMs);
  const nonce = deps.nonce ?? `${startedAt.toString(36)}-${crypto.randomUUID()}`;
  let attempt = 0;

  while (now() < deadline) {
    const url = new URL(candidate.surface.url);
    url.searchParams.set("cms-receipt", `${nonce}-${attempt}`);
    attempt += 1;
    const response = await boundedFetch(
      fetchImpl,
      url,
      Math.max(1, Math.min(requestTimeoutMs, deadline - now())),
    );
    if (
      response?.ok &&
      response.headers.get("x-njpbs-content-source") === CONTENT_SOURCE &&
      response.headers.get("x-njpbs-source-version") ===
        String(candidate.change.sourceVersion)
    ) {
      return true;
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(pollIntervalMs, remaining));
  }
  return false;
}

async function settleRuntimePublication(
  { firestore, actor, change, surface, source = null },
  deps = {},
) {
  const adminLogEntryFn = deps.adminLogEntryFn ?? adminLogEntry;
  const contentRef = firestore.collection(change.collection).doc(change.id);

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(contentRef);
    if (!snapshot.exists) return { status: "mismatch" };
    const document = snapshot.data();
    const exactVersion =
      document?.status === "published" &&
      document?.published?.sourceVersion === change.sourceVersion;
    if (!exactVersion) return { status: "mismatch" };

    const existingQueueId = document?.[PUBLISH_BUILD_QUEUE_FIELD];
    if (typeof existingQueueId === "string" && existingQueueId.length > 0) {
      return { status: "claimed", queueId: existingQueueId };
    }
    if (existingQueueId) return { status: "mismatch" };

    // An exact retry after a lost response is already complete. Do not append a
    // second audit row or make the same write again.
    if (document?.[PUBLISH_BUILD_PENDING_FIELD] === false) {
      return { status: "settled" };
    }
    if (document?.[PUBLISH_BUILD_PENDING_FIELD] !== true) {
      return { status: "mismatch" };
    }

    transaction.update(contentRef, {
      [PUBLISH_BUILD_PENDING_FIELD]: false,
      [PUBLISH_BUILD_QUEUE_FIELD]: null,
      [PUBLIC_SOURCE_VERSION_FIELD]: change.sourceVersion,
    });
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "cms.publish",
        target: `${change.collection}/${change.id}`,
        after: {
          status: "runtime_confirmed",
          label: surface.label,
          sourceVersion: change.sourceVersion,
          buildQueued: false,
        },
        source,
      }),
    );
    return { status: "settled" };
  });
}

async function tryRuntimePublication(fields, deps = {}) {
  const candidate = runtimeCandidate(fields.changes);
  if (!candidate) return null;
  const publicReceipt = {
    collection: candidate.change.collection,
    id: candidate.change.id,
    label: candidate.surface.label,
    sourceVersion: candidate.change.sourceVersion,
    status: "unconfirmed",
  };
  if (!(await waitForExactRuntimeReceipt(candidate, deps))) {
    return { confirmed: false, publicReceipt };
  }
  const settlement = await settleRuntimePublication(
    { ...fields, ...candidate },
    deps,
  );
  if (settlement.status === "settled") {
    return {
      confirmed: true,
      publicReceipt: { ...publicReceipt, status: "confirmed" },
    };
  }
  if (settlement.status === "claimed") {
    return {
      confirmed: true,
      existingQueueId: settlement.queueId,
      publicReceipt: { ...publicReceipt, status: "confirmed" },
    };
  }
  return { confirmed: false, publicReceipt };
}

module.exports = {
  ACTIVE_RUNTIME_SURFACES,
  runtimeCandidate,
  waitForExactRuntimeReceipt,
  settleRuntimePublication,
  tryRuntimePublication,
};
