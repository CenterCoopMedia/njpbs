import { setTimeout as sleep } from 'node:timers/promises';

// Cloudflare documents that deployment propagation takes up to a few seconds.
// https://developers.cloudflare.com/workers/versions-and-deployments/version-skew/
const propagationMs = 5_000;
const sampleMs = 500;
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

export class CmsApiReadbackError extends Error {}

export async function waitForWorkerReadback(collect, { now = () => performance.now(), wait = sleep } = {}) {
  const deadline = now() + propagationMs;
  for (;;) {
    try {
      return await collect();
    } catch (error) {
      if (!(error instanceof WorkerReadbackMismatch) || deadline - now() <= sampleMs) throw error;
      await wait(sampleMs);
      if (now() >= deadline) throw error;
    }
  }
}

export async function readCmsApiDeployment(script, readDeployment, expected, clock) {
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
    if (expected && active?.version_id !== expected) {
      throw new WorkerReadbackMismatch("CMS API versionId", expected, versionId.test(active?.version_id ?? "") ? active.version_id : null);
    }
    if (active?.percentage !== 100 || !versionId.test(active.version_id ?? "")) {
      if (expected) throw new WorkerReadbackMismatch("CMS API traffic percentage", 100, Number.isFinite(active?.percentage) ? active.percentage : null);
      throw new CmsApiReadbackError("CMS API version identity is invalid");
    }
    return { script, deploymentId: id, versionId: active.version_id };
  };
  return expected ? waitForWorkerReadback(collect, clock) : collect();
}
