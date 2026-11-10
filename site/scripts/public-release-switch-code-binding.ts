import type { createPublicReleasePairExecutor } from "./public-release-pair-executor";
import type { createPublicReleaseSwitchCodeContinuation } from "./public-release-switch-code-continuation";

/** Preserve the original executor object and all its publication/preview/
 * original-recovery bindings when the explicit CODE mode is absent. */
export function bindPublicReleaseSwitchCodeContinuation({ executor, continuation }: {
  executor: ReturnType<typeof createPublicReleasePairExecutor>;
  continuation: ReturnType<typeof createPublicReleaseSwitchCodeContinuation>;
}) {
  if (!continuation.beforePoll && !continuation.completed && !continuation.retryCompleted) return executor;
  return { ...executor,
    beforePoll: async (input: { signal?: AbortSignal }) => {
      await executor.beforePoll?.(input); await continuation.beforePoll?.(input);
    },
    stage: async (input: Parameters<typeof executor.stage>[0]) => {
      await executor.stage(input); await continuation.completed?.(input);
    },
    retryQuarantined: async (taskId: string, signal?: AbortSignal) => {
      await executor.retryQuarantined(taskId, signal);
      await continuation.retryCompleted?.(taskId, signal);
    } };
}
