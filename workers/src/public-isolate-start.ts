/** Optional measurement only. No binding, flag or deployment is installed here. */
export type IsolateStartEnvironment = {
  PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED?: string;
  ISOLATE_START_ANALYTICS?: { writeDataPoint(event: { indexes: string[]; blobs: string[]; doubles: number[] }): void };
  CF_VERSION_METADATA?: { id?: string };
};
const SAMPLE_THRESHOLD = Math.floor(0.01 * 2 ** 32);
export const ISOLATE_START_SAMPLE_RATE = SAMPLE_THRESHOLD / 2 ** 32;
let attempted = false;

/** One Bernoulli trial per instrumented module instance, at its first request.
 * The disabled path reads only the flag: no observer object, binding access,
 * random allocation, timer, network work, promise or extra await. */
export function observePublicIsolateStart(env: IsolateStartEnvironment): void {
  try {
    if (env.PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED !== "true" || attempted) return;
    attempted = true;
    const analytics = env.ISOLATE_START_ANALYTICS;
    const version = env.CF_VERSION_METADATA?.id;
    if (!analytics || typeof version !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(version)) return;
    if (crypto.getRandomValues(new Uint32Array(1))[0] >= SAMPLE_THRESHOLD) return;
    analytics.writeDataPoint({ indexes: [version],
      blobs: ["isolate-start-v1", crypto.randomUUID(), version],
      doubles: [1, ISOLATE_START_SAMPLE_RATE, 1 / ISOLATE_START_SAMPLE_RATE] });
  } catch {
    // Measurement can fail or be sampled out; it never changes serving and is
    // never retried on warm requests. There is no acknowledged-delivery claim.
  }
}
