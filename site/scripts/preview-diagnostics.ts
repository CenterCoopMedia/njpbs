import { createRequire } from "node:module";
const { PREVIEW_STAGES, previewTimings, previewStartup } = createRequire(import.meta.url)("../../functions/lib/preview-timings.js");
const STAGES = new Set(PREVIEW_STAGES);
export type PreviewStartup = { startupId: string; processStartedAtMs: number; timingsMs: Record<string, number> };

/** Observe private processing without serializing input, credentials or errors.
 * Logging is optional evidence and must never change a job's result.
 */
export function previewDiagnostics(identity: { rendererSha: string; queueId?: string; serializerId?: string; requestId?: string;
  startupId?: string; processStartedAtMs?: number },
  write: (line: string) => void = line => console.log(line),
  now: () => number = () => performance.now()) {
  const rendererSha = /^[a-f0-9]{40}$/.test(identity.rendererSha) ? identity.rendererSha : null;
  const queueId = identity.queueId && /^[A-Za-z0-9]{20}$/.test(identity.queueId) ? identity.queueId : null;
  const enabled = rendererSha !== null && (identity.queueId === undefined || queueId !== null);
  const durations: Record<string, number> = {};
  const startup = previewStartup(identity);
  const serializerId = typeof identity.serializerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(identity.serializerId)
    ? identity.serializerId : undefined;
  const requestId = typeof identity.requestId === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity.requestId)
    ? identity.requestId : undefined;
  function emit(stage: string, phase: "start" | "end", outcome?: "ok" | "error", durationMs?: number) {
    try {
      if (!enabled || !STAGES.has(stage)) return;
      if (phase === "end" && typeof durationMs === "number" && Number.isFinite(durationMs)) {
        durations[stage] = Math.min(86_400_000, (durations[stage] ?? 0) + Math.max(0, Math.round(durationMs)));
      }
      write(JSON.stringify({ event: "cms_preview_stage", rendererSha,
        atMs: Date.now(), ...(serializerId ? { serializerId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(startup ? { startupId: startup.startupId, processStartedAtMs: startup.processStartedAtMs } : {}),
        scope: queueId ? "job" : "startup", ...(queueId ? { queueId } : {}),
        stage, phase, ...(outcome ? { outcome } : {}),
        ...(typeof durationMs === "number" && Number.isFinite(durationMs)
          ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}) }));
    } catch { /* A failed diagnostic sink cannot fail accepted work. */ }
  }
  function clock() {
    try { return now(); } catch { return Number.NaN; }
  }
  async function measure<T>(stage: string, run: () => T): Promise<Awaited<T>> {
    const start = clock();
    emit(stage, "start");
    try {
      const value = await run();
      emit(stage, "end", "ok", clock() - start);
      return value;
    } catch (error) {
      emit(stage, "end", "error", clock() - start);
      throw error;
    }
  }
  return Object.assign(measure, { timings: () => previewTimings(durations) as Record<string, number> });
}
