// One SQLite Durable Object owns the form-wide budget and every IP lease.
// Keeping all checks in one object makes admission atomic across requests.
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const UPLOAD_LEASE_MS = 15 * 60 * 1000;
// Match the origin's slow-transfer grace: URL expiry limits PUT start time,
// so absent uploading records get another hour before storage is fenced.
export const UPLOAD_TRANSFER_GRACE_MS = HOUR_MS;
export const IP_STARTS_PER_HOUR = 3;
export const FORM_STARTS_PER_DAY = 100;
export const FORM_BYTES_PER_DAY = 2 * 1024 * 1024 * 1024;
export const MAX_COMPLETION_ATTEMPTS = 3;
// The origin Function has a 540-second timeout. Keep its claim for ten minutes.
export const COMPLETION_LEASE_MS = 10 * 60 * 1000;
export const STARTS_SCHEMA = `CREATE TABLE IF NOT EXISTS starts (
  request_id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  expires_at INTEGER NOT NULL,
  submission_id TEXT,
  charged_at INTEGER,
  reconcile_until INTEGER
)`;
export const COMPLETIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS completions (
  request_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL,
  in_flight INTEGER NOT NULL,
  lease_until INTEGER
)`;

type SqlValue = string | number | null | ArrayBuffer;

export interface SqlStore {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): Iterable<T>;
}

export function initializeLimiter(sql: SqlStore): void {
  sql.exec(STARTS_SCHEMA);
  sql.exec(COMPLETIONS_SCHEMA);
  const columns = [...sql.exec<{ name: string }>("PRAGMA table_info(completions)")];
  if (!columns.some((column) => column.name === "lease_until")) {
    sql.exec("ALTER TABLE completions ADD COLUMN lease_until INTEGER");
  }
  const startColumns = [...sql.exec<{ name: string }>("PRAGMA table_info(starts)")];
  if (!startColumns.some((column) => column.name === "charged_at")) {
    sql.exec("ALTER TABLE starts ADD COLUMN charged_at INTEGER");
    // Old terminal claims did not distinguish success from rejection. Retain
    // their charge for that day; uncompleted reservations can be reconciled.
    sql.exec(`UPDATE starts SET charged_at = accepted_at WHERE EXISTS (
      SELECT 1 FROM completions WHERE completions.request_id = starts.request_id
        AND in_flight = 1 AND lease_until IS NULL)`);
  }
  if (!startColumns.some((column) => column.name === "reconcile_until")) {
    sql.exec("ALTER TABLE starts ADD COLUMN reconcile_until INTEGER");
  }
}

export interface ExpiredReservation {
  requestId: string;
  ipHash: string;
  submissionId: string;
}

interface StartRow {
  [key: string]: SqlValue;
  request_id: string;
  ip_hash: string;
  bytes: number;
  created_at: number;
  accepted_at: number | null;
  expires_at: number;
}

export type LimitAction =
  | { action: "reserve"; requestId: string; ipHash: string; bytes: number; now: number }
  | { action: "accept"; requestId: string; ipHash: string; submissionId: string; now: number }
  | { action: "claim_complete"; requestId: string; ipHash: string; submissionId: string; now: number }
  | { action: "retry_complete"; requestId: string; ipHash: string; submissionId: string; attempt: number; now: number }
  | { action: "complete"; requestId: string; ipHash: string; submissionId: string; attempt?: number; releaseSlot?: boolean; uploaded?: boolean; now: number }
  | { action: "claim_reconcile"; requestId: string; ipHash: string; submissionId: string; now: number }
  | { action: "reconcile"; requestId: string; ipHash: string; submissionId: string; leaseUntil: number; bytes: number; now: number }
  | { action: "cancel"; requestId: string; ipHash: string; now: number };

export type LimitResult =
  | { allowed: true; existing?: boolean; completion?: { attempt: number; leaseUntil: number }; reconciliation?: { leaseUntil: number } }
  | { allowed: false; retryAfter: number; reservations?: ExpiredReservation[] }
  | { allowed: false; error: "expired" };

function retrySeconds(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

// Stored bytes count on the day the origin confirms them. Expired accepted
// reservations retain their charge until the origin checks or fences storage.
function byteAdmission(sql: SqlStore, bytes: number, now: number, exclude = ""): LimitResult {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const charges = [...sql.exec<{ bytes: number; until: number }>(`
    SELECT bytes, CASE WHEN charged_at IS NOT NULL THEN ?
      WHEN accepted_at IS NOT NULL THEN MAX(accepted_at + ?, expires_at, COALESCE(reconcile_until, 0), ?)
      ELSE expires_at END AS until
    FROM starts WHERE request_id != ? AND (charged_at >= ? OR (charged_at IS NULL AND (accepted_at IS NOT NULL OR expires_at > ?)))`,
    dayStart + DAY_MS, UPLOAD_LEASE_MS + UPLOAD_TRANSFER_GRACE_MS, now + 1000, exclude, dayStart, now,
  )];
  let total = bytes + charges.reduce((sum, row) => sum + row.bytes, 0);
  if (total <= FORM_BYTES_PER_DAY) return { allowed: true };
  charges.sort((a, b) => a.until - b.until);
  for (const row of charges) {
    total -= row.bytes;
    if (total <= FORM_BYTES_PER_DAY) return { allowed: false, retryAfter: retrySeconds(row.until, now) };
  }
  return { allowed: false, retryAfter: retrySeconds(dayStart + DAY_MS, now) };
}

function expiredReservations(sql: SqlStore, now: number): ExpiredReservation[] {
  return [...sql.exec<{ request_id: string; ip_hash: string; submission_id: string }>(`
    SELECT request_id, ip_hash, submission_id FROM starts
    WHERE charged_at IS NULL AND accepted_at IS NOT NULL AND expires_at <= ?
      AND (accepted_at + ? <= ? OR EXISTS (SELECT 1 FROM completions
        WHERE completions.request_id = starts.request_id AND in_flight = 1 AND lease_until IS NULL))
      AND (reconcile_until IS NULL OR reconcile_until <= ?)
      AND NOT EXISTS (SELECT 1 FROM completions WHERE completions.request_id = starts.request_id
        AND in_flight = 1 AND lease_until > ?)
    LIMIT 4`, now, UPLOAD_LEASE_MS + UPLOAD_TRANSFER_GRACE_MS, now, now, now,
  )].map((row) => ({ requestId: row.request_id, ipHash: row.ip_hash, submissionId: row.submission_id }));
}

function reconcileReservation(sql: SqlStore, input: Extract<LimitAction, { action: "claim_reconcile" | "reconcile" }>): LimitResult {
  const { requestId, ipHash, submissionId, now } = input;
  const row = [...sql.exec<{ reconcile_until: number | null }>(`SELECT reconcile_until FROM starts
    WHERE request_id = ? AND ip_hash = ? AND submission_id = ? AND charged_at IS NULL
      AND accepted_at IS NOT NULL AND expires_at <= ?
      AND (accepted_at + ? <= ? OR EXISTS (SELECT 1 FROM completions
        WHERE completions.request_id = starts.request_id AND in_flight = 1 AND lease_until IS NULL))
      AND NOT EXISTS (SELECT 1 FROM completions WHERE completions.request_id = starts.request_id
        AND in_flight = 1 AND lease_until > ?)`, requestId, ipHash, submissionId, now, UPLOAD_LEASE_MS + UPLOAD_TRANSFER_GRACE_MS, now, now,
  )][0];
  if (!row) return { allowed: false, error: "expired" };
  if (input.action === "claim_reconcile") {
    if (row.reconcile_until !== null && row.reconcile_until > now) {
      return { allowed: false, retryAfter: retrySeconds(row.reconcile_until, now) };
    }
    const leaseUntil = now + COMPLETION_LEASE_MS;
    sql.exec("UPDATE starts SET reconcile_until = ? WHERE request_id = ?", leaseUntil, requestId);
    return { allowed: true, reconciliation: { leaseUntil } };
  }
  if (row.reconcile_until !== input.leaseUntil || input.leaseUntil <= now) return { allowed: false, error: "expired" };
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) throw new TypeError("Invalid stored bytes");
  sql.exec("UPDATE starts SET bytes = ?, charged_at = ?, reconcile_until = NULL WHERE request_id = ?", input.bytes, now, requestId);
  if (input.bytes === 0) {
    // A storage fence makes this reservation terminal; its old PUT cannot reopen it.
    sql.exec(`INSERT INTO completions (request_id, submission_id, attempts, in_flight, lease_until)
      VALUES (?, ?, ?, 1, NULL) ON CONFLICT (request_id) DO UPDATE SET in_flight = 1, lease_until = NULL`,
      requestId, submissionId, MAX_COMPLETION_ATTEMPTS);
  }
  return { allowed: true };
}

function claimCompletion(sql: SqlStore, input: Extract<LimitAction, { action: "claim_complete" }>): LimitResult {
  const { requestId, ipHash, now } = input;
  if (!input.submissionId) throw new TypeError("Missing submission id");
  const reservation = [...sql.exec<{ request_id: string; bytes: number; reconcile_until: number | null }>(`
    SELECT request_id, bytes, reconcile_until FROM starts
    WHERE request_id = ? AND ip_hash = ? AND submission_id = ? AND accepted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM completions WHERE submission_id = ? AND request_id != ?)`,
    requestId, ipHash, input.submissionId, input.submissionId, requestId,
  )][0];
  if (!reservation) {
    const retained = [...sql.exec<{ request_id: string }>(
      "SELECT request_id FROM starts WHERE request_id = ? OR submission_id = ?", requestId, input.submissionId,
    )][0];
    return retained ? { allowed: false, retryAfter: 1 } : { allowed: false, error: "expired" };
  }
  if (reservation.reconcile_until !== null && reservation.reconcile_until > now) {
    return { allowed: false, retryAfter: retrySeconds(reservation.reconcile_until, now) };
  }
  const previous = [...sql.exec<{ attempts: number; in_flight: number; lease_until: number | null }>(
    "SELECT attempts, in_flight, lease_until FROM completions WHERE request_id = ?", requestId,
  )][0];
  // A null lease on an in-flight row means a terminal outcome (including legacy rows).
  if (previous?.in_flight === 1 && previous.lease_until === null) return { allowed: false, error: "expired" };
  if (previous?.in_flight === 1 && previous.lease_until! > now) {
    return { allowed: false, retryAfter: retrySeconds(previous.lease_until!, now) };
  }
  if (previous && previous.attempts >= MAX_COMPLETION_ATTEMPTS) return { allowed: false, error: "expired" };
  // An upload can finish after its URL expires. Reacquire its byte hold before
  // origin work so expiry cannot let late completions exceed the global cap.
  const admission = byteAdmission(sql, reservation.bytes, now, requestId);
  if (!admission.allowed) return admission;
  const attempt = (previous?.attempts ?? 0) + 1;
  const leaseUntil = now + COMPLETION_LEASE_MS;
  sql.exec("UPDATE starts SET expires_at = MAX(expires_at, ?) WHERE request_id = ?", leaseUntil, requestId);
  // Synchronous SQL in this object consumes admission before origin I/O.
  sql.exec(`INSERT INTO completions (request_id, submission_id, attempts, in_flight, lease_until) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT (request_id) DO UPDATE SET attempts = excluded.attempts, in_flight = 1, lease_until = excluded.lease_until`,
    requestId, input.submissionId, attempt, leaseUntil);
  return { allowed: true, completion: { attempt, leaseUntil } };
}

function settleCompletion(sql: SqlStore, input: Extract<LimitAction, { action: "retry_complete" | "complete" }>): LimitResult {
  const { requestId, ipHash, now } = input;
  if (input.action === "retry_complete") {
    sql.exec(`UPDATE completions SET in_flight = 0, lease_until = NULL
      WHERE request_id = ? AND submission_id = ? AND attempts = ? AND in_flight = 1 AND lease_until > ?
        AND EXISTS (SELECT 1 FROM starts WHERE request_id = ? AND ip_hash = ? AND submission_id = ?)`,
      requestId, input.submissionId, input.attempt, now, requestId, ipHash, input.submissionId);
    return { allowed: true };
  }
  if (!input.submissionId) throw new TypeError("Missing submission id");
  if (input.attempt !== undefined) {
    const claim = [...sql.exec<{ request_id: string }>(`SELECT request_id FROM completions
      WHERE request_id = ? AND submission_id = ? AND attempts = ? AND in_flight = 1 AND lease_until > ?
        AND EXISTS (SELECT 1 FROM starts WHERE request_id = ? AND ip_hash = ? AND submission_id = ?)`,
      requestId, input.submissionId, input.attempt, now, requestId, ipHash, input.submissionId,
    )][0];
    if (!claim) return { allowed: false, error: "expired" };
    sql.exec("UPDATE completions SET lease_until = NULL WHERE request_id = ?", requestId);
  }
  // Success confirms the declared size. Refusals retain their charge until
  // storage reconciliation has fenced an absent object or measured stored bytes.
  if (input.uploaded === true) {
    sql.exec(`UPDATE starts SET charged_at = COALESCE(charged_at, ?)
      WHERE request_id = ? AND ip_hash = ? AND submission_id = ? AND accepted_at IS NOT NULL`,
      now, requestId, ipHash, input.submissionId);
  }
  if (input.releaseSlot === false) return { allowed: true };
  if (input.uploaded !== true) {
    sql.exec("UPDATE starts SET charged_at = NULL WHERE request_id = ? AND ip_hash = ? AND submission_id = ?",
      requestId, ipHash, input.submissionId);
  }
  sql.exec(
    "UPDATE starts SET expires_at = ? WHERE request_id = ? AND ip_hash = ? AND submission_id = ? AND accepted_at IS NOT NULL",
    now, requestId, ipHash, input.submissionId,
  );
  return { allowed: true };
}

export function applyLimit(sql: SqlStore, input: LimitAction): LimitResult {
  const { requestId, ipHash, now } = input;
  if (!Number.isSafeInteger(now) || now < 0 || !/^[0-9a-f]{32}$/.test(ipHash) || !requestId) {
    throw new TypeError("Invalid rate limit input");
  }

  if (input.action === "accept") {
    if (!input.submissionId) throw new TypeError("Missing submission id");
    const reserved = [...sql.exec<StartRow>(
      "SELECT request_id, ip_hash, bytes, created_at, accepted_at, expires_at FROM starts WHERE request_id = ? AND ip_hash = ?",
      requestId, ipHash,
    )][0];
    if (!reserved) return { allowed: false, retryAfter: 1 };
    sql.exec(
      "UPDATE starts SET accepted_at = COALESCE(accepted_at, ?), submission_id = COALESCE(submission_id, ?) WHERE request_id = ? AND ip_hash = ?",
      now, input.submissionId, requestId, ipHash,
    );
    return { allowed: true };
  }
  if (input.action === "cancel") {
    sql.exec("DELETE FROM starts WHERE request_id = ? AND ip_hash = ? AND accepted_at IS NULL", requestId, ipHash);
    return { allowed: true };
  }
  if (input.action === "claim_reconcile" || input.action === "reconcile") return reconcileReservation(sql, input);
  if (input.action === "claim_complete") return claimCompletion(sql, input);
  if (input.action === "retry_complete" || input.action === "complete") return settleCompletion(sql, input);

  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
    throw new TypeError("Invalid declared bytes");
  }
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const hourStart = now - HOUR_MS;
  sql.exec("DELETE FROM starts WHERE accepted_at IS NULL AND expires_at <= ?", now);
  // Accepted holds survive day rollover until storage reconciliation settles
  // their bytes. Age alone cannot prove an upload is absent or fence a late PUT.
  sql.exec(`DELETE FROM starts WHERE accepted_at < ? AND expires_at <= ?
    AND charged_at < ?
    AND (reconcile_until IS NULL OR reconcile_until <= ?)
    AND NOT EXISTS (SELECT 1 FROM completions WHERE completions.request_id = starts.request_id
      AND in_flight = 1 AND lease_until > ?)`, Math.min(dayStart, hourStart), now, dayStart, now, now);
  sql.exec("DELETE FROM completions WHERE request_id NOT IN (SELECT request_id FROM starts)");
  const rows = [...sql.exec<StartRow>(
    "SELECT request_id, ip_hash, bytes, created_at, accepted_at, expires_at FROM starts",
  )];

  const existing = rows.find((row) => row.request_id === requestId);
  if (existing) {
    // A retry with the same request ID may recover a lost Function response.
    // Keep the same reservation and let the Function handle idempotency.
    if (existing.ip_hash === ipHash) return { allowed: true, existing: true };
    return { allowed: false, retryAfter: retrySeconds(existing.expires_at, now) };
  }

  const hourlyUntil: number[] = [];
  let daily = 0;
  let retryAt = 0;
  for (const row of rows) {
    const pending = row.accepted_at === null;
    const countedAt = pending ? row.created_at : row.accepted_at!;
    if (row.ip_hash === ipHash && row.expires_at > now) {
      retryAt = Math.max(retryAt, row.expires_at);
    }
    if (row.ip_hash === ipHash && countedAt >= hourStart) {
      hourlyUntil.push(pending ? Math.min(row.expires_at, countedAt + HOUR_MS) : countedAt + HOUR_MS);
    }
    if (countedAt >= dayStart) {
      daily++;
    }
  }
  if (hourlyUntil.length >= IP_STARTS_PER_HOUR) {
    hourlyUntil.sort((a, b) => a - b);
    retryAt = Math.max(retryAt, hourlyUntil[hourlyUntil.length - IP_STARTS_PER_HOUR]);
  }
  if (daily >= FORM_STARTS_PER_DAY) {
    retryAt = Math.max(retryAt, dayStart + DAY_MS);
  }
  const byteLimit = byteAdmission(sql, input.bytes, now);
  if (!byteLimit.allowed && "retryAfter" in byteLimit) retryAt = Math.max(retryAt, now + byteLimit.retryAfter * 1000);
  if (retryAt > now) {
    const reservations = !byteLimit.allowed ? expiredReservations(sql, now) : [];
    return { allowed: false, retryAfter: retrySeconds(retryAt, now), ...(reservations.length ? { reservations } : {}) };
  }

  sql.exec(
    "INSERT INTO starts (request_id, ip_hash, bytes, created_at, accepted_at, expires_at, submission_id) VALUES (?, ?, ?, ?, NULL, ?, NULL)",
    requestId, ipHash, input.bytes, now, now + UPLOAD_LEASE_MS,
  );
  return { allowed: true };
}
