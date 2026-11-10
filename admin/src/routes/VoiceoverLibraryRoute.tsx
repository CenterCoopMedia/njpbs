import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useBeforeUnload, useBlocker } from "react-router";
import { parseMediaWorkspacePath } from "../lib/routes";
import { useAuth } from "../context/AuthContext";
import { canAccessAdmin } from "../lib/access";
import { isConflictError } from "../lib/functions";
import {
  cmsGetVoiceoverAudio,
  cmsListVoiceovers,
  cmsSaveVoiceoverReview,
  type VoiceoverLibraryResponse,
  type VoiceoverReview,
  type VoiceoverTake,
} from "../lib/voiceovers";
import type { ExitSaveOutcome } from "../lib/exit-save";
import {
  Button,
  EmptyState,
  InlineMessage,
  Panel,
  Textarea,
} from "../components/ui/Primitives";
import { MediaToolbar, type MediaToolbarSurfaceConfiguration } from "../components/media/MediaToolbar";
import { VoiceoverListenButton, VoiceoverPlayer } from "../components/VoiceoverPlayer";
import { deriveWaveformPeaks } from "../lib/waveform";
import { Icon } from "../components/ui/Icon";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { RequireCapability } from "./RequireCapability";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import { useShell } from "./ShellContext";
import "./VoiceoverLibraryRoute.css";

const NOTE_DEBOUNCE_MS = 500;

type ReviewStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

interface ReviewDraft extends VoiceoverReview {
  revision: number;
  status: ReviewStatus;
  error: string | null;
}

type LibraryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; library: VoiceoverLibraryResponse };

type AudioState = Record<string, { status: "loading" | "error"; message?: string }>;

