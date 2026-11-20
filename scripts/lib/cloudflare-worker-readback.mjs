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

export async function waitForWorkerReadback(collect, { now = () => performance.now(), wait = sleep } = {}) {
  const deadline = now() + propagationMs;
  let mismatch;
  for (;;) {
    const remaining = Math.ceil(deadline - now());
    if (mismatch && remaining <= 0) throw mismatch;
    const signal = AbortSignal.timeout(Math.max(1, remaining));
    try {
      return await collect(signal);
    } catch (error) {
      if (!(error instanceof WorkerReadbackMismatch)) {
        if (signal.aborted && mismatch) throw mismatch;
        throw error;
      }
      mismatch = error;
    }
    if (deadline - now() <= sampleMs) throw mismatch;
    await wait(sampleMs);
  }
}
