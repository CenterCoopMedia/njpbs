import { InfoTooltip } from "./ui/InfoTooltip";
import { Link } from "react-router";
import { mediaImagesPath } from "../lib/routes";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
} from "react";
import type {
  MediaCategoryDefinition,
  MediaAssetSummary,
  UploadMediaMetadata,
  UploadMediaResponse,
} from "../lib/functions";
import {
  AUDIO_UPLOAD_MIME_TYPE,
  IMAGE_UPLOAD_MIME_TYPES,
  MAX_MEDIA_UPLOAD_BATCH_FILES,
  duplicateUploadAssetId,
  normalizeMediaTags,
  validateMediaUploadFile,
} from "../lib/media-upload";
import { splitUploadFiles, UNIVERSAL_UPLOAD_ACCEPT, UNSUPPORTED_UPLOAD_MESSAGE, VIDEO_UPLOAD_ACCEPT } from "../lib/upload-destination";
import { routeChosenFiles } from "../lib/upload-router";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
  Panel,
  Select,
  StatusBadge,
  Textarea,
  TextInput,
} from "./ui/Primitives";

export type MediaUploader = (
  file: File,
  metadata: UploadMediaMetadata,
  signal: AbortSignal,
) => Promise<UploadMediaResponse>;

export interface MediaUploadInitialState {
  file: File;
  name?: string;
  category?: string;
  categories?: string[];
  description?: string;
  altText?: string;
  license?: string;
  credit?: string;
  tags?: string;
  metadataUpdateRequested?: boolean;
  optimizeToWebp?: boolean;
  uploading?: boolean;
}

export interface MediaUploadBatchFailure {
  fileName: string;
  message: string;
}

export interface MediaUploadBatchReuse {
  fileName: string;
  asset: MediaAssetSummary;
}

/** The receipt for a batch closed before every file finished. */
export function partialUploadReceipt(
  succeeded: MediaAssetSummary[],
  reused: MediaUploadBatchReuse[],
): MediaUploadBatchReceipt {
  return { succeeded, failed: [], ...(reused.length > 0 ? { reused } : {}) };
}

export interface MediaUploadBatchReceipt {
  succeeded: MediaAssetSummary[];
  failed: MediaUploadBatchFailure[];
  /** Succeeded files that matched an existing asset. Also listed in succeeded. */
  reused?: MediaUploadBatchReuse[];
}

export type MediaUploadQueueStatus = "pending" | "uploading" | "succeeded" | "failed";

export interface MediaUploadQueueProjection {
  id: string;
  name: string;
  status: MediaUploadQueueStatus;
  message?: string;
  asset: MediaAssetSummary | null;
}

interface MediaUploadQueueItem {
  id: string;
  file: File | null;
  name: string;
  category: string;
  assignedCategories: string[];
  description: string;
  altText: string;
  license: string;
  licenseOverridden: boolean;
  credit: string;
  tags: string;
  metadataUpdateRequested: boolean;
  metadataRequestOverridden: boolean;
  optimizeToWebp: boolean;
  status: MediaUploadQueueStatus;
  error: string | null;
  duplicateAssetId?: string | null;
  asset: MediaAssetSummary | null;
  /** The file was already in the library, and its existing asset was used. */
  reused: boolean;
}

interface IntakeError {
  fileName: string;
  message: string;
}

type MediaUploadScope =
  | "document"
  | "library"
  | "image"
  | "images-and-documents"
  | "audio";

const SCOPED_UPLOAD_ACCEPT: Record<Exclude<MediaUploadScope, "library">, string> = {
  document: "application/pdf,.pdf",
  image: [...IMAGE_UPLOAD_MIME_TYPES].join(","),
  "images-and-documents": [...IMAGE_UPLOAD_MIME_TYPES, "application/pdf", VIDEO_UPLOAD_ACCEPT].join(","),
  audio: `audio/wav,audio/x-wav,audio/wave,audio/vnd.wave,.wav,${VIDEO_UPLOAD_ACCEPT}`,
};

function validateScopedUploadFile(
  file: File,
  scope: MediaUploadScope,
): string | null {
  if (scope === "document" && file.type !== "application/pdf") return "Choose a PDF file.";
  if (scope === "audio" && file.type !== AUDIO_UPLOAD_MIME_TYPE) {
    return IMAGE_UPLOAD_MIME_TYPES.has(file.type) ||
      file.type === "application/pdf"
      ? "Upload images and PDFs from Images."
      : "Choose a WAV file in Audio.";
  }
  if (
    scope === "images-and-documents" &&
    !IMAGE_UPLOAD_MIME_TYPES.has(file.type) &&
    file.type !== "application/pdf"
  ) {
    return file.type === AUDIO_UPLOAD_MIME_TYPE
      ? "Upload WAV files from Audio."
      : "Choose an image or PDF in Images.";
  }
  return validateMediaUploadFile(file, scope === "image");
}

function uploadHeading(scope: MediaUploadScope): string {
  if (scope === "document") return "Upload PDFs";
  if (scope === "image") return "Upload images";
  if (scope === "images-and-documents") return "Choose images or PDFs";
  if (scope === "audio") return "Choose WAV audio";
  return "Upload media";
}

