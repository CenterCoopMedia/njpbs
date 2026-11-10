export type PreviewPairWakeBinding = { wake(rendererSha: string): Promise<void> };

/** Only an authenticated Functions acceptance response supplies this identity.
 * Service bindings are fixed operator configuration, never viewer input/URLs.
 */
export async function wakePreviewPair(identity: { pairId: string; rendererSha: string },
  retainedBindings: ReadonlyMap<string, PreviewPairWakeBinding>): Promise<void> {
  if (!/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(identity.pairId) || !/^[a-f0-9]{40}$/.test(identity.rendererSha)) {
    throw new Error("Invalid preview pair wake identity");
  }
  const binding = retainedBindings.get(identity.pairId);
  if (!binding) throw new Error("Preview pair binding unavailable");
  await binding.wake(identity.rendererSha);
}
