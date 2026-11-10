import { postFunction } from "./functions";

export type TranscriptionCredentialScope = "personal" | "organization";
export interface TranscriptionCredential {
  id: string;
  scope: TranscriptionCredentialScope;
  provider: "elevenlabs";
  revision: number;
  configured: boolean;
  verification: "unverified";
  updatedAt: string;
}
const identity = (scope: TranscriptionCredentialScope) => ({ scope, provider: "elevenlabs" as const });
export function listTranscriptionCredentials(token: string, scope: TranscriptionCredentialScope) {
  return postFunction<{ success: true; credentials: TranscriptionCredential[] }>("cmsListTranscriptionCredentials", token, identity(scope), {}, { appCheck: true });
}
export function saveTranscriptionCredential(token: string, scope: TranscriptionCredentialScope, key: string, expectedRevision: number) {
  return postFunction<{ success: true; credential: TranscriptionCredential }>("cmsSaveTranscriptionCredential", token, { ...identity(scope), key, expectedRevision }, {}, { appCheck: true });
}
export function disconnectTranscriptionCredential(token: string, scope: TranscriptionCredentialScope, expectedRevision: number) {
  return postFunction<{ success: true; credential: TranscriptionCredential }>("cmsDisconnectTranscriptionCredential", token, { ...identity(scope), expectedRevision }, {}, { appCheck: true });
}

export function transcriptionCredentialError(error: unknown, mutation: boolean) {
  const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  if (status === 401) return "Sign in again before changing transcription keys.";
  if (status === 403) return "Your account cannot manage this key. Ask a CMS administrator for help.";
  if (status === 409) return "This key configuration changed. Reload its status before making another change.";
  if (status === 503) return "Key storage is unavailable. Reload its status later or ask a CMS administrator for help.";
  return mutation ? "The key change could not be confirmed. Reload its status before trying again." : "Key status could not be loaded. Try reloading its status.";
}