function queueStatusLabel(status: MediaUploadQueueStatus): string {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "succeeded":
      return "Uploaded";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

function queueStatusTone(
  status: MediaUploadQueueStatus,
): "neutral" | "pending" | "success" | "failed" {
  switch (status) {
    case "uploading":
      return "pending";
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    default:
      return "neutral";
  }
}

function itemMatchesInitialState(
  item: MediaUploadQueueItem,
  initial: MediaUploadQueueItem,
): boolean {
  return (
    item.file === initial.file &&
    item.name === initial.name &&
    item.category === initial.category &&
    JSON.stringify(item.assignedCategories) ===
      JSON.stringify(initial.assignedCategories) &&
    item.description === initial.description &&
    item.altText === initial.altText &&
    item.license === initial.license &&
    item.credit === initial.credit &&
    item.tags === initial.tags &&
    item.metadataUpdateRequested === initial.metadataUpdateRequested &&
    item.optimizeToWebp === initial.optimizeToWebp
  );
}

function itemIsBlankPlaceholder(
  item: MediaUploadQueueItem,
  defaultCategory: string,
  batchLicense: string,
): boolean {
  return (
    item.file === null &&
    item.name === "" &&
    item.category === defaultCategory &&
    item.assignedCategories.length === 1 &&
    item.assignedCategories[0] === defaultCategory &&
    item.description === "" &&
    item.altText === "" &&
    item.license === batchLicense &&
    !item.licenseOverridden &&
    item.credit === "" &&
    item.tags === "" &&
    !item.metadataUpdateRequested &&
    item.optimizeToWebp &&
    item.status === "pending" &&
    item.error === null &&
    item.asset === null
  );
}

export function MediaUploadForm({
  defaultCategory,
  onBatchComplete,
  onCancel,
  onDirtyChange,
  onUploaded,
  canUploadCategory,
  canOpenRecycleBin = false,
  librarySearch,
  categories,
  uploadMedia,
  uploadController,
  initialState,
  imagesOnly = false,
  uploadScope = "library",
  heading,
  onVideoFiles,
  incomingFiles,
  addFilesRef,
  onQueueChange,
  autoFocusFileInput = true,
}: {
  defaultCategory: string;
  onBatchComplete?: (receipt: MediaUploadBatchReceipt) => void;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Called per committed file; `reuse` is set when an existing file was used. */
  onUploaded: (asset: MediaAssetSummary, reuse?: MediaUploadBatchReuse) => void;
  canUploadCategory: (category: string) => boolean;
  canOpenRecycleBin?: boolean;
  /** Only library uploads opt in; picker uploads must not navigate out of the editor. */
  librarySearch?: string;
  categories: readonly MediaCategoryDefinition[];
  uploadMedia: MediaUploader;
  uploadController?: MutableRefObject<AbortController | null>;
  initialState?: MediaUploadInitialState;
  imagesOnly?: boolean;
  /** Limits a tab-owned form to the kinds that remain visible in that tab. */
  uploadScope?: MediaUploadScope;
  heading?: string;
  /** Videos chosen here are sent to Videos. */
  onVideoFiles?: (files: readonly File[]) => void;
  /** Library files chosen somewhere else. Applied when the array identity changes. */
  incomingFiles?: readonly File[] | null;
  addFilesRef?: MutableRefObject<((files: readonly File[]) => void) | null>;
  /** A read-only projection for route-owned presentation such as the upload tray. */
  onQueueChange?: (queue: readonly MediaUploadQueueProjection[]) => void;
  /** Kept-mounted hosts let their sheet heading own focus when opened. */
  autoFocusFileInput?: boolean;
}) {
  const resolvedUploadScope = imagesOnly ? "image" : uploadScope;
  const resolvedHeading = heading ?? uploadHeading(resolvedUploadScope);
  const headingId = useId();
  const binParams = new URLSearchParams(librarySearch);
  binParams.set("bin", "1");
  binParams.delete("binAsset");
  const queueStatusId = useId();
  const batchLicenseInputId = useId();
  const batchLicenseHintId = useId();
  const currentLicenseInputId = useId();
  const currentLicenseHintId = useId();
  const internalController = useRef<AbortController | null>(null);
  const activeController = uploadController ?? internalController;
  const stopBatchRequested = useRef(false);
  const itemCounter = useRef(1);
  const completionReported = useRef(false);
  const initialBatchLicense = useRef(initialState?.license ?? "");
  const [batchLicense, setBatchLicense] = useState(
    initialBatchLicense.current,
  );
  const [batchTitle, setBatchTitle] = useState("");
  const [batchDescription, setBatchDescription] = useState("");
  const [batchMetadataRequested, setBatchMetadataRequested] = useState(false);
  const makeItem = (
    file: File | null,
    seed?: Partial<MediaUploadQueueItem>,
  ): MediaUploadQueueItem => ({
    id: `media-upload-${itemCounter.current++}`,
    file,
    name: seed?.name ?? "",
    category: seed?.category ?? defaultCategory,
    assignedCategories: seed?.assignedCategories ?? [defaultCategory],
    description: seed?.description ?? "",
    altText: seed?.altText ?? "",
    license: seed?.license ?? batchLicense,
    licenseOverridden: seed?.licenseOverridden ?? false,
    credit: seed?.credit ?? "",
    tags: seed?.tags ?? "",
    metadataUpdateRequested: seed?.metadataUpdateRequested ?? batchMetadataRequested,
    metadataRequestOverridden: seed?.metadataRequestOverridden ?? false,
    optimizeToWebp: seed?.optimizeToWebp ?? true,
    status: seed?.status ?? "pending",
    error: seed?.error ?? null,
    asset: seed?.asset ?? null,
    reused: seed?.reused ?? false,
  });
  const [items, setItems] = useState<MediaUploadQueueItem[]>(() => [
    makeItem(initialState?.file ?? null, {
      name: initialState?.name ?? "",
      category: initialState?.category ?? defaultCategory,
      assignedCategories: initialState?.categories ?? [
        initialState?.category ?? defaultCategory,
      ],
      description: initialState?.description ?? "",
      altText: initialState?.altText ?? "",
      license: initialState?.license ?? "",
      licenseOverridden: false,
      credit: initialState?.credit ?? "",
      tags: initialState?.tags ?? "",
      metadataUpdateRequested: initialState?.metadataUpdateRequested ?? false,
      optimizeToWebp: initialState?.optimizeToWebp ?? true,
      status: initialState?.uploading ? "uploading" : "pending",
    }),
  ]);
  const initialItem = useRef(items[0]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [intakeErrors, setIntakeErrors] = useState<IntakeError[]>([]);
  const [pendingIncoming, setPendingIncoming] = useState<readonly File[]>([]);
  const pendingIncomingRef = useRef<readonly File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const current = items[currentIndex] ?? items[0];
  const uploading = items.some((item) => item.status === "uploading");
  const busy = uploading || uploadingBatch;
  const realItems = items.filter((item) => item.file);
  const succeeded = realItems.filter((item) => item.status === "succeeded");
  const failed = realItems.filter((item) => item.status === "failed");
  const pending = realItems.filter((item) => item.status === "pending");
  const completedQueue = realItems.length > 0 && realItems.every((item) => item.status === "succeeded");
  const acceptsFiles =
    !busy && (completedQueue || realItems.length < MAX_MEDIA_UPLOAD_BATCH_FILES);
  const dirty =
    batchTitle !== "" || batchDescription !== "" || batchMetadataRequested ||
    batchLicense !== initialBatchLicense.current ||
    pendingIncoming.length > 0 ||
    items.some((item) => {
      if (item.status === "succeeded") return false;
      // Removing the last queued file deliberately returns the form to its pristine empty
      // placeholder. Its generated id is implementation detail, not an unsaved user change.
      if (itemIsBlankPlaceholder(item, defaultCategory, batchLicense)) {
        return false;
      }
      if (item.status === "uploading" || item.id !== initialItem.current.id) {
        return true;
      }
      return !itemMatchesInitialState(item, initialItem.current);
    });

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onQueueChange?.(items.flatMap((item) => item.file ? [{
      id: item.id,
      name: item.file.name,
      status: item.status,
      ...(item.error ? { message: item.error } : {}),
      asset: item.asset,
    }] : []));
  }, [items, onQueueChange]);

  useEffect(
    () => () => {
      stopBatchRequested.current = true;
      activeController.current?.abort();
      activeController.current = null;
    },
    [activeController],
  );

  useEffect(() => {
    setPreviewUrl(null);
    if (
      !current?.file ||
      !current.file.type.startsWith("image/") ||
      typeof URL.createObjectURL !== "function"
    ) {
      return;
    }
    const url = URL.createObjectURL(current.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [current?.file]);

  function updateCurrent(patch: Partial<MediaUploadQueueItem>) {
    setItems((existing) =>
      existing.map((item, index) =>
        index === currentIndex ? { ...item, ...patch } : item,
      ),
    );
  }

  function updateBatchLicense(nextLicense: string) {
    setBatchLicense(nextLicense);
    setItems((existing) =>
      existing.map((item) =>
        !item.licenseOverridden &&
        item.status !== "uploading" &&
        item.status !== "succeeded"
          ? {
              ...item,
              license: nextLicense,
            }
          : item,
      ),
    );
  }

  function receiptFor(
    queue: readonly MediaUploadQueueItem[],
  ): MediaUploadBatchReceipt {
    const reused = queue.flatMap((item) =>
      item.file && item.asset && item.reused
        ? [{ fileName: item.file.name, asset: item.asset }]
        : [],
    );
    return {
      // Two files can resolve to one existing asset; list that asset once.
      succeeded: queue.flatMap((item, index) =>
        item.asset &&
        queue.findIndex((other) => other.asset?.id === item.asset?.id) === index
          ? [item.asset]
          : [],
      ),
      failed: queue.flatMap((item) =>
        item.file && item.status === "failed"
          ? [
              {
                fileName: item.file.name,
                message:
                  item.error ?? "The media file could not be uploaded.",
              },
            ]
          : [],
      ),
      ...(reused.length > 0 ? { reused } : {}),
    };
  }

  function completeBatch(queue: readonly MediaUploadQueueItem[]) {
    if (completionReported.current || pendingIncomingRef.current.length > 0) return;
    completionReported.current = true;
    onBatchComplete?.(receiptFor(queue));
  }

  function takeFiles(fileList: FileList | readonly File[] | null) {
    if (resolvedUploadScope === "image" || resolvedUploadScope === "document") addFiles(fileList);
    else routeChosenFiles(fileList ?? []);
  }

  function addFiles(fileList: FileList | readonly File[] | null) {
    const selected = Array.from(fileList ?? []);
    if (selected.length === 0 || busy) return;
    const routed = splitUploadFiles(selected);
    if (resolvedUploadScope === "library" && routed.video.length) {
      onVideoFiles?.(routed.video);
    }
    completionReported.current = false;
    const queuedCount = completedQueue ? 0 : realItems.length;
    const available = Math.max(
      0,
      MAX_MEDIA_UPLOAD_BATCH_FILES - queuedCount,
    );
    const accepted: File[] = [];
    const rejected: IntakeError[] = resolvedUploadScope === "library"
      ? routed.unsupported.map((file) => ({
          fileName: file.name,
          message: UNSUPPORTED_UPLOAD_MESSAGE,
        }))
      : [];
    const candidates = resolvedUploadScope === "library"
      ? routed.library
      : [...routed.library, ...routed.video, ...routed.unsupported];
    candidates.forEach((file) => {
      const validationError = validateScopedUploadFile(file, resolvedUploadScope);
      if (validationError) {
        rejected.push({ fileName: file.name, message: validationError });
        return;
      }
      if (accepted.length >= available) {
        rejected.push({
          fileName: file.name,
          message: `A batch can contain up to ${MAX_MEDIA_UPLOAD_BATCH_FILES} files.`,
        });
        return;
      }
      accepted.push(file);
    });
    setIntakeErrors(rejected);
    if (accepted.length === 0) return;
    if (completedQueue) onDirtyChange(true);
    setItems((existing) => {
      const placeholder =
        existing.length === 1 &&
        existing[0].file === null &&
        existing[0].status === "pending"
          ? existing[0]
          : null;
      const seed = placeholder
        ? {
            name: placeholder.name,
            category: placeholder.category,
            assignedCategories: placeholder.assignedCategories,
            description: placeholder.description,
            altText: placeholder.altText,
            license: placeholder.license,
            licenseOverridden: placeholder.licenseOverridden,
            credit: placeholder.credit,
            tags: placeholder.tags,
            metadataUpdateRequested: placeholder.metadataUpdateRequested,
            metadataRequestOverridden: placeholder.metadataRequestOverridden,
            optimizeToWebp: placeholder.optimizeToWebp,
          }
        : undefined;
      const additions = accepted.map((file) => makeItem(file, seed));
      const replaceCompleted = existing.some((item) => item.file) && existing
        .filter((item) => item.file)
        .every((item) => item.status === "succeeded");
      const next = placeholder || replaceCompleted ? additions : [...existing, ...additions];
      setCurrentIndex(placeholder || replaceCompleted ? 0 : existing.length);
      return next;
    });
  }

  if (addFilesRef) addFilesRef.current = addFiles;
  const pendingAddFiles = useRef(addFiles);
  pendingAddFiles.current = addFiles;
  const [appliedIncoming, setAppliedIncoming] = useState<readonly File[] | null>(null);
  if (incomingFiles && incomingFiles !== appliedIncoming) {
    setAppliedIncoming(incomingFiles);
    if (incomingFiles.length > 0) {
      if (busy || pendingIncomingRef.current.length > 0) {
        pendingIncomingRef.current = [...pendingIncomingRef.current, ...incomingFiles];
        setPendingIncoming(pendingIncomingRef.current);
      }
      else addFiles(incomingFiles);
    }
  }
  useEffect(() => {
    if (busy || pendingIncoming.length === 0) return;
    const files = pendingIncomingRef.current;
    pendingIncomingRef.current = [];
    setPendingIncoming([]);
    pendingAddFiles.current(files);
  }, [busy, pendingIncoming]);

  function findNextPending(
    queue: readonly MediaUploadQueueItem[],
    afterIndex: number,
  ): number {
    const following = queue.findIndex(
      (item, index) => index > afterIndex && item.status === "pending",
    );
    if (following >= 0) return following;
    return queue.findIndex((item) => item.status === "pending");
  }

  function continueBatch() {
    const nextIndex = findNextPending(items, currentIndex);
    if (nextIndex >= 0) setCurrentIndex(nextIndex);
  }

  function removeCurrent() {
    if (!current || busy || current.status === "succeeded") return;
    const next = items.filter((_, index) => index !== currentIndex);
    if (next.length === 0) {
      setItems([makeItem(null)]);
      setCurrentIndex(0);
      return;
    }
    setItems(next);
    setCurrentIndex(Math.min(currentIndex, next.length - 1));
    if (
      next.some((item) => item.status === "succeeded") &&
      !next.some(
        (item) => item.status === "pending" || item.status === "failed",
      )
    ) {
      completeBatch(next);
    }
  }

  async function uploadItem(
    queue: readonly MediaUploadQueueItem[],
    index: number,
    onSuccess?: (nextQueue: readonly MediaUploadQueueItem[]) => void,
  ): Promise<{ queue: MediaUploadQueueItem[]; stopped: boolean }> {
    const item = queue[index];
    if (!item?.file || item.status === "succeeded") {
      return { queue: [...queue], stopped: false };
    }
    const fileError = validateScopedUploadFile(item.file, resolvedUploadScope);
    const normalizedCategory = item.category
      .trim()
      .toLocaleLowerCase("en-US");
    const normalizedLicense = item.license.trim();
    const tagResult = normalizeMediaTags(item.tags);
    const selectedCategory = categories.find(
      (candidate) => candidate.id === normalizedCategory,
    );
    let validationError = fileError;
    if (
      !validationError &&
      (!selectedCategory ||
        !selectedCategory.active ||
        !selectedCategory.canUpload ||
        !canUploadCategory(normalizedCategory))
    ) {
      validationError = "Choose a category you can upload to.";
    }
    // Extra categories are discovery guidance. Keep the authorized primary category and
    // omit stale choices rather than preventing an otherwise valid upload.
    const additionalCategories = item.assignedCategories.filter(id =>
      id !== normalizedCategory && categories.some(candidate => candidate.id === id && candidate.active),
    ).slice(0, 7);
    if (!validationError && tagResult.error) validationError = tagResult.error;
    if (validationError) {
      const failedQueue = queue.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? { ...candidate, status: "failed" as const, error: validationError, duplicateAssetId: null }
          : candidate,
      );
      setItems(failedQueue);
      return { queue: failedQueue, stopped: false };
    }

    const uploadingQueue = queue.map((candidate, candidateIndex) =>
      candidateIndex === index
        ? { ...candidate, status: "uploading" as const, error: null, duplicateAssetId: null }
        : candidate,
    );
    setItems(uploadingQueue);
    const controller = new AbortController();
    activeController.current = controller;
    try {
      const response = await uploadMedia(
        item.file,
        {
          name: item.name.trim() || batchTitle.trim() || undefined,
          metadataUpdateRequested: item.metadataUpdateRequested,
          category: normalizedCategory,
          categories: [
            normalizedCategory,
            ...additionalCategories,
          ],
          description: item.description.trim() || batchDescription.trim() || undefined,
          altText: item.file.type === AUDIO_UPLOAD_MIME_TYPE ? undefined : item.altText.trim() || undefined,
          license: normalizedLicense || undefined,
          credit: item.credit.trim() || undefined,
          tags: tagResult.tags,
          imageProcessing:
            item.optimizeToWebp &&
            (item.file.type === "image/jpeg" ||
              item.file.type === "image/png")
              ? "webp"
              : undefined,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        const stoppedQueue = uploadingQueue.map((candidate, candidateIndex) =>
          candidateIndex === index
            ? { ...candidate, status: "failed" as const, error: "The upload was canceled." }
            : candidate,
        );
        setItems(stoppedQueue);
        return { queue: stoppedQueue, stopped: true };
      }
      const next = uploadingQueue.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? {
              ...candidate,
              status: "succeeded" as const,
              error: null,
              asset: response.asset,
              reused: response.reusedDuplicate === true,
            }
          : candidate,
      );
      setItems(next);
      onUploaded(
        response.asset,
        response.reusedDuplicate
          ? { fileName: item.file.name, asset: response.asset }
          : undefined,
      );
      onSuccess?.(next);
      return { queue: next, stopped: false };
    } catch (uploadError) {
      const message =
        uploadError instanceof Error
          ? uploadError.message
          : "The media file could not be uploaded.";
      const failedQueue = uploadingQueue.map((candidate, candidateIndex) =>
        candidateIndex === index
          ? {
              ...candidate,
              status: "failed" as const,
              error: message,
              duplicateAssetId: candidate.file?.type.startsWith("image/")
                ? duplicateUploadAssetId(uploadError)
                : null,
            }
          : candidate,
      );
      setItems(failedQueue);
      return { queue: failedQueue, stopped: controller.signal.aborted };
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Portal submit events still bubble through a surrounding record form.
    event.stopPropagation();
    if (!current?.file || busy || current.status === "succeeded") return;
    await uploadItem(items, currentIndex, (nextQueue) => {
      const nextPendingIndex = findNextPending(nextQueue, currentIndex);
      if (nextPendingIndex >= 0) {
        setCurrentIndex(nextPendingIndex);
        return;
      }
      const nextFailureIndex = nextQueue.findIndex(
        (item) => item.status === "failed",
      );
      if (nextFailureIndex >= 0) setCurrentIndex(nextFailureIndex);
      else completeBatch(nextQueue);
    });
  }

  async function uploadAllFiles() {
    if (busy || pending.length < 2) return;
    stopBatchRequested.current = false;
    setUploadingBatch(true);
    let queue = [...items];
    let stopped = false;
    while (!stopBatchRequested.current) {
      const nextIndex = queue.findIndex((item) => item.status === "pending");
      if (nextIndex < 0) break;
      setCurrentIndex(nextIndex);
      const result = await uploadItem(queue, nextIndex);
      queue = result.queue;
      if (result.stopped) {
        stopped = true;
        break;
      }
    }
    setUploadingBatch(false);
    if (stopped || stopBatchRequested.current) return;
    const firstFailureIndex = queue.findIndex((item) => item.status === "failed");
    if (firstFailureIndex >= 0) {
      setCurrentIndex(firstFailureIndex);
      return;
    }
    completeBatch(queue);
  }

  const activeFileNumber = current?.file ? currentIndex + 1 : 0;
  const canEditCurrent = Boolean(
    current && current.status !== "succeeded" && !busy,
  );
  // Audio has no alt text or image processing.
  const currentIsAudio = current?.file?.type === AUDIO_UPLOAD_MIME_TYPE;
  const currentIsDocument = resolvedUploadScope === "document" || current?.file?.type === "application/pdf";
  const nextPendingIndex = findNextPending(items, currentIndex);

  return (
    <Panel className="media-upload-panel" aria-labelledby={headingId}>
      <div className="media-upload-heading">
        <div>
          <div className="editor-field-label-row"><h3 id={headingId}>{resolvedHeading}</h3><InfoTooltip label={resolvedHeading} content={`Add up to ${MAX_MEDIA_UPLOAD_BATCH_FILES} files. Edit details when needed, then upload one file or the whole batch.`} /></div>
        </div>
        {realItems.length > 0 ? (
          <span aria-live="polite" id={queueStatusId}>
            {succeeded.length} of {realItems.length} uploaded
          </span>
        ) : null}
      </div>

      <label
        className="media-upload-file"
        data-dragging={draggingFiles || undefined}
        data-disabled={!acceptsFiles || undefined}
        onDragOver={(event) => {
          if (
            !acceptsFiles ||
            (event.dataTransfer.types &&
              !event.dataTransfer.types.includes("Files"))
          ) {
            return;
          }
          event.preventDefault();
          setDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingFiles(false);
          }
        }}
        onDrop={(event) => {
          if (
            event.dataTransfer.types &&
            !event.dataTransfer.types.includes("Files")
          ) {
            return;
          }
          event.preventDefault();
          setDraggingFiles(false);
          if (acceptsFiles) takeFiles(event.dataTransfer.files);
        }}
      >
        {realItems.length > 0 ? "Add files" : "Files"} (25 MB maximum each)
        <span className="field-hint">Drop files here or use the file picker.{currentIsAudio ? " WAV: PCM mono or stereo, 44.1 or 48 kHz, 16 or 24 bit, up to 10 MiB." : ""}</span>
        <input
          autoFocus={autoFocusFileInput && !busy && !current?.error}
          className="field-control"
          type="file"
          multiple
          accept={resolvedUploadScope === "library"
            ? UNIVERSAL_UPLOAD_ACCEPT
            : SCOPED_UPLOAD_ACCEPT[resolvedUploadScope]}
          aria-describedby={realItems.length > 0 ? queueStatusId : undefined}
          disabled={!acceptsFiles}
          onChange={(event) => {
            takeFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </label>

      {current && (current.assignedCategories.length === 0 || current.assignedCategories.length > 8 ||
        current.assignedCategories.some(id => !categories.some(category => category.id === id && category.active))) ? (
        <InlineMessage tone="warning" title="Category choices need review">
          The authorized primary category will be kept. Inactive or excess extra categories will be omitted; you can still upload.
        </InlineMessage>
      ) : null}
      <fieldset className="media-upload-batch-license" disabled={busy}>
        <legend>Batch assignment</legend>
        <p>Used for files without their own title or description.</p>
        <label>Batch title default<TextInput maxLength={180} value={batchTitle} onChange={event => setBatchTitle(event.target.value)} /></label>
        <label>Batch description default<Textarea maxLength={2_000} rows={2} value={batchDescription} onChange={event => setBatchDescription(event.target.value)} /></label>
        <label className="media-upload-processing"><input type="checkbox" checked={batchMetadataRequested} onChange={event => {
          const checked = event.target.checked;
          setBatchMetadataRequested(checked);
          setItems(existing => existing.map(item => !item.metadataRequestOverridden && item.status !== "uploading" && item.status !== "succeeded"
            ? { ...item, metadataUpdateRequested: checked } : item));
        }} /> Request metadata update for the batch</label>
      </fieldset>
      <div className="media-upload-batch-license">
        <div className="editor-field-label-row"><label htmlFor={batchLicenseInputId}>Batch license default</label><InfoTooltip label="Batch license default" content="Applies to new files and queued files that do not have a custom license." /></div>
        <TextInput
          id={batchLicenseInputId}
          value={batchLicense}
          maxLength={120}
          aria-describedby={batchLicenseHintId}
          disabled={busy}
          onChange={(event) => updateBatchLicense(event.target.value)}
        />
        <span className="sr-only" id={batchLicenseHintId}>
          Applies to new files and queued files that do not have a custom
          license.
        </span>
      </div>

      {intakeErrors.length > 0 ? (
        <InlineMessage tone="error" title="Some files were not added">
          <ul className="media-upload-intake-errors">
            {intakeErrors.map((error, index) => (
              <li key={`${error.fileName}-${index}`}>
                <strong>{error.fileName}</strong>: <span>{error.message}</span>
              </li>
            ))}
          </ul>
        </InlineMessage>
      ) : null}

      {pendingIncoming.length > 0 ? (
        <p role="status">{pendingIncoming.length} {pendingIncoming.length === 1 ? "file is" : "files are"} waiting for the current upload to finish.</p>
      ) : null}

      {realItems.length > 0 ? (
        <div className="media-upload-batch" aria-label="Upload batch">
          <div className="media-upload-progress">
            <progress
              aria-label="Batch progress"
              max={realItems.length}
              value={succeeded.length + failed.length}
            />
            <span>
              {pending.length} pending, {failed.length} failed
            </span>
          </div>
          <ol className="media-upload-queue">
            {items.map((item, index) =>
              item.file ? (
                <li key={item.id} data-status={item.status}>
                  <Button
                    className="media-upload-queue-item"
                    variant="ghost"
                    aria-current={index === currentIndex ? "step" : undefined}
                    disabled={busy}
                    onClick={() => setCurrentIndex(index)}
                  >
                    <span>
                      {index + 1}. {item.file.name}
                    </span>
                    <StatusBadge tone={queueStatusTone(item.status)}>
                      {queueStatusLabel(item.status)}
                    </StatusBadge>
                  </Button>
                </li>
              ) : null,
            )}
          </ol>
        </div>
      ) : null}

      <form aria-busy={busy} onSubmit={submit}>
        {current?.file ? (
          <div className="media-upload-current" aria-live="polite">
            <div>
              <span className="eyebrow">
                File {activeFileNumber} of {realItems.length}
              </span>
              <strong>{current.file.name}</strong>
              <span>{queueStatusLabel(current.status)}</span>
            </div>
            {previewUrl ? (
              <img src={previewUrl} alt="" />
            ) : (
              <span
                className="media-upload-preview-placeholder"
                aria-hidden="true"
              >
                {current.file.type === "application/pdf" ? "PDF" : currentIsAudio ? "WAV" : "File"}
              </span>
            )}
          </div>
        ) : (
          <p className="field-hint">Choose one or more files to begin.</p>
        )}

        <div className="media-upload-fields">
          <label>
            Name
            <TextInput
              value={current?.name ?? ""}
              maxLength={180}
              placeholder={batchTitle || "Uses the filename when empty"}
              disabled={!canEditCurrent}
              onChange={(event) =>
                updateCurrent({ name: event.target.value, error: null })
              }
            />
          </label>
          <label>
            Category
            <Select
              aria-label="Category"
              aria-describedby={`${headingId}-category-description`}
              value={current?.category ?? defaultCategory}
              required
              disabled={!canEditCurrent}
              onChange={(event) => {
                const nextCategory = event.target.value;
                const assignedCategories =
                  current?.assignedCategories ?? [];
                updateCurrent({
                  category: nextCategory,
                  assignedCategories: assignedCategories.includes(nextCategory)
                    ? [
                        nextCategory,
                        ...assignedCategories.filter(
                          (id) => id !== nextCategory,
                        ),
                      ]
                    : [nextCategory, ...assignedCategories].slice(0, 8),
                  error: null,
                });
              }}
            >
              {categories
                .filter(
                  (candidate) =>
                    candidate.active &&
                    candidate.canUpload &&
                    canUploadCategory(candidate.id),
                )
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}{candidate.description ? ` — ${candidate.description}` : ""}
                  </option>
                ))}
            </Select>
            <small id={`${headingId}-category-description`}>{categories.find((candidate) => candidate.id === (current?.category ?? defaultCategory))?.description}</small>
          </label>
          {categories.filter((candidate) => candidate.active).length > 1 ? (
            <fieldset className="media-category-assignments" aria-label="Category assignments">
              <legend>Category assignments <InfoTooltip label="Category assignments" content="The primary category is required. Additional categories improve discovery." /></legend>
              <div>
                {categories
                  .filter((candidate) => candidate.active)
                  .map((candidate) => {
                    const primary = candidate.id === current?.category;
                    const checked =
                      current?.assignedCategories.includes(candidate.id) ??
                      false;
                    return (
                      <label key={candidate.id}>
                        <input
                          type="checkbox"
                          aria-label={`${candidate.label}${primary ? " (primary)" : ""}`}
                          aria-describedby={candidate.description ? `${headingId}-${candidate.id}-description` : undefined}
                          checked={checked}
                          disabled={!canEditCurrent || primary}
                          onChange={() => {
                            const assignments =
                              current?.assignedCategories ?? [];
                            if (assignments.includes(candidate.id)) {
                              updateCurrent({
                                assignedCategories: assignments.filter(
                                  (id) => id !== candidate.id,
                                ),
                                error: null,
                              });
                              return;
                            }
                            if (assignments.length >= 8) {
                              updateCurrent({
                                error:
                                  "Choose no more than eight categories.",
                              });
                              return;
                            }
                            updateCurrent({
                              assignedCategories: [
                                ...assignments,
                                candidate.id,
                              ],
                              error: null,
                            });
                          }}
                        />
                        <span>
                          {candidate.label}{primary ? " (primary)" : ""}
                          {candidate.description ? <small id={`${headingId}-${candidate.id}-description`}>{candidate.description}</small> : null}
                        </span>
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          ) : null}
          {current?.file ? (
            <div className="media-upload-license-field">
              <label htmlFor={currentLicenseInputId}>License</label>
              <TextInput
                id={currentLicenseInputId}
                value={current.license}
                maxLength={120}
                aria-describedby={currentLicenseHintId}
                disabled={!canEditCurrent}
                onChange={(event) =>
                  updateCurrent({
                    license: event.target.value,
                    licenseOverridden: true,
                    error: null,
                  })
                }
              />
              <span className="field-hint" id={currentLicenseHintId}>
                {current.licenseOverridden
                  ? "Custom license for this file. Later batch-default changes will not replace it."
                  : batchLicense.trim()
                    ? "Using the batch license default. Edit this value to customize this file."
                    : "No batch license is set. Enter the license for this file."}
              </span>
              {current.license.trim() ? null : (
                <InlineMessage tone="warning" title="No license entered">
                  {currentIsAudio
                    ? "You can upload without a license. Enter it here if known so the rights are on record."
                    : "You can upload this file without a license. Add the license later in the media library so the rights are on record."}
                </InlineMessage>
              )}
            </div>
          ) : null}
          <label>
            Credit
            <TextInput
              value={current?.credit ?? ""}
              maxLength={300}
              disabled={!canEditCurrent}
              onChange={(event) =>
                updateCurrent({ credit: event.target.value, error: null })
              }
            />
          </label>
          <label>
            Tags
            <TextInput
              value={current?.tags ?? ""}
              placeholder="studio, control room"
              disabled={!canEditCurrent}
              onChange={(event) =>
                updateCurrent({ tags: event.target.value, error: null })
              }
            />
          </label>
          {currentIsAudio || currentIsDocument ? null : <label>
            Alt-text suggestion
            <TextInput
              value={current?.altText ?? ""}
              maxLength={500}
              disabled={!canEditCurrent}
              onChange={(event) =>
                updateCurrent({ altText: event.target.value, error: null })
              }
            />
          </label>}
        </div>
        {currentIsAudio || currentIsDocument ? null : <div>
          <div className="editor-field-label-row"><label className="media-upload-processing">
            <input
              checked={current?.optimizeToWebp ?? true}
              disabled={!canEditCurrent}
              onChange={(event) =>
                updateCurrent({ optimizeToWebp: event.target.checked })
              }
              type="checkbox"
            />
            Optimize JPEG and PNG files and convert them to WebP
          </label><InfoTooltip label="Image optimization" content="On by default. Turn this off to keep the original JPEG or PNG file. Other file types stay unchanged." /></div>
        </div>}
        <label>
          Description
          <Textarea
            value={current?.description ?? ""}
            placeholder={batchDescription || undefined}
            maxLength={2_000}
            rows={2}
            disabled={!canEditCurrent}
            onChange={(event) =>
              updateCurrent({ description: event.target.value, error: null })
            }
          />
        </label>
        <label className="media-upload-processing"><input type="checkbox" disabled={!canEditCurrent} checked={current?.metadataUpdateRequested ?? false}
          onChange={event => updateCurrent({ metadataUpdateRequested: event.target.checked, metadataRequestOverridden: true })} /> Request metadata update</label>
        <small>Records a request for tags, description and alt text where supported. Person-edited values must be kept.</small>
        {current?.error ? (
          <InlineMessage tone="error" title="Media was not uploaded">
            {current.error}
            {current.duplicateAssetId ? <p>{canOpenRecycleBin ? "The matching image may be in the Recycle bin. Restore it from the Media library's Recycle bin." : "The matching image may be in the Recycle bin. Ask a media manager to restore it."} {canOpenRecycleBin && librarySearch !== undefined ? <Link to={`${mediaImagesPath()}?${binParams}&binAsset=${encodeURIComponent(current.duplicateAssetId)}`}>Find it in the Recycle bin</Link> : null}</p> : null}
          </InlineMessage>
        ) : null}
        {succeeded.length > 0 && (pending.length > 0 || failed.length > 0) ? (
          <InlineMessage tone="success" title="Uploaded files are safe">
            {succeeded.length} completed{" "}
            {succeeded.length === 1 ? "asset is" : "assets are"} already in the
            library. Closing or stopping this batch will not remove{" "}
            {succeeded.length === 1 ? "it" : "them"}.
          </InlineMessage>
        ) : null}

        <div className="media-upload-step-actions">
          <Button
            disabled={busy || currentIndex <= 0}
            onClick={() =>
              setCurrentIndex((index) => Math.max(0, index - 1))
            }
          >
            Previous file
          </Button>
          <Button
            disabled={busy || currentIndex >= items.length - 1}
            onClick={() =>
              setCurrentIndex((index) =>
                Math.min(items.length - 1, index + 1),
              )
            }
          >
            Next file
          </Button>
        </div>
        {realItems.length > 1 ? (
          <p className="field-hint">
            Upload all files uses their current details. Staff with media
            management access can add or change details later.
          </p>
        ) : null}
        <div className="media-form-actions">
          {uploadingBatch || pending.length > 1 ? (
            <AsyncActionButton
              disabled={pending.length < 2}
              label="Upload all files"
              onClick={() => void uploadAllFiles()}
              pending={uploadingBatch}
              pendingLabel="Uploading batch…"
              type="button"
              variant="primary"
            />
          ) : null}
          {!uploadingBatch && current?.status !== "succeeded" ? (
            <AsyncActionButton
              disabled={!current?.file}
              label={
                current?.status === "failed"
                  ? "Retry upload"
                  : realItems.length <= 1
                    ? "Upload"
                    : "Upload file"
              }
              pending={uploading}
              pendingLabel="Uploading…"
              type="submit"
              variant={realItems.length > 1 ? "secondary" : "primary"}
            />
          ) : null}
          {current?.status === "failed" && nextPendingIndex >= 0 ? (
            <Button onClick={continueBatch}>Continue with remaining files</Button>
          ) : null}
          {current?.status === "failed" && nextPendingIndex < 0 ? (
            <Button onClick={() => completeBatch(items)}>Finish batch</Button>
          ) : null}
          {current &&
          current.status !== "succeeded" &&
          current.status !== "uploading" &&
          current.file ? (
            <Button variant="ghost" onClick={removeCurrent}>
              Remove file
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => {
              if (!busy) {
                onCancel();
                return;
              }
              stopBatchRequested.current = true;
              const controller = activeController.current;
              controller?.abort();
              if (!controller && current) {
                updateCurrent({
                  status: "failed",
                  error: "The upload was canceled.",
                });
              }
            }}
          >
            {uploadingBatch ? "Stop batch" : uploading ? "Stop upload" : "Cancel"}
          </Button>
        </div>
      </form>
      {uploading && current?.file ? (
        <p
          role="status"
          aria-label="Media upload progress"
          aria-live="polite"
        >
          {current.file.name} is uploading. Other files are waiting.
        </p>
      ) : null}
    </Panel>
  );
}
