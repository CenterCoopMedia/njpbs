/** Browser-side mirror of the UGC intake contract. The server remains authoritative. */
export const MIN_DWELL_MS = 3_000;
export const MIN_MESSAGE_LENGTH = 10;
export const MAX_MESSAGE_LENGTH = 2_000;
export const MAX_NAME_LENGTH = 300;
export const MAX_EMAIL_LENGTH = 320;
export const PHOTO_LIMIT = 25 * 1024 * 1024;
export const VIDEO_LIMIT = 500 * 1024 * 1024;
export const PHOTO_PIXEL_LIMIT = 100_000_000;
export const FILE_TYPES = {
  "image/jpeg": PHOTO_LIMIT,
  "image/png": PHOTO_LIMIT,
  "image/webp": PHOTO_LIMIT,
  "image/avif": PHOTO_LIMIT,
  "video/mp4": VIDEO_LIMIT,
  "video/quicktime": VIDEO_LIMIT,
  "video/webm": VIDEO_LIMIT,
} as const;
export const FILE_ACCEPT = Object.keys(FILE_TYPES).join(",");

export interface ShareTexts {
  release: string;
  checkbox: string;
  age: string;
  ageHelp: string;
  privacy: string;
  closed: string;
  thanks: string;
}
export interface ShareConfig {
  open: boolean;
  consentVersion: string;
  consentTextHash: string;
  texts: ShareTexts;
}
export interface ShareFields {
  name: string;
  email: string;
  message: string;
  file: Pick<File, "name" | "type" | "size"> | null;
  consentChecked: boolean;
  ageAttested: boolean;
}
export type ShareField = keyof ShareFields | "turnstile";
export type ShareErrors = Partial<Record<ShareField, string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function parseShareConfig(value: unknown): ShareConfig | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!item.texts || typeof item.texts !== "object") return null;
  const texts = item.texts as Record<string, unknown>;
  const keys: (keyof ShareTexts)[] = ["release", "checkbox", "age", "ageHelp", "privacy", "closed", "thanks"];
  if (typeof item.open !== "boolean" || keys.some((key) => typeof texts[key] !== "string") || !(texts.closed as string).trim()) return null;
  if (item.open && (keys.some((key) => !(texts[key] as string).trim()) || typeof item.consentVersion !== "string" || !item.consentVersion.trim() || typeof item.consentTextHash !== "string" || !SHA256.test(item.consentTextHash))) return null;
  return value as ShareConfig;
}

export function validateShareFields(fields: ShareFields): ShareErrors {
  const errors: ShareErrors = {};
  const name = fields.name.trim();
  const email = fields.email.trim();
  const message = fields.message.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) errors.name = "Enter your name (up to 300 characters).";
  if (email.length > MAX_EMAIL_LENGTH) errors.email = "Enter an email address with no more than 320 characters.";
  else if (!EMAIL.test(email)) errors.email = "Enter a valid email address.";
  if (message.length < MIN_MESSAGE_LENGTH || message.length > MAX_MESSAGE_LENGTH) errors.message = "Enter a message between 10 and 2,000 characters.";
  if (!fields.file || !fields.file.name.trim()) errors.file = "Choose a photo or video.";
  else if (!(fields.file.type in FILE_TYPES)) errors.file = "Choose a JPEG, PNG, WebP, AVIF, MP4, QuickTime or WebM file.";
  else if (fields.file.size < 1 || fields.file.size > FILE_TYPES[fields.file.type as keyof typeof FILE_TYPES]) errors.file = fields.file.type.startsWith("image/") ? "Choose a photo smaller than 25 MiB." : "Choose a video smaller than 500 MiB.";
  if (!fields.consentChecked) errors.consentChecked = "Agree to the release before sending.";
  if (!fields.ageAttested) errors.ageAttested = "Confirm that you are 18 or older.";
  return errors;
}

export function photoDimensionsAllowed(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= PHOTO_PIXEL_LIMIT;
}

export function buildShareStartRequest(fields: ShareFields, config: ShareConfig, meta: { requestId: string; timeElapsed: number; turnstileToken: string; website: string }) {
  if (!config.open || Object.keys(validateShareFields(fields)).length || !meta.turnstileToken || !UUID.test(meta.requestId) || !Number.isFinite(meta.timeElapsed) || meta.timeElapsed < 0) throw new Error("The share form is incomplete");
  return {
    requestId: meta.requestId,
    name: fields.name.trim(),
    email: fields.email.trim(),
    message: fields.message.trim(),
    consentVersion: config.consentVersion,
    consentTextHash: config.consentTextHash,
    consentChecked: true as const,
    ageAttested: true as const,
    file: { name: fields.file!.name, type: fields.file!.type, size: fields.file!.size },
    turnstileToken: meta.turnstileToken,
    website: meta.website,
    timeElapsed: meta.timeElapsed,
  };
}

export function shareErrorMessage(code: unknown, retryAfter?: unknown, now = Date.now()): string {
  switch (code) {
    case "closed": return "This form is closed. Please check back later.";
    case "invalid": return "Some details are invalid. Check each field and try again.";
    case "too_large": return "This file is too large. Photos must be under 25 MiB and videos under 500 MiB.";
    case "type": return "This file type is not supported. Choose a JPEG, PNG, WebP, AVIF, MP4, QuickTime or WebM file.";
    case "turnstile": return "The spam check expired or failed. Complete it again and retry.";
    case "rejected_file": return "The uploaded file could not be accepted. Choose another photo or video.";
    case "missing_upload": return "The upload did not finish. Try sending the file again.";
    case "expired": return "The upload link expired. Start the submission again.";
    case "rate_limited": {
      const seconds = typeof retryAfter === "number" ? retryAfter : Number(retryAfter);
      const retryAt = Number.isFinite(seconds) && seconds >= 0
        ? now + seconds * 1_000
        : typeof retryAfter === "string" ? Date.parse(retryAfter) : NaN;
      if (!Number.isFinite(retryAt)) return "Too many submissions. Please try again later.";
      return `Too many submissions. Try again at ${new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    }
    default: return "We could not send your submission. Please try again.";
  }
}
