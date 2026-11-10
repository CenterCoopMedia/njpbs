import {
  cmsGetVoiceoverAudioResponse,
  cmsListVoiceoverReviews,
  cmsSaveVoiceoverReview as requestVoiceoverReviewSave,
} from "./functions";

export const VOICEOVER_SCHEMA_VERSION = 1;

export interface VoiceoverPerformer {
  name: string;
}

export interface VoiceoverTake {
  id: string;
  family_id: string;
  family: string;
  take: number;
  style: string;
  performer_id: string;
  text: string;
  display_text?: string;
  complete: boolean;
  flags: string[];
  insert_note?: string;
  duration_seconds?: number;
}

export interface VoiceoverReview {
  favorite: boolean;
  moreLikeThis: boolean;
  notes: string;
  version: number;
  updatedAt: string | null;
}

export interface VoiceoverLibraryResponse {
  success: true;
  schemaVersion: number;
  manifestVersion: number;
  performers: Record<string, VoiceoverPerformer>;
  takes: VoiceoverTake[];
  reviews: Record<string, VoiceoverReview>;
}

export interface VoiceoverSaveInput {
  manifestVersion: number;
  takeId: string;
  baseVersion: number;
  favorite: boolean;
  moreLikeThis: boolean;
  notes: string;
}

export interface VoiceoverSaveResponse {
  success: true;
  takeId: string;
  review: VoiceoverReview;
}

export function cmsListVoiceovers(
  idToken: string,
  signal?: AbortSignal,
): Promise<VoiceoverLibraryResponse> {
  return cmsListVoiceoverReviews<VoiceoverLibraryResponse>(idToken, {
    action: "list",
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
  }, signal);
}

export function cmsSaveVoiceoverReview(
  idToken: string,
  input: VoiceoverSaveInput,
  signal?: AbortSignal,
): Promise<VoiceoverSaveResponse> {
  return requestVoiceoverReviewSave<VoiceoverSaveResponse>(idToken, {
    action: "save",
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    ...input,
  }, signal);
}

export async function cmsGetVoiceoverAudio(
  idToken: string,
  takeId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await cmsGetVoiceoverAudioResponse(idToken, {
    schemaVersion: VOICEOVER_SCHEMA_VERSION,
    takeId,
  }, signal);
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim();
  if (type !== "audio/wav" && type !== "audio/x-wav") {
    void response.body?.cancel().catch(() => {});
    throw new Error("The audio response did not include a WAV content type.");
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) {
    void response.body?.cancel().catch(() => {});
    throw new Error("The audio response did not include a valid length.");
  }
  const blob = await response.blob();
  if (blob.size !== length) {
    throw new Error("The audio response was incomplete.");
  }
  return new Blob([blob], { type });
}
