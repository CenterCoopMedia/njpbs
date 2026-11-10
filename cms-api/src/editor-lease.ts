// The Boardwalk editing lease for an automated change (#4716, #4717). cms-api writes the same
// cmsEditorLocks document the editor writes, through the Firestore REST API with the caller's
// own ID token, so firestore.rules decide every claim and release. cms-api holds no Firestore
// credential. One request holds the lease for one save, well inside the 120 second window.

const LEASE_MS = 120_000;
const SESSION_PREFIX = "content-api-";

type Fetcher = typeof fetch;

export interface LeaseHolder {
  ownerName: string;
  ageSeconds: number;
}

export type LeaseClaim =
  | { status: "acquired"; sessionId: string }
  | { status: "held"; holder: LeaseHolder };

export class LeaseUnavailable extends Error {}

export interface LeaseTarget {
  projectId: string;
  token: string;
  uid: string;
  ownerName: string;
  collection: "cmsPages" | "cmsPosts";
  id: string;
  fetcher: Fetcher;
  nowMs: number;
  sessionId: string;
}

const database = (projectId: string) => `projects/${projectId}/databases/(default)`;
const lockName = (target: Pick<LeaseTarget, "projectId" | "collection" | "id">) =>
  `${database(target.projectId)}/documents/cmsEditorLocks/${target.collection}:${target.id}`;

export function newLeaseSessionId(randomUUID: () => string): string {
  return `${SESSION_PREFIX}${randomUUID()}`;
}

function headers(token: string): HeadersInit {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

function stringFields(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { stringValue: value }]));
}

interface StoredLease {
  updateTime: string;
  fields: Record<string, { stringValue?: string; timestampValue?: string }>;
}

// Every transport or reply failure is LeaseUnavailable, which the route reports as 503.
async function leaseFetch(target: LeaseTarget, url: string, init: RequestInit): Promise<Response> {
  try {
    return await target.fetcher(url, init);
  } catch {
    throw new LeaseUnavailable("lease request failed");
  }
}

async function readLease(target: LeaseTarget): Promise<StoredLease | null> {
  const response = await leaseFetch(target, `https://firestore.googleapis.com/v1/${lockName(target)}`, {
    headers: headers(target.token),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new LeaseUnavailable(`lease read ${response.status}`);
  try {
    return await response.json() as StoredLease;
  } catch {
    throw new LeaseUnavailable("lease read unreadable");
  }
}

async function commit(target: LeaseTarget, write: Record<string, unknown>): Promise<boolean> {
  const response = await leaseFetch(target, `https://firestore.googleapis.com/v1/${database(target.projectId)}/documents:commit`, {
    method: "POST",
    headers: headers(target.token),
    body: JSON.stringify({ writes: [write] }),
  });
  // A moved lease fails its precondition; the caller reads again and reports the holder.
  if (response.status === 409 || response.status === 400 || response.status === 412) return false;
  if (!response.ok) throw new LeaseUnavailable(`lease write ${response.status}`);
  return true;
}

function holder(lease: StoredLease, nowMs: number): LeaseHolder | null {
  const fields = lease.fields ?? {};
  if (fields.releasedAt) return null;
  const heartbeat = Date.parse(fields.heartbeatAt?.timestampValue ?? "");
  if (!Number.isFinite(heartbeat) || nowMs - heartbeat >= LEASE_MS) return null;
  return {
    ownerName: fields.ownerName?.stringValue ?? "Another editor",
    ageSeconds: Math.max(0, Math.round((nowMs - Date.parse(fields.acquiredAt?.timestampValue ?? "")) / 1000)) || 0,
  };
}

/**
 * Claim the lease when it is absent, released, expired, or already this request's session. A
 * live lease held by anyone else, including another request of the same account, is reported,
 * never taken: a person may have unsaved work open, and another request may be publishing.
 */
export async function claimLease(target: LeaseTarget): Promise<LeaseClaim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await readLease(target);
    const live = lease ? holder(lease, target.nowMs) : null;
    const own = lease?.fields?.ownerId?.stringValue === target.uid &&
      lease?.fields?.sessionId?.stringValue === target.sessionId;
    if (live && !own) return { status: "held", holder: live };
    const transforms = [
      { fieldPath: "acquiredAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "heartbeatAt", setToServerValue: "REQUEST_TIME" },
      // The rules let an owner replace its own live lease only as a takeover of itself.
      ...(live && own ? [{ fieldPath: "takeoverAt", setToServerValue: "REQUEST_TIME" }] : []),
    ];
    const written = await commit(target, {
      update: {
        name: lockName(target),
        fields: stringFields({
          surfaceKey: `${target.collection}:${target.id}`,
          contentCollection: target.collection,
          contentId: target.id,
          ownerId: target.uid,
          ownerName: target.ownerName,
          sessionId: target.sessionId,
        }),
      },
      updateTransforms: transforms,
      currentDocument: lease ? { updateTime: lease.updateTime } : { exists: false },
    });
    if (written) return { status: "acquired", sessionId: target.sessionId };
  }
  const lease = await readLease(target);
  const live = lease ? holder(lease, target.nowMs) : null;
  if (live) return { status: "held", holder: live };
  throw new LeaseUnavailable("lease claim refused");
}

/**
 * Move the heartbeat of this exact owner and session forward. False means the lease is gone:
 * released, or claimed by someone else after it expired.
 */
export async function renewLease(target: LeaseTarget): Promise<boolean> {
  // A failed precondition only means the document moved; read again before deciding.
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = await readLease(target);
    const fields = lease?.fields ?? {};
    if (!lease || fields.releasedAt || fields.ownerId?.stringValue !== target.uid ||
        fields.sessionId?.stringValue !== target.sessionId) {
      return false;
    }
    const written = await commit(target, {
      transform: {
        document: lockName(target),
        fieldTransforms: [{ fieldPath: "heartbeatAt", setToServerValue: "REQUEST_TIME" }],
      },
      currentDocument: { updateTime: lease.updateTime },
    });
    if (written) return true;
  }
  return false;
}

/** Write the release marker. The rules accept it only from this exact owner and session. */
export async function releaseLease(target: LeaseTarget): Promise<void> {
  await commit(target, {
    update: {
      name: lockName(target),
      fields: stringFields({
        surfaceKey: `${target.collection}:${target.id}`,
        contentCollection: target.collection,
        contentId: target.id,
        ownerId: target.uid,
        sessionId: target.sessionId,
      }),
    },
    updateTransforms: [{ fieldPath: "releasedAt", setToServerValue: "REQUEST_TIME" }],
    currentDocument: { exists: true },
  });
}
