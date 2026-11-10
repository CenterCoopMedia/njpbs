export const BOOTSTRAP_ADMISSION_FENCE_PATH: string;
export const BOOTSTRAP_ADMISSION_ATTEMPTS: string;
export class PublicReleaseBootstrapAdmissionPausedError extends Error {
  readonly code: "public_release_bootstrap_admission_paused";
  readonly status: 409;
  readonly retryable: true;
  readonly scheduleDeferred: true;
}
export type BootstrapAdmissionFence = Readonly<{ schemaVersion: 2; operationId: string; attemptDigest: string } & (
  { status: "closed"; resumeReceiptDigest: null } | { status: "open"; resumeReceiptDigest: string })>;
export function parseBootstrapAdmissionFence(value: unknown): BootstrapAdmissionFence;
export function assertBootstrapAdmissionOpen(value: unknown): void;
