import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import {
  cmsListAuthorPagePosts,
  type AuthorPagePostSummary,
} from "./functions";

export interface AuthorPagePostsState {
  posts: AuthorPagePostSummary[];
  state: "loading" | "ready" | "error";
  hasMore: boolean;
  loadingMore: boolean;
  moreError: string | null;
  loadMore: () => Promise<void>;
  reload: () => void;
}

/**
 * A bounded cursor reader for the published Posts credited to one authorId.
 *
 * Changing the selected author clears the previous page immediately, and a late
 * response for the old selection is ignored. A later-page failure keeps the
 * options already loaded and retains the cursor so the same button can retry.
 */
export function useAuthorPagePosts(
  authorId: string | null,
  enabled: boolean,
): AuthorPagePostsState {
  const { getIdToken } = useAuth();
  const [posts, setPosts] = useState<AuthorPagePostSummary[]>([]);
  const [state, setState] =
    useState<AuthorPagePostsState["state"]>("loading");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const currentAuthorId = useRef(authorId);
  currentAuthorId.current = authorId;

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    setPosts([]);
    setNextCursor(null);
    setMoreError(null);
    setLoadingMore(false);
    if (!enabled || authorId === null) {
      setState("loading");
      return;
    }

    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const idToken = await getIdToken();
        const response = await cmsListAuthorPagePosts(idToken, { authorId });
        if (cancelled) return;
        setPosts(response.posts);
        setNextCursor(response.nextCursor);
        setState("ready");
      } catch {
        if (cancelled) return;
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authorId, attempt, enabled, getIdToken]);

  const loadMore = useCallback(async () => {
    if (
      !enabled ||
      authorId === null ||
      nextCursor === null ||
      loadingMore
    ) {
      return;
    }

    const requestedAuthorId = authorId;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const idToken = await getIdToken();
      const response = await cmsListAuthorPagePosts(idToken, {
        authorId: requestedAuthorId,
        startAfter: nextCursor,
      });
      if (currentAuthorId.current !== requestedAuthorId) return;
      setPosts((current) => [...current, ...response.posts]);
      setNextCursor(response.nextCursor);
    } catch {
      if (currentAuthorId.current === requestedAuthorId) {
        setMoreError("More posts could not be loaded. Try again.");
      }
    } finally {
      if (currentAuthorId.current === requestedAuthorId) {
        setLoadingMore(false);
      }
    }
  }, [authorId, enabled, getIdToken, loadingMore, nextCursor]);

  return {
    posts,
    state,
    hasMore: nextCursor !== null,
    loadingMore,
    moreError,
    loadMore,
    reload,
  };
}
