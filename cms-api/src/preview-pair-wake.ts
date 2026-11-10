export type PreviewPairBinding = { wake(rendererSha: string, requestId?: string): Promise<void> };
export type PreviewPairWakeEnvironment = {
  PREVIEW_PAIR_WAKE_ENABLED?: string;
  PREVIEW_PAIR_BINDINGS_JSON?: string;
  PREVIEW_PAIR_OLD?: PreviewPairBinding;
  PREVIEW_PAIR_NEW?: PreviewPairBinding;
};
/** Adapter for layer six's fixed retained bindings. Header identity comes only
 * from authenticated Functions acceptance; no viewer URL or release override. */
export async function wakeAcceptedPreviewPair(env: PreviewPairWakeEnvironment, pairId: string, rendererSha: string, requestId?: string): Promise<void> {
  if (env.PREVIEW_PAIR_WAKE_ENABLED !== "true" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(pairId) || !/^[a-f0-9]{40}$/.test(rendererSha)) {
    throw new Error("Preview pair wake identity was refused");
  }
  const configured: unknown = JSON.parse(env.PREVIEW_PAIR_BINDINGS_JSON ?? "null");
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Preview pair bindings unavailable");
  const entries = Object.entries(configured);
  if (!entries.length || entries.length > 2 || new Set(entries.map(([, name]) => name)).size !== entries.length ||
      entries.some(([id, name]) => !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(id) || !["PREVIEW_PAIR_OLD", "PREVIEW_PAIR_NEW"].includes(String(name)))) {
    throw new Error("Invalid retained preview bindings");
  }
  const bindingName = (configured as Record<string, "PREVIEW_PAIR_OLD" | "PREVIEW_PAIR_NEW">)[pairId];
  // config-input: PREVIEW_PAIR_NEW, PREVIEW_PAIR_OLD
  const binding = bindingName && env[bindingName];
  if (!binding) throw new Error("Retained preview pair unavailable");
  await binding.wake(rendererSha, requestId);
}
