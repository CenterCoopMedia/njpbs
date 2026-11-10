import type { RoutingEvent } from "./public-release-router";

export type RoutingMeasurementEnvironment = {
  PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED?: string;
  PAIR_ROUTING_ANALYTICS?: { writeDataPoint(event: { indexes: string[]; blobs: string[]; doubles: number[] }): void };
  CF_VERSION_METADATA?: { id?: string };
};
/** Private optional measurement. Disabled path touches only the flag, with no
 * random allocation, binding access, timer, network or background work. */
export function createRoutingObserver(env: RoutingMeasurementEnvironment): ((event: RoutingEvent, durationMs?: number) => void) | undefined {
  if (env.PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED !== "true") return;
  const version = env.CF_VERSION_METADATA?.id, analytics = env.PAIR_ROUTING_ANALYTICS;
  if (!version || !analytics) return;
  // Sample an isolate once; count every event in that sample. Request-level
  // sampling would erase the isolate lifetimes and churn being measured.
  if (crypto.getRandomValues(new Uint32Array(1))[0] >= Math.floor(0.01 * 2 ** 32)) return;
  const isolate = crypto.randomUUID(), started = performance.now();
  return (event, durationMs = 0) => {
    try { analytics.writeDataPoint({ indexes: [version], blobs: ["pair-routing-v1", isolate, event],
      doubles: [1, 0.01, performance.now() - started, durationMs] }); }
    catch { /* Measurement failure never changes routing. */ }
  };
}
