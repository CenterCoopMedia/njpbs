import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { HttpError, type ListMediaResponse, type MediaListQuery } from "./functions";
import { cacheMediaList, cachedMediaList, invalidateMediaLists, mediaListRevision } from "./media-session-cache";

export type MediaLibraryListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  // query is the list query this result answers, so the status names the filters it shows.
  | { status: "ready"; result: ListMediaResponse; query: MediaListQuery; error?: string };

interface MediaLibraryListOptions {
  attempt: number;
  loadMedia: (query: MediaListQuery, options?: { tabCounts?: boolean }) => Promise<ListMediaResponse>;
  requestKey: string;
  requestQuery: MediaListQuery;
  userId: string;
  mediaIdentity: string;
  locationPage: number;
  setState: Dispatch<SetStateAction<MediaLibraryListState>>;
  setUpdating: (updating: boolean) => void;
  setCursorRestartRequired: (required: boolean) => void;
  restartList: () => void;
  onCountChange: (count: number | null, revision: number) => void;
  onLoaded: (result: ListMediaResponse) => void;
  onFailed: () => void;
  onCorrectPage: (result: ListMediaResponse) => void;
}

export function useMediaLibraryList({
  attempt,
  loadMedia,
  requestKey,
  requestQuery,
  userId,
  mediaIdentity,
  locationPage,
  setState,
  setUpdating,
  setCursorRestartRequired,
  restartList,
  onCountChange,
  onLoaded,
  onFailed,
  onCorrectPage,
}: MediaLibraryListOptions) {
  const stateUserId = useRef(userId);
  const statePrincipal = useRef(mediaIdentity);

  useEffect(() => {
    if (locationPage !== 1) return;
    let current = true;
    const cached = cachedMediaList(userId, requestQuery);
    if (stateUserId.current !== userId || statePrincipal.current !== mediaIdentity) {
      stateUserId.current = userId;
      statePrincipal.current = mediaIdentity;
      setState(cached ? { status: "ready", result: cached, query: requestQuery } : { status: "loading" });
    } else if (cached) {
      setState({ status: "ready", result: cached, query: requestQuery });
    }
    const requestRevision = mediaListRevision();
    // Cached lists are cleared on every invalidation, so a cached total belongs to this revision.
    if (cached && cached.allCount !== null) onCountChange(cached.allCount, requestRevision);
    const timer = globalThis.setTimeout(
      () => {
        setUpdating(true);
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, error: undefined }
            : previous,
        );
        void loadMedia(requestQuery, { tabCounts: true })
          .then((result) => {
            if (!current) return;
            setCursorRestartRequired(false);
            if (mediaListRevision() !== requestRevision) {
              setUpdating(false);
              restartList();
              return;
            }
            cacheMediaList(userId, requestQuery, result, requestRevision);
            if (result.allCount !== null) onCountChange(result.allCount, requestRevision);
            setState({ status: "ready", result, query: requestQuery });
            onLoaded(result);
            setUpdating(false);
            onCorrectPage(result);
          })
          .catch((loadError: unknown) => {
            if (!current) return;
            onFailed();
            const message =
              loadError instanceof Error
                ? loadError.message
                : "The media library could not be loaded.";
            setCursorRestartRequired(Boolean(requestQuery.cursor) && loadError instanceof HttpError &&
              (loadError.status === 409 || loadError.status === 410 || loadError.status === 503));
            onCountChange(null, mediaListRevision());
            if (loadError instanceof HttpError && (loadError.status === 401 || loadError.status === 403)) {
              invalidateMediaLists();
              setState({ status: "error", message });
              setUpdating(false);
              return;
            }
            setState((previous) =>
              previous.status === "ready"
                ? { ...previous, query: requestQuery, error: message }
                : { status: "error", message },
            );
            setUpdating(false);
          });
      },
      0,
    );
    return () => {
      current = false;
      globalThis.clearTimeout(timer);
    };
    // The request key tracks the list query. Selection changes do not reload the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, loadMedia, requestKey, userId, mediaIdentity, locationPage]);
}
