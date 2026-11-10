import { AUDIO_UPLOAD_MIME_TYPE, IMAGE_UPLOAD_MIME_TYPES, MEDIA_UPLOAD_MIME_TYPES } from "./media-upload";

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "webm", "mpeg", "mpg", "mkv", "avi", "wmv", "mxf",
]);
const LIBRARY_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "pdf", "wav"]);
// Browsers report WAV under several names. The server accepts only audio/wav.
const WAV_MIME_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);
const GENERIC_FILE_TYPES = new Set(["", "application/octet-stream", "application/binary", "binary/octet-stream"]);
const LIBRARY_MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  pdf: "application/pdf",
  wav: AUDIO_UPLOAD_MIME_TYPE,
};

/** The intake message for a file that is not an image, a PDF, a WAV file, or a video. */
export const UNSUPPORTED_UPLOAD_MESSAGE = "Choose an image, PDF, WAV audio file, or video.";

export interface RoutedBatchItem {
  name: string;
  outcome?: "ready" | "failed";
}

/** A notice for one routed batch. Incomplete work, including a pause, returns null. */
export function routedBatchNotice(
  label: string,
  noun: "file" | "video",
  items: readonly RoutedBatchItem[],
): string | null {
  if (items.length === 0 || items.some((item) => !item.outcome)) return null;
  const ready = items.filter((item) => item.outcome === "ready");
  if (ready.length === 0) return null;
  if (ready.length === 1) return `${ready[0].name} is in ${label}.`;
  const word = noun === "video" ? "videos" : "files";
  return `${ready.length} ${word} are in ${label}.`;
}

export const VIDEO_UPLOAD_ACCEPT = [
  "video/*", ...Array.from(VIDEO_EXTENSIONS, (value) => `.${value}`),
].join(",");

export const UNIVERSAL_UPLOAD_ACCEPT = [
  ...IMAGE_UPLOAD_MIME_TYPES,
  "application/pdf",
  ...WAV_MIME_TYPES,
  ".wav",
  VIDEO_UPLOAD_ACCEPT,
].join(",");

export type UploadDestination = "library" | "video" | "unsupported";

function extension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot >= 0 ? trimmed.slice(dot + 1) : "";
}

export function uploadDestination(file: File): UploadDestination {
  const type = file.type.toLowerCase();
  if (IMAGE_UPLOAD_MIME_TYPES.has(type) || type === "application/pdf" || WAV_MIME_TYPES.has(type)) return "library";
  if (type.startsWith("video/")) return "video";
  const ext = extension(file.name);
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (LIBRARY_EXTENSIONS.has(ext)) return "library";
  return "unsupported";
}

function libraryFileForUpload(file: File): File {
  const type = file.type.toLowerCase();
  if (WAV_MIME_TYPES.has(type) && type !== AUDIO_UPLOAD_MIME_TYPE) {
    return new File([file], file.name, { type: AUDIO_UPLOAD_MIME_TYPE, lastModified: file.lastModified });
  }
  if (MEDIA_UPLOAD_MIME_TYPES.has(type) || !GENERIC_FILE_TYPES.has(type)) return file;
  const mime = LIBRARY_MIME_BY_EXTENSION[extension(file.name)];
  if (!mime) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

export function splitUploadFiles(files: Iterable<File>) {
  const library: File[] = [];
  const video: File[] = [];
  const unsupported: File[] = [];
  for (const file of files) {
    const destination = uploadDestination(file);
    if (destination === "library") library.push(libraryFileForUpload(file));
    else if (destination === "video") video.push(file);
    else unsupported.push(file);
  }
  return { library, video, unsupported };
}
