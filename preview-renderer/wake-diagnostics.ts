const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Numeric, private tracing only. Never serialize provider errors or inputs. */
export function wakeDiagnostics(env: { PREVIEW_RENDERER_SHA: string; PREVIEW_SERIALIZER_ID: string }, requestId?: string) {
  const trace = typeof requestId === "string" && UUID.test(requestId) ? requestId : crypto.randomUUID();
  const enabled = /^[a-f0-9]{40}$/.test(env.PREVIEW_RENDERER_SHA) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(env.PREVIEW_SERIALIZER_ID);
  function emit(stage: string, phase: string, outcome?: string, durationMs?: number, result?: unknown) {
    try {
      if (!enabled) return;
      const startup = (result as { startup?: { startupId?: unknown; processStartedAtMs?: unknown } })?.startup;
      const startupId = typeof startup?.startupId === "string" && UUID.test(startup.startupId) ? startup.startupId : undefined;
      const processStartedAtMs = startup?.processStartedAtMs;
      console.log(JSON.stringify({ event: "cms_preview_wake_stage", requestId: trace,
        rendererSha: env.PREVIEW_RENDERER_SHA, serializerId: env.PREVIEW_SERIALIZER_ID,
        atMs: Date.now(), stage, phase, ...(outcome ? { outcome, durationMs } : {}),
        ...(startupId && Number.isSafeInteger(processStartedAtMs) ? { startupId, processStartedAtMs } : {}) }));
    } catch { /* Diagnostic sinks cannot change accepted work. */ }
  }
  async function measure<T>(stage: "wake" | "pair-authority" | "pending-work" | "container-request", run: () => T): Promise<Awaited<T>> {
    const start = performance.now();
    emit(stage, "start");
    try {
      const result = await run();
      emit(stage, "end", "ok", Math.max(0, Math.round(performance.now() - start)), result);
      return result;
    } catch (error) {
      emit(stage, "end", "error", Math.max(0, Math.round(performance.now() - start)));
      throw error;
    }
  }
  return Object.assign(measure, { requestId: trace });
}
