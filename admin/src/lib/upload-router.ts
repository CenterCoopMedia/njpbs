import { splitUploadFiles } from "./upload-destination";

type FileHandler = (files: readonly File[]) => void;
type Listener = () => void;

let libraryHandler: FileHandler | null = null;
let videoHandler: FileHandler | null = null;
let heldLibrary: readonly File[] = [];
let heldVideo: readonly File[] = [];
let rejectedNames: readonly string[] = [];
let librarySession = false;
let videoSession = false;
const listeners = new Set<Listener>();
let libraryEpoch = 0;
let snapshot = {
  library: heldLibrary,
  video: heldVideo,
  rejected: rejectedNames,
  librarySession,
  videoSession,
};

function emit() {
  snapshot = {
    library: heldLibrary,
    video: heldVideo,
    rejected: rejectedNames,
    librarySession,
    videoSession,
  };
  for (const listener of listeners) listener();
}

export function subscribeUploadRouter(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function uploadRouterSnapshot() {
  return snapshot;
}

export function registerLibraryUpload(handler: FileHandler) {
  libraryHandler = handler;
  if (heldLibrary.length > 0) {
    const files = heldLibrary;
    heldLibrary = [];
    handler(files);
    emit();
  }
  return () => {
    if (libraryHandler === handler) libraryHandler = null;
  };
}

export function registerVideoUpload(handler: FileHandler) {
  videoHandler = handler;
  if (heldVideo.length > 0) {
    const files = heldVideo;
    heldVideo = [];
    handler(files);
    emit();
  }
  return () => {
    if (videoHandler === handler) videoHandler = null;
  };
}

export function clearRejectedUploads() {
  if (rejectedNames.length === 0) return;
  rejectedNames = [];
  emit();
}

export function finishLibraryUpload() {
  if (!librarySession && heldLibrary.length === 0) return;
  librarySession = false;
  heldLibrary = [];
  emit();
}

export function finishVideoUpload() {
  if (!videoSession && heldVideo.length === 0) return;
  videoSession = false;
  heldVideo = [];
  emit();
}

export function resetUploadRouter() {
  heldLibrary = [];
  heldVideo = [];
  rejectedNames = [];
  librarySession = false;
  videoSession = false;
  emit();
}

export function currentLibraryEpoch() {
  return libraryEpoch;
}

export function routeChosenFiles(files: Iterable<File>) {
  const split = splitUploadFiles(files);
  if (split.library.length > 0) libraryEpoch += 1;
  let changed = false;
  if (split.library.length > 0) {
    if (libraryHandler) libraryHandler(split.library);
    else {
      heldLibrary = [...heldLibrary, ...split.library];
      librarySession = true;
      changed = true;
    }
  }
  if (split.video.length > 0) {
    if (videoHandler) videoHandler(split.video);
    else {
      heldVideo = [...heldVideo, ...split.video];
      videoSession = true;
      changed = true;
    }
  }
  if (split.unsupported.length > 0) {
    rejectedNames = [...rejectedNames, ...split.unsupported.map((file) => file.name)];
    changed = true;
  }
  if (changed) emit();
}
