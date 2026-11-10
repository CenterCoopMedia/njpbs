import { postFunction } from "./functions";
import type { TranscriptResponse, TranscriptSettings, VideoIdentity, VideoTranscript } from "./video-production";
import type { TranscriptionCredentialScope } from "./transcription-credentials";

export interface TranscriptionBudget {
  reservedSubmissions: number;
  reservedAudioSeconds: number;
  consumedSubmissions: number;
  consumedAudioSeconds: number;
  remainingSubmissions: number;
  remainingAudioSeconds: number;
  outstanding?: number;
}
export interface TranscriptionOptions {
  success: true;
  enabled: boolean;
  credentials: { scope: TranscriptionCredentialScope; provider: "elevenlabs"; revision: number; configured: boolean }[];
  provider: { id: "elevenlabs"; model: "scribe_v2"; wordTimings: true; languageCodes: ("en-US" | "es-US")[]; maxSpeakers: { min: number; max: number }; maxInputBytes: number; minDurationSeconds: number; maxDurationSeconds: number };
  limits: { requester: { submissions: number; audioSeconds: number; outstanding: number }; global: { submissions: number; audioSeconds: number } };
  budget: { day: string; requester: TranscriptionBudget; global: TranscriptionBudget };
}
export async function getTranscriptionOptions(token: string, identity: VideoIdentity) {
  const response = await postFunction<TranscriptionOptions>("cmsGetTranscriptionOptions", token, identity, {}, { appCheck: true });
  if (typeof response?.enabled !== "boolean" || response.provider?.id !== "elevenlabs" || response.provider.model !== "scribe_v2" || response.provider.wordTimings !== true
    || !Array.isArray(response.credentials) || !Array.isArray(response.provider.languageCodes) || !response.provider.maxSpeakers
    || !response.limits?.requester || !response.budget?.requester || !response.budget.global) throw new Error("Transcription options are unavailable");
  return response;
}
export async function listVideoTranscripts(token: string, identity: VideoIdentity, cursor?: string) {
  const response = await postFunction<{ success: true; transcripts: VideoTranscript[]; nextCursor: string | null }>("cmsListVideoTranscripts", token, { ...identity, ...(cursor ? { cursor } : {}) }, {}, { appCheck: "unless-automation" });
  if (!Array.isArray(response?.transcripts) || (response.nextCursor !== null && typeof response.nextCursor !== "string")) throw new Error("Saved transcript choices are unavailable");
  return response;
}
export function requestByokVideoTranscript(token: string, identity: VideoIdentity, settings: TranscriptSettings, scope: TranscriptionCredentialScope, revision: number, attempt?: { newAttemptOf: string; attemptKey: string }) {
  return postFunction<TranscriptResponse>("cmsRequestByokVideoTranscript", token, { ...identity, provider: "elevenlabs", credentialScope: scope, credentialRevision: revision, languageCode: settings.languageCode, maxSpeakers: settings.maxSpeakers, ...attempt }, {}, { appCheck: true });
}