function reviewDraft(review?: VoiceoverReview): ReviewDraft {
  return {
    favorite: review?.favorite ?? false,
    moreLikeThis: review?.moreLikeThis ?? false,
    notes: review?.notes ?? "",
    version: review?.version ?? 0,
    updatedAt: review?.updatedAt ?? null,
    revision: 0,
    status: "saved",
    error: null,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function styleLabel(style: string): string {
  return style ? `${style.slice(0, 1).toUpperCase()}${style.slice(1)}` : style;
}

function formatDuration(value?: number): string | null {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return null;
  return `${value.toFixed(1)} seconds`;
}

function takeNotes(take: VoiceoverTake): string[] {
  const notes: string[] = [];
  if (take.flags.includes("program_insert")) {
    notes.push(take.insert_note ?? "Brackets mark where to insert the program or broadcast title.");
  }
  if (take.flags.includes("url_needs_listener_check")) {
    notes.push("Check spoken URL.");
  }
  if (take.flags.includes("transcript_needs_listener_check")) {
    notes.push("Check the recorded wording.");
  }
  if (take.flags.includes("source_peak_clipping")) {
    notes.push("Source peak clipping. Compare another take.");
  }
  if (!take.complete) notes.push("Incomplete attempt.");
  return notes;
}

function reviewStatusLabel(review: ReviewDraft): string {
  if (review.status === "saving") return "Saving";
  if (review.status === "unsaved") return "Changes waiting to save";
  if (review.status === "conflict") return "Needs review";
  if (review.status === "error") return "Could not save";
  return "Saved";
}

function VoiceoverLibrarySurface({
  extraExitRisk = false,
  videoTransferActive = false,
  onDiscardExtra,
  onDiscardVideo,
}: {
  extraExitRisk?: boolean;
  videoTransferActive?: boolean;
  onDiscardExtra?: () => void;
  onDiscardVideo?: () => void;
}) {
  const extraExitRef = useRef(extraExitRisk);
  extraExitRef.current = extraExitRisk;
  const { getIdToken } = useAuth();
  const { user } = useShell();
  const [libraryState, setLibraryState] = useState<LibraryState>({ status: "loading" });
  const [reviews, setReviews] = useState<Record<string, ReviewDraft>>({});
  const [search, setSearch] = useState("");
  const [searchReset, setSearchReset] = useState(0);
  const [style, setStyle] = useState("");
  const [performer, setPerformer] = useState("");
  const [family, setFamily] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showIncomplete, setShowIncomplete] = useState(false);
  const [audioState, setAudioState] = useState<AudioState>({});
  const [waveforms, setWaveforms] = useState<Record<string, number[]>>({});
  const [loadedAudioIds, setLoadedAudioIds] = useState<Record<string, true>>({});
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const activePlayerIdRef = useRef<string | null>(null);
  const playerToggleRef = useRef<HTMLButtonElement | null>(null);
  const audioStateRef = useRef(audioState);
  activePlayerIdRef.current = activePlayerId;
  audioStateRef.current = audioState;
  const reviewsRef = useRef<Record<string, ReviewDraft>>({});
  const sessionRef = useRef(0);
  const saveTimersRef = useRef(new Map<string, number>());
  const saveChainsRef = useRef(new Map<string, Promise<void>>());
  const saveControllersRef = useRef(new Set<AbortController>());
  const libraryControllerRef = useRef<AbortController | null>(null);
  const refreshesRef = useRef(new Map<string, { controller: AbortController; sequence: number }>());
  const refreshSequenceRef = useRef(0);
  const activePlaybackRef = useRef<{
    takeId: string;
    controller: AbortController;
    sequence: number;
  } | null>(null);
  const playbackSequenceRef = useRef(0);
  const downloadControllersRef = useRef(new Set<AbortController>());
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const audioUrlsRef = useRef(new Map<string, string>());
  const downloadUrlsRef = useRef(new Set<string>());

  const replaceReview = useCallback(
    (takeId: string, change: (current: ReviewDraft) => ReviewDraft): ReviewDraft => {
      const current = reviewsRef.current[takeId] ?? reviewDraft();
      const nextReview = change(current);
      const next = { ...reviewsRef.current, [takeId]: nextReview };
      reviewsRef.current = next;
      setReviews(next);
      return nextReview;
    },
    [],
  );

  const clearAudioForTake = useCallback((takeId: string) => {
    const url = audioUrlsRef.current.get(takeId);
    const element = audioRefs.current.get(takeId);
    element?.pause();
    audioUrlsRef.current.delete(takeId);
    if (element) {
      element.removeAttribute("src");
      element.load();
    }
    if (url) URL.revokeObjectURL(url);
    setLoadedAudioIds((current) => {
      if (!current[takeId]) return current;
      const next = { ...current };
      delete next[takeId];
      return next;
    });
  }, []);

  const clearOtherAudio = useCallback((exceptId?: string) => {
    for (const takeId of [...audioUrlsRef.current.keys()]) {
      if (takeId !== exceptId) clearAudioForTake(takeId);
    }
    for (const [takeId, element] of audioRefs.current) {
      if (takeId !== exceptId) element.pause();
    }
  }, [clearAudioForTake]);

  const clearAllAudio = useCallback(() => {
    clearOtherAudio();
    activePlaybackRef.current?.controller.abort();
    activePlaybackRef.current = null;
    for (const controller of downloadControllersRef.current) controller.abort();
    downloadControllersRef.current.clear();
    for (const url of downloadUrlsRef.current) URL.revokeObjectURL(url);
    downloadUrlsRef.current.clear();
    setAudioState({});
  }, [clearOtherAudio]);

  const loadLibrary = useCallback(async () => {
    const session = ++sessionRef.current;
    libraryControllerRef.current?.abort();
    const controller = new AbortController();
    libraryControllerRef.current = controller;
    setLibraryState({ status: "loading" });
    setWaveforms({});
    try {
      const response = await cmsListVoiceovers(await getIdToken(), controller.signal);
      if (session !== sessionRef.current || controller.signal.aborted) return;
      const nextReviews = Object.fromEntries(
        response.takes.map((take) => [take.id, reviewDraft(response.reviews[take.id])]),
      );
      reviewsRef.current = nextReviews;
      setReviews(nextReviews);
      setLibraryState({ status: "ready", library: response });
    } catch (error) {
      if (session !== sessionRef.current || controller.signal.aborted) return;
      setLibraryState({
        status: "error",
        message: errorMessage(error, "The voiceover library could not be loaded."),
      });
    } finally {
      if (libraryControllerRef.current === controller) {
        libraryControllerRef.current = null;
      }
    }
  }, [getIdToken]);

  useEffect(() => {
    void loadLibrary();
    return () => {
      sessionRef.current += 1;
      libraryControllerRef.current?.abort();
      libraryControllerRef.current = null;
      for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
      saveTimersRef.current.clear();
      for (const controller of saveControllersRef.current) controller.abort();
      saveControllersRef.current.clear();
      for (const refresh of refreshesRef.current.values()) refresh.controller.abort();
      refreshesRef.current.clear();
      clearAllAudio();
      reviewsRef.current = {};
    };
  }, [clearAllAudio, loadLibrary, user.uid]);

  const saveCurrentDraft = useCallback(async (takeId: string, manifestVersion?: number): Promise<void> => {
    const draft = reviewsRef.current[takeId];
    if (!draft || draft.status === "saved" || draft.status === "conflict") return;
    const submittedRevision = draft.revision;
    const submittedVersion = draft.version;
    const submitted = {
      favorite: draft.favorite,
      moreLikeThis: draft.moreLikeThis,
      notes: draft.notes,
    };
    const session = sessionRef.current;
    const controller = new AbortController();
    saveControllersRef.current.add(controller);
    replaceReview(takeId, (current) =>
      current.revision === submittedRevision
        ? { ...current, status: "saving", error: null }
        : current,
    );
    try {
      const response = await cmsSaveVoiceoverReview(
        await getIdToken(),
        {
          manifestVersion: manifestVersion ?? (libraryState.status === "ready"
            ? libraryState.library.manifestVersion
            : 1),
          takeId,
          baseVersion: submittedVersion,
          ...submitted,
        },
        controller.signal,
      );
      if (session !== sessionRef.current || controller.signal.aborted) return;
      replaceReview(takeId, (current) => {
        if (current.revision === submittedRevision) {
          return {
            ...response.review,
            revision: current.revision,
            status: "saved",
            error: null,
          };
        }
        return {
          ...current,
          version: response.review.version,
          updatedAt: response.review.updatedAt,
          status: current.status === "conflict" ? "conflict" : "unsaved",
          error: null,
        };
      });
    } catch (error) {
      if (session !== sessionRef.current || controller.signal.aborted) return;
      replaceReview(takeId, (current) => {
        if (isConflictError(error)) {
          return {
            ...current,
            status: "conflict",
            error: "This take changed in another session. Reload it or retry your saved choices.",
          };
        }
        if (current.revision !== submittedRevision) return current;
        return {
          ...current,
          status: "error",
          error: errorMessage(error, "Your choices could not be saved. Try again."),
        };
      });
    } finally {
      saveControllersRef.current.delete(controller);
    }
  }, [getIdToken, libraryState, replaceReview]);

  const queueSave = useCallback((takeId: string, manifestVersion?: number): Promise<void> => {
    setPendingSaveCount((count) => count + 1);
    const previous = saveChainsRef.current.get(takeId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => saveCurrentDraft(takeId, manifestVersion));
    saveChainsRef.current.set(takeId, next);
    void next.finally(() => {
      if (saveChainsRef.current.get(takeId) === next) {
        saveChainsRef.current.delete(takeId);
      }
      setPendingSaveCount((count) => Math.max(0, count - 1));
    });
    return next;
  }, [saveCurrentDraft]);

  const scheduleSave = useCallback((takeId: string, delay: number) => {
    const previous = saveTimersRef.current.get(takeId);
    if (previous !== undefined) {
      clearTimeout(previous);
    } else {
      setPendingSaveCount((count) => count + 1);
    }
    const timer = window.setTimeout(() => {
      saveTimersRef.current.delete(takeId);
      setPendingSaveCount((count) => Math.max(0, count - 1));
      void queueSave(takeId);
    }, delay);
    saveTimersRef.current.set(takeId, timer);
  }, [queueSave]);

  const editReview = useCallback(
    (takeId: string, edit: (current: ReviewDraft) => ReviewDraft, delay: number) => {
      const next = replaceReview(takeId, (current) => {
        const changed = edit(current);
        return {
          ...changed,
          revision: current.revision + 1,
          status: current.status === "conflict" ? "conflict" : "unsaved",
          error: current.status === "conflict" ? current.error : null,
        };
      });
      if (next.status !== "conflict") scheduleSave(takeId, delay);
    },
    [replaceReview, scheduleSave],
  );

  const refreshReview = useCallback(async (takeId: string, keepDraft: boolean) => {
    const session = sessionRef.current;
    const local = reviewsRef.current[takeId];
    if (!local) return;
    const requestedRevision = local.revision;
    refreshesRef.current.get(takeId)?.controller.abort();
    const request = {
      controller: new AbortController(),
      sequence: ++refreshSequenceRef.current,
    };
    refreshesRef.current.set(takeId, request);
    try {
      const response = await cmsListVoiceovers(
        await getIdToken(),
        request.controller.signal,
      );
      if (
        session !== sessionRef.current ||
        request.controller.signal.aborted ||
        refreshesRef.current.get(takeId) !== request
      ) return;
      if (!response.takes.some((take) => take.id === takeId)) {
        throw new Error("This take is no longer in the library. Copy your notes before reloading the page.");
      }
      setLibraryState({ status: "ready", library: response });
      const server = reviewDraft(response.reviews[takeId]);
      let applied = false;
      replaceReview(takeId, (current) =>
        current.revision !== requestedRevision
          ? current
          : (() => {
              applied = true;
              return keepDraft
                ? {
                    ...current,
                    version: server.version,
                    updatedAt: server.updatedAt,
                    status: "unsaved",
                    error: null,
                  }
                : {
                    ...server,
                    revision: current.revision,
                  };
            })(),
      );
      if (keepDraft && applied) void queueSave(takeId, response.manifestVersion);
    } catch (error) {
      if (
        session !== sessionRef.current ||
        request.controller.signal.aborted ||
        refreshesRef.current.get(takeId) !== request
      ) return;
      replaceReview(takeId, (current) => ({
        ...current,
        status: "conflict",
        error: errorMessage(error, "The latest saved review could not be loaded."),
      }));
    } finally {
      if (refreshesRef.current.get(takeId) === request) {
        refreshesRef.current.delete(takeId);
      }
    }
  }, [getIdToken, queueSave, replaceReview]);

  const reviewsUnsaved = useCallback(
    () => Object.values(reviewsRef.current).some((review) => review.status !== "saved"),
    [],
  );
  const videoActiveRef = useRef(videoTransferActive);
  videoActiveRef.current = videoTransferActive;
  const hasUnsavedWork = useCallback(
    () => extraExitRef.current || videoActiveRef.current || reviewsUnsaved(),
    [reviewsUnsaved],
  );

  const saveAllForExit = useCallback(async (): Promise<ExitSaveOutcome> => {
    const pendingIds = Object.entries(reviewsRef.current)
      .filter(([, review]) => review.status !== "saved")
      .map(([takeId]) => takeId);
    if (pendingIds.some((takeId) => reviewsRef.current[takeId]?.status === "conflict")) {
      return { status: "failed" };
    }
    for (const takeId of pendingIds) {
      const timer = saveTimersRef.current.get(takeId);
      if (timer !== undefined) {
        clearTimeout(timer);
        saveTimersRef.current.delete(takeId);
        setPendingSaveCount((count) => Math.max(0, count - 1));
      }
    }
    await Promise.all(pendingIds.map((takeId) => queueSave(takeId)));
    if (reviewsUnsaved()) return { status: "failed" };
    const items = [
      ...(extraExitRef.current && discardUpload.current ? ["Image upload"] : []),
      ...(videoActiveRef.current && losesRoutedVideo.current ? ["Video upload"] : []),
    ];
    if (items.length > 0) return { status: "unsaved-elsewhere", items };
    return { status: "saved" };
  }, [queueSave, reviewsUnsaved]);

  const saving = pendingSaveCount > 0;
  useRegisterExitGuard({ saving, hasUnsavedWork, save: saveAllForExit });
  useBeforeUnload(
    useCallback((event) => {
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    }, [hasUnsavedWork]),
  );
  const discardUpload = useRef(true);
  const losesRoutedVideo = useRef(true);
  const blocker = useBlocker(({ nextLocation }: { nextLocation: { pathname: string; search: string } }) => {
    const kind = parseMediaWorkspacePath(nextLocation.pathname).kind;
    const leavesWorkspace = kind === "not-found";
    const opensRecycleBin = kind === "images"
      && new URLSearchParams(nextLocation.search).get("bin") === "1";
    discardUpload.current = leavesWorkspace || opensRecycleBin;
    losesRoutedVideo.current = leavesWorkspace;
    if (saving || reviewsUnsaved()) return true;
    if (videoTransferActive && losesRoutedVideo.current) return true;
    return extraExitRef.current && discardUpload.current;
  });

  const playTake = useCallback(async (take: VoiceoverTake) => {
    const previousPlayback = activePlaybackRef.current;
    if (previousPlayback) {
      previousPlayback.controller.abort();
      activePlaybackRef.current = null;
      setAudioState((current) => {
        if (!current[previousPlayback.takeId]) return current;
        const next = { ...current };
        delete next[previousPlayback.takeId];
        return next;
      });
    }
    clearOtherAudio(take.id);
    const element = audioRefs.current.get(take.id);
    const existing = audioUrlsRef.current.get(take.id);
    if (element && existing) {
      try {
        await element.play();
      } catch (error) {
        setAudioState((current) => ({
          ...current,
          [take.id]: { status: "error", message: errorMessage(error, "Audio could not start.") },
        }));
      }
      return;
    }
    const session = sessionRef.current;
    const request = {
      takeId: take.id,
      controller: new AbortController(),
      sequence: ++playbackSequenceRef.current,
    };
    activePlaybackRef.current = request;
    setAudioState((current) => ({ ...current, [take.id]: { status: "loading" } }));
    try {
      const blob = await cmsGetVoiceoverAudio(
        await getIdToken(),
        take.id,
        request.controller.signal,
      );
      if (
        session !== sessionRef.current ||
        request.controller.signal.aborted ||
        activePlaybackRef.current !== request
      ) return;
      const audio = audioRefs.current.get(take.id);
      if (!audio) return;
      const url = URL.createObjectURL(blob);
      audioUrlsRef.current.set(take.id, url);
      audio.src = url;
      audio.load();
      setLoadedAudioIds((current) => ({ ...current, [take.id]: true }));
      setAudioState((current) => {
        const next = { ...current };
        delete next[take.id];
        return next;
      });
      await audio.play();
      if (!waveforms[take.id]) {
        // Reuse the requested WAV. A waveform is optional and never delays playback.
        void deriveWaveformPeaks(blob).then((peaks) => {
          if (session !== sessionRef.current || audioUrlsRef.current.get(take.id) !== url) return;
          setWaveforms((current) => ({ ...current, [take.id]: peaks }));
        }).catch(() => {});
      }
    } catch (error) {
      if (
        session !== sessionRef.current ||
        request.controller.signal.aborted ||
        activePlaybackRef.current !== request
      ) return;
      setAudioState((current) => ({
        ...current,
        [take.id]: {
          status: "error",
          message: errorMessage(error, "Audio could not be loaded."),
        },
      }));
    } finally {
      if (activePlaybackRef.current === request) activePlaybackRef.current = null;
    }
  }, [clearOtherAudio, getIdToken, waveforms]);

  const listenToTake = useCallback((take: VoiceoverTake) => {
    const opening = activePlayerIdRef.current !== take.id;
    // A download uses the same per-take loading flag. Ignore Listen until it finishes.
    if (opening && audioStateRef.current[take.id]?.status === "loading") return;
    // The player has to commit before playTake can read its audio element.
    if (opening) {
      flushSync(() => setActivePlayerId(take.id));
      playerToggleRef.current?.focus();
    }
    void playTake(take);
  }, [playTake]);

  const downloadTake = useCallback(async (take: VoiceoverTake) => {
    const session = sessionRef.current;
    const controller = new AbortController();
    downloadControllersRef.current.add(controller);
    setAudioState((current) => ({ ...current, [take.id]: { status: "loading" } }));
    try {
      const blob = await cmsGetVoiceoverAudio(
        await getIdToken(),
        take.id,
        controller.signal,
      );
      if (session !== sessionRef.current || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      downloadUrlsRef.current.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${take.id}.wav`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        downloadUrlsRef.current.delete(url);
      }, 1_000);
      setAudioState((current) => {
        const next = { ...current };
        delete next[take.id];
        return next;
      });
    } catch (error) {
      if (session !== sessionRef.current || controller.signal.aborted) return;
      setAudioState((current) => ({
        ...current,
        [take.id]: {
          status: "error",
          message: errorMessage(error, "The WAV download could not be prepared."),
        },
      }));
    } finally {
      downloadControllersRef.current.delete(controller);
    }
  }, [getIdToken]);

  const registerAudio = useCallback((takeId: string, element: HTMLAudioElement | null) => {
    if (element) {
      audioRefs.current.set(takeId, element);
      return;
    }
    const existing = audioRefs.current.get(takeId);
    if (!existing) return;
    existing.pause();
    audioRefs.current.delete(takeId);
  }, []);

  const library = libraryState.status === "ready" ? libraryState.library : null;
  const styles = useMemo(
    () => library ? [...new Set(library.takes.map((take) => take.style))] : [],
    [library],
  );
  const performers = useMemo(
    () => library ? [...new Set(library.takes.map((take) => take.performer_id))] : [],
    [library],
  );
  const families = useMemo(() => {
    if (!library) return [];
    return [...new Map(library.takes.map((take) => [take.family_id, take.family])).entries()];
  }, [library]);
  const incompleteCount = useMemo(
    () => library?.takes.filter((take) => !take.complete).length ?? 0,
    [library],
  );
  const visibleTakes = useMemo(() => {
    if (!library) return [];
    const query = search.trim().toLocaleLowerCase();
    return library.takes.filter((take) => {
      const review = reviews[take.id] ?? reviewDraft();
      if (!showIncomplete && !take.complete) return false;
      if (style && take.style !== style) return false;
      if (performer && take.performer_id !== performer) return false;
      if (family && take.family_id !== family) return false;
      if (favoritesOnly && !review.favorite) return false;
      if (!query) return true;
      return [take.family, take.text, take.display_text, take.style]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [family, favoritesOnly, library, performer, reviews, search, showIncomplete, style]);

  useEffect(() => {
    const visibleIds = new Set(visibleTakes.map((take) => take.id));
    const pending = activePlaybackRef.current;
    if (pending && !visibleIds.has(pending.takeId)) {
      pending.controller.abort();
      activePlaybackRef.current = null;
    }
    const mountedOrLoadedIds = new Set([
      ...audioRefs.current.keys(),
      ...audioUrlsRef.current.keys(),
    ]);
    for (const takeId of mountedOrLoadedIds) {
      if (visibleIds.has(takeId)) continue;
      clearAudioForTake(takeId);
      audioRefs.current.delete(takeId);
    }
    setAudioState((current) => {
      if (Object.keys(current).every((takeId) => visibleIds.has(takeId))) return current;
      return Object.fromEntries(Object.entries(current).filter(([takeId]) => visibleIds.has(takeId)));
    });
    setActivePlayerId((current) => (current && !visibleIds.has(current) ? null : current));
  }, [clearAudioForTake, visibleTakes]);

  if (libraryState.status === "loading") {
    return <LoadingIndicator label="Loading the voiceover library" stages={["Asking the CMS for your review choices"]} />;
  }

  if (libraryState.status === "error") {
    return (
      <InlineMessage tone="error" title="Voiceover library could not be loaded">
        <span>{libraryState.message}</span>
        <Button onClick={() => void loadLibrary()}>Try again</Button>
      </InlineMessage>
    );
  }

  const readyLibrary = libraryState.library;
  function clearFilters() {
    setSearch(""); setStyle(""); setPerformer(""); setFamily("");
    setFavoritesOnly(false); setShowIncomplete(false);
    setSearchReset((current) => current + 1);
  }
  function selectFilter(property: string, value: string) {
    if (property === "style") setStyle((current) => current === value ? "" : value);
    if (property === "recorder") setPerformer((current) => current === value ? "" : value);
    if (property === "line") setFamily((current) => current === value ? "" : value);
    if (property === "favorites") setFavoritesOnly((current) => !current);
    if (property === "incomplete") setShowIncomplete((current) => !current);
  }
  function removeFilter(property: string) {
    if (property === "style") setStyle("");
    if (property === "recorder") setPerformer("");
    if (property === "line") setFamily("");
    if (property === "favorites") setFavoritesOnly(false);
    if (property === "incomplete") setShowIncomplete(false);
  }
  const toolbar: MediaToolbarSurfaceConfiguration = {
    surface: "voiceovers",
    search: {
      value: search,
      onCommit: setSearch,
      onSubmit: setSearch,
      syncKey: `${user.uid}:${searchReset}`,
      id: "voiceover-search",
      label: "Search voiceover lines",
      landmarkLabel: "Voiceover search",
      placeholder: "Search line, text, or style",
      title: "Search voiceover lines · /",
      maxLength: 200,
    },
    filter: {
      properties: [
        {
          id: "style", label: "Style", picker: "options", appliedCount: style ? 1 : 0,
          options: styles.map((value) => ({ value, label: styleLabel(value), selected: style === value })),
        },
        {
          id: "recorder", label: "Recorder", picker: "options", appliedCount: performer ? 1 : 0,
          options: performers.map((value) => ({
            value,
            label: readyLibrary.performers[value]?.name ?? "Staff recorder",
            selected: performer === value,
          })),
        },
        {
          id: "line", label: "Line family", picker: "options", appliedCount: family ? 1 : 0,
          options: families.map(([value, label]) => ({ value, label, selected: family === value })),
        },
        {
          id: "favorites", label: "Favorites only", picker: "options", appliedCount: favoritesOnly ? 1 : 0,
          options: [{ value: "true", label: "Only favorites", selected: favoritesOnly }],
        },
        {
          id: "incomplete", label: "Incomplete attempts", picker: "options", appliedCount: showIncomplete ? 1 : 0,
          options: [{ value: "true", label: "Show incomplete attempts", selected: showIncomplete, count: incompleteCount }],
        },
      ],
      chips: [
        ...(style ? [{ key: "style", field: "style", value: style, label: `Style: ${styleLabel(style)}` }] : []),
        ...(performer ? [{
          key: "recorder", field: "recorder", value: performer,
          label: `Recorder: ${readyLibrary.performers[performer]?.name ?? "Staff recorder"}`,
        }] : []),
        ...(family ? [{
          key: "line", field: "line", value: family,
          label: `Line family: ${families.find(([value]) => value === family)?.[1] ?? "Selected line"}`,
        }] : []),
        ...(favoritesOnly ? [{ key: "favorites", field: "favorites", value: "true", label: "Favorites only: On" }] : []),
        ...(showIncomplete ? [{ key: "incomplete", field: "incomplete", value: "true", label: "Incomplete attempts: Shown" }] : []),
      ],
      onSelect: selectFilter,
      onRemove: (chip) => removeFilter(chip.field),
      onClearAll: clearFilters,
    },
    sort: null,
    display: null,
    upload: null,
    moreItems: [],
    shortcuts: null,
  };

  return (
    <section className="voiceover-library" aria-labelledby="voiceover-library-heading">
      <Panel className="voiceover-library-intro">
        <div>
          <h2 id="voiceover-library-heading">Audio</h2>
          <p>
            Listen to station voiceover takes and choose the reads you like. Your choices and notes are saved to your CMS account. Brackets mark where to insert a program or broadcast title.
          </p>
        </div>
        <p className="voiceover-library-count" aria-live="polite">
          {visibleTakes.length} of {readyLibrary.takes.length} takes
        </p>
      </Panel>

      <MediaToolbar configuration={toolbar} />

      {visibleTakes.length === 0 ? (
        <EmptyState
          title="No takes match these filters"
          description="Try a different search or clear one of the filters."
          action={<Button onClick={clearFilters}>Clear all</Button>}
        />
      ) : (
        <div className="table-frame voiceover-table-frame">
          <table className="voiceover-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Line reading</th>
                <th scope="col">Take details</th>
                <th scope="col">Recorded by</th>
                <th scope="col">Listen</th>
                <th scope="col">Download</th>
                <th scope="col">Your review</th>
              </tr>
            </thead>
            <tbody>
              {visibleTakes.map((take) => {
                const review = reviews[take.id] ?? reviewDraft();
                const notes = takeNotes(take);
                const audio = audioState[take.id];
                const loaded = Boolean(loadedAudioIds[take.id]);
                const duration = formatDuration(take.duration_seconds);
                const takeLabel = `${take.family}, ${styleLabel(take.style)}, take ${take.take}`;
                return (
                  <tr key={take.id} data-favorite={review.favorite || undefined}>
                    <th scope="row" data-label="Line">
                      <strong>{take.family}</strong>
                    </th>
                    <td data-label="Line reading">
                      <p className="voiceover-reading">{take.display_text ?? take.text}</p>
                      {notes.length ? (
                        <ul className="voiceover-take-notes">
                          {notes.map((note) => <li key={note}>{note}</li>)}
                        </ul>
                      ) : null}
                    </td>
                    <td data-label="Take details">
                      <div className="voiceover-take-details">
                        <span className="voiceover-style">{styleLabel(take.style)}</span>
                        <span className="voiceover-take-meta">Take {take.take}{duration ? <> · <span aria-label={duration}>{take.duration_seconds!.toFixed(1)}s</span></> : null}</span>
                      </div>
                    </td>
                    <td data-label="Recorded by">{readyLibrary.performers[take.performer_id]?.name ?? take.performer_id}</td>
                    <td data-label="Listen" className="voiceover-audio-cell" data-voiceover-take={take.id}>
                      {activePlayerId === take.id ? (
                        <VoiceoverPlayer
                          takeLabel={takeLabel}
                          loaded={loaded}
                          loading={audio?.status === "loading" && !loaded}
                          toggleRef={playerToggleRef}
                          peaks={waveforms[take.id] ?? null}
                          durationSeconds={take.duration_seconds}
                          onListen={() => listenToTake(take)}
                          onEnded={() => clearAudioForTake(take.id)}
                          onError={() => {
                            if (!audioUrlsRef.current.has(take.id)) return;
                            setAudioState((current) => ({
                              ...current,
                              [take.id]: { status: "error", message: "Audio playback stopped." },
                            }));
                          }}
                          onPlay={() => clearOtherAudio(take.id)}
                          registerAudio={(element) => registerAudio(take.id, element)}
                        />
                      ) : (
                        <VoiceoverListenButton
                          durationSeconds={take.duration_seconds}
                          loading={audio?.status === "loading"}
                          onListen={() => listenToTake(take)}
                          takeLabel={takeLabel}
                        />
                      )}
                      {audio?.status === "error" ? <p className="voiceover-audio-error" role="alert">{audio.message}</p> : null}
                    </td>
                    <td data-label="Download" className="voiceover-download-cell">
                      <Button className="voiceover-download" aria-label="Download WAV" title="Download WAV" disabled={audio?.status === "loading"} onClick={() => void downloadTake(take)}>
                        <Icon name="arrow-down" />
                      </Button>
                    </td>
                    <td data-label="Your review" className="voiceover-review-cell">
                      <div className="voiceover-review-actions">
                      <label className="voiceover-choice">
                        <input
                          checked={review.favorite}
                          onChange={(event) => editReview(take.id, (current) => ({ ...current, favorite: event.target.checked }), 0)}
                          type="checkbox"
                        />
                        Favorite
                      </label>
                      <details className="voiceover-review-details">
                        <summary aria-label={`Notes and requests${review.notes ? ", note added" : ""}${review.moreLikeThis ? ", more like this requested" : ""}`}>Notes{review.notes || review.moreLikeThis ? <span className="voiceover-review-indicator" aria-hidden="true" /> : null}</summary>
                        <label className="voiceover-choice">
                          <input
                            checked={review.moreLikeThis}
                            onChange={(event) => editReview(take.id, (current) => ({ ...current, moreLikeThis: event.target.checked }), 0)}
                            type="checkbox"
                          />
                          More like this
                        </label>
                        <label className="voiceover-note-label">
                          Notes
                          <Textarea
                            maxLength={2000}
                            onChange={(event) => editReview(take.id, (current) => ({ ...current, notes: event.target.value }), NOTE_DEBOUNCE_MS)}
                            value={review.notes}
                          />
                        </label>
                      </details>
                      </div>
                      <span className={`voiceover-save-status voiceover-save-status-${review.status}`} role="status">
                        {reviewStatusLabel(review)}
                      </span>
                      {review.error ? <p className="voiceover-review-error" role="alert">{review.error}</p> : null}
                      {review.status === "conflict" ? (
                        <div className="voiceover-conflict-actions">
                          <Button onClick={() => void refreshReview(take.id, false)} variant="ghost">Reload saved review</Button>
                          <Button onClick={() => void refreshReview(take.id, true)} variant="secondary">Retry my choices</Button>
                        </div>
                      ) : review.status === "error" ? (
                        <Button onClick={() => void queueSave(take.id)} variant="ghost">Retry save</Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {blocker.state === "blocked" ? (
        <LeaveGuardDialog
          onCancel={() => {
            discardUpload.current = true;
            losesRoutedVideo.current = true;
            blocker.reset();
          }}
          onConfirm={() => {
            if (discardUpload.current) onDiscardExtra?.();
            if (losesRoutedVideo.current) onDiscardVideo?.();
            discardUpload.current = true;
            losesRoutedVideo.current = true;
            blocker.proceed();
          }}
          onSave={saveAllForExit}
        />
      ) : null}
    </section>
  );
}

export function VoiceoverLibraryRoute({
  extraExitRisk = false,
  videoTransferActive = false,
  onDiscardExtra,
  onDiscardVideo,
}: {
  extraExitRisk?: boolean;
  videoTransferActive?: boolean;
  onDiscardExtra?: () => void;
  onDiscardVideo?: () => void;
}) {
  return (
    <RequireCapability
      allowed={canAccessAdmin}
      notice="The voiceover library is not available for your account."
    >
      <VoiceoverLibrarySurface extraExitRisk={extraExitRisk} videoTransferActive={videoTransferActive} onDiscardExtra={onDiscardExtra} onDiscardVideo={onDiscardVideo} />
    </RequireCapability>
  );
}
