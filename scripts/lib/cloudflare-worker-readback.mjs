import releaseWait from '../../functions/lib/release-wait.js';

const { waitFor } = releaseWait;
const versionId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function wranglerVersion(stdout) {
  const value = /Current Version ID:\s*([a-f0-9-]{36})(?:\s|$)/.exec(stdout)?.[1];
  return versionId.test(value ?? '') ? value : null;
}

export class WorkerReadbackMismatch extends Error {
  constructor(check, expected, actual) {
    super(`${check}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`);
  }
}

export function requireWorkerReadback(condition, field) {
  if (!condition) throw new WorkerReadbackMismatch(field, 'confirmed write', 'different or missing');
}

// Cloudflare's own record settled the readback against us: a newer deployment
// that is not ours replaced it, or the write call itself answered with a final
// error. Neither clears on a later read.
export class WorkerReadbackFinal extends Error {}

// Cloudflare never changes a Worker version or a deployment record. Once the
// exact one is read, a wrong field in it cannot clear on a later read.
export function requireImmutableReadback(condition, field) {
  if (!condition) throw new WorkerReadbackFinal(`${field}: the exact immutable record differs from the confirmed write`);
}

// Deployments are listed newest first. `versionId` alone and at 100 percent in
// the newest one is active; a mixed deployment of it is an exact record, and one
// below the newest was superseded. Absent, it may still appear.
export function requireActiveVersion(rows, versionId, field) {
  const versions = row => Array.isArray(row?.versions) ? row.versions : [];
  const holds = row => versions(row).some(version => version?.version_id === versionId);
  const top = Array.isArray(rows) ? rows[0] : undefined;
  if (holds(top)) {
    requireImmutableReadback(versions(top).length === 1 && versions(top)[0].percentage === 100, field);
    return;
  }
  if (Array.isArray(rows) && rows.slice(1).some(holds)) throw new WorkerReadbackFinal(`${field}: version ${versionId} was superseded`);
  throw new WorkerReadbackMismatch(field, versionId, versionId === undefined ? null : "another version or none");
}

// The provider answered a write with a refusal (HTTP 4xx other than 408 and
// 429), so nothing from that call will appear in a readback.
export class WorkerWriteRefused extends WorkerReadbackFinal {}

// Deployments are listed newest first. Ours below the top, or a top row created
// after ours, means a newer deployment that is not ours replaced it.
export function requireNotSuperseded(rows, ours, field) {
  if (!Array.isArray(rows) || !rows.length || typeof ours?.id !== 'string' || rows[0]?.id === ours.id) return;
  if (rows.findIndex(row => row?.id === ours.id) > 0 || Date.parse(rows[0]?.created_on) > Date.parse(ours.created_on)) {
    throw new WorkerReadbackFinal(`${field}: deployment ${ours.id} was superseded by ${String(rows[0]?.id).slice(0, 80)}`);
  }
}

export class CmsApiReadbackError extends Error {}

// Cloudflare documents that deployment propagation takes a few seconds; a
// mismatch is read again until the confirmed write shows or Cloudflare's record
// settles it (WorkerReadbackFinal). The wait names its check once a minute.
// https://developers.cloudflare.com/workers/versions-and-deployments/version-skew/
export async function waitForWorkerReadback(collect, { signal } = {}) {
  return waitFor('Cloudflare Worker readback', async () => {
    try {
      return { done: await collect() };
    } catch (error) {
      if (error instanceof WorkerReadbackFinal || error?.immutable === true) return { failed: error };
      if (!(error instanceof WorkerReadbackMismatch)) throw error;
      return { pending: error.message };
    }
  }, { signal });
}

export async function readCmsApiDeployment(script, readDeployment, expected) {
  if (expected !== undefined && !versionId.test(expected)) throw new CmsApiReadbackError("Expected CMS API versionId is invalid");
  const collect = async () => {
    const body = await readDeployment();
    if (body?.success === false) throw new CmsApiReadbackError("CMS API deployment identity could not be read");
    const deployment = body?.result?.deployments?.[0] ?? body?.result?.[0];
    const id = deployment?.id;
    const versions = deployment?.versions;
    const active = Array.isArray(versions) && versions.length === 1 ? versions[0] : null;
    if (typeof id !== "string" || id.length === 0 || id.length > 80) {
      if (expected) throw new WorkerReadbackMismatch("CMS API deploymentId", "valid deployment identity", "missing or invalid");
      throw new CmsApiReadbackError("CMS API deployment identity is invalid");
    }
    if (expected) requireActiveVersion(body?.result?.deployments ?? body?.result, expected, "CMS API versionId");
    if (expected && active?.version_id !== expected) {
      throw new WorkerReadbackMismatch("CMS API versionId", expected, versionId.test(active?.version_id ?? "") ? active.version_id : null);
    }
    if (active?.percentage !== 100 || !versionId.test(active.version_id ?? "")) {
      if (expected) throw new WorkerReadbackMismatch("CMS API traffic percentage", 100, Number.isFinite(active?.percentage) ? active.percentage : null);
      throw new CmsApiReadbackError("CMS API version identity is invalid");
    }
    return { script, deploymentId: id, versionId: active.version_id };
  };
  return expected ? waitForWorkerReadback(collect) : collect();
}
