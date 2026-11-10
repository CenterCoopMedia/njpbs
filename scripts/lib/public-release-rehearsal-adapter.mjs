/**
 * The only integration boundary for the isolated layer 4/5/6 rehearsal.
 * Complete scenario execution requires every declared operator binding.
 * No production entrypoint imports it. Never substitute simulated receipts.
 *
 * @typedef {import('./public-release-rehearsal.mjs').RehearsalRequest} RehearsalRequest
 * @typedef {import('./public-release-rehearsal.mjs').RehearsalReply} RehearsalReply
 */

export const missingBindings = Object.freeze([
  'layer-5-switch-admission-and-terminal-owner',
  'layer-6-preview-and-component-failure-boundaries',
]);

export { createRehearsalIngressProof, readOriginalRehearsalProof } from './public-release-rehearsal-proof.mjs';

/** Installed timing has a separate explicit development-only setup gate.
 * Full scenario execution remains refused until its remaining owners bind. */
export async function openInstalledPublicationTimingSetup(options) {
  const owner = await import('./rehearsal-installed-timing.mjs');
  return owner.openInstalledPublicationTimingSetup(options);
}

/** Read-only consumers are explicit and default-off. The CLI without a
 * bound installed session still refuses before acquiring credentials. */
export async function createBootstrapPreflights(options) {
  const owner = await import('./rehearsal-installed-preflights.mjs');
  return owner.createInstalledRehearsalPreflights(options);
}

/** Opaque native composition; no serialized plan can supply this capability. */
export async function createInstalledSession(options) {
  const owner = await import('./rehearsal-installed-session.mjs');
  return owner.createInstalledRehearsalSession(options);
}

/** Layer 4 transport setup. Owner-provided credentials are callbacks,
 * never packet fields. Complete scenario execution remains guarded below. */
export async function startLayerFourHttp(options) {
  const { startDevelopmentRehearsalHttp } = await import('../../site/scripts/public-release-rehearsal-http.ts');
  return startDevelopmentRehearsalHttp(options);
}

/** Explicit in-memory preview setup. Handles and credential callbacks are
 * constructed in the owning process; they are never serialized in a packet.
 * The full scenario launcher remains guarded until all bindings are ready. */
export async function startLayerSixPreview({ runtime, actions }) {
  const { prepareRehearsalPreviewRuntime, createRehearsalPreviewActions } = await import('./public-release-rehearsal-preview.mjs');
  const handle = await prepareRehearsalPreviewRuntime(runtime);
  return createRehearsalPreviewActions(handle, actions);
}

/** @param {RehearsalRequest} _request @returns {Promise<RehearsalReply>} */
export async function execute(_request) {
  throw new Error(`Rehearsal bindings missing: ${missingBindings.join(', ')}`);
}
