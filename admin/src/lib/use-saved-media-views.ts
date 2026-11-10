import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaDisplayPreferences, VideoMediaDisplayPreferences } from "./media-display";
import {
  SavedMediaViewValidationError,
  applySavedMediaViewMutation,
  createSavedMediaView,
  parseSavedMediaViews,
  type SavedMediaView,
  type SavedMediaViewSurface,
} from "./saved-media-views";
import { loadMediaLibraryViews, mutateMediaLibraryViews } from "./saved-media-view-store";

export interface SavedMediaViewsConfiguration {
  userId: string;
  surface: SavedMediaViewSurface;
  query: string;
  currentViewId?: string;
  display?: MediaDisplayPreferences | VideoMediaDisplayPreferences;
  onApply: (view: SavedMediaView) => void;
  onMissing: (reason?: "deleted") => void;
  onResetFilters: () => void;
}

export interface SavedMediaViewsController {
  status: "idle" | "loading" | "ready" | "error";
  views: readonly SavedMediaView[];
  currentViewId?: string;
  error: string | null;
  busy: boolean;
  load: () => Promise<void>;
  apply: (view: SavedMediaView) => void;
  save: (name: string, includeDisplay: boolean) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  resetFilters: () => void;
}

interface AccountSession {
  userId: string;
  views: SavedMediaView[] | null;
  load: Promise<SavedMediaView[]> | null;
}

interface ControllerState {
  userId: string | null;
  status: SavedMediaViewsController["status"];
  views: SavedMediaView[];
  error: string | null;
  busy: boolean;
}

let activeSession: AccountSession | null = null;

function sessionFor(userId: string): AccountSession {
  if (activeSession?.userId !== userId) {
    activeSession = { userId, views: null, load: null };
  }
  return activeSession;
}

function stateFor(session: AccountSession | null): ControllerState {
  return session?.views
    ? { userId: session.userId, status: "ready", views: session.views, error: null, busy: false }
    : { userId: session?.userId ?? null, status: "idle", views: [], error: null, busy: false };
}

function message(error: unknown): string {
  return error instanceof SavedMediaViewValidationError || error instanceof Error
    ? error.message
    : "Your saved views could not be stored.";
}

/** One lazy, account-scoped controller shared by Filter and Display. */
export function useSavedMediaViews(
  configuration?: SavedMediaViewsConfiguration,
): SavedMediaViewsController {
  const userId = configuration?.userId ?? null;
  const session = useMemo(() => userId ? sessionFor(userId) : null, [userId]);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const [state, setState] = useState<ControllerState>(() => stateFor(session));
  const mutationRef = useRef(false);
  const missingRef = useRef<string | null>(null);

  useEffect(() => {
    mutationRef.current = false;
    missingRef.current = null;
    setState(stateFor(session));
  }, [session]);

  const load = useCallback(async () => {
    if (!session || !configurationRef.current || activeSession !== session) return;
    if (session.views) {
      setState(stateFor(session));
      return;
    }
    setState({ userId: session.userId, status: "loading", views: [], error: null, busy: false });
    session.load ??= loadMediaLibraryViews(session.userId).then((value) => {
      const views = parseSavedMediaViews(value);
      if (activeSession === session) session.views = views;
      return views;
    }).finally(() => {
      if (activeSession === session) session.load = null;
    });
    try {
      const views = await session.load;
      if (activeSession !== session || configurationRef.current?.userId !== session.userId) return;
      setState({ userId: session.userId, status: "ready", views, error: null, busy: false });
    } catch (error) {
      if (activeSession !== session || configurationRef.current?.userId !== session.userId) return;
      setState({ userId: session.userId, status: "error", views: [], error: message(error), busy: false });
    }
  }, [session]);

  const mutate = useCallback(async (
    mutation: Parameters<typeof mutateMediaLibraryViews>[1],
  ): Promise<boolean> => {
    if (!session || activeSession !== session || mutationRef.current) return false;
    mutationRef.current = true;
    setState((current) => ({ ...current, error: null, busy: true }));
    try {
      const next = parseSavedMediaViews(await mutateMediaLibraryViews(session.userId, mutation));
      if (activeSession !== session || configurationRef.current?.userId !== session.userId) return false;
      session.views = next;
      setState({ userId: session.userId, status: "ready", views: next, error: null, busy: false });
      return true;
    } catch (error) {
      if (activeSession === session && configurationRef.current?.userId === session.userId) {
        setState((current) => ({ ...current, error: message(error), busy: false }));
      }
      return false;
    } finally {
      mutationRef.current = false;
    }
  }, [session]);

  const save = useCallback(async (name: string, includeDisplay: boolean) => {
    const current = configurationRef.current;
    if (!current || !session || activeSession !== session || session.views === null) return false;
    let view: SavedMediaView;
    try {
      view = createSavedMediaView(
        globalThis.crypto.randomUUID().replaceAll("-", ""),
        name,
        current.surface,
        current.query,
        includeDisplay ? current.display : undefined,
      );
      applySavedMediaViewMutation(session.views, { type: "add", view });
    } catch (error) {
      setState((value) => ({ ...value, error: message(error) }));
      return false;
    }
    return mutate({ type: "add", view });
  }, [mutate, session]);

  const remove = useCallback(async (id: string) => {
    const current = configurationRef.current;
    const selectedKey = current?.currentViewId === id
      ? `${current.userId}:${current.surface}:${id}`
      : null;
    if (selectedKey) missingRef.current = selectedKey;
    const removed = await mutate({ type: "delete", id });
    if (removed && selectedKey && configurationRef.current?.currentViewId === id) {
      configurationRef.current.onMissing("deleted");
    } else if (!removed && missingRef.current === selectedKey) {
      missingRef.current = null;
    }
    return removed;
  }, [mutate]);
  const apply = useCallback((view: SavedMediaView) => {
    const current = configurationRef.current;
    if (current && view.surface === current.surface) current.onApply(view);
  }, []);
  const resetFilters = useCallback(() => configurationRef.current?.onResetFilters(), []);

  const effective = state.userId === userId ? state : stateFor(session);
  const surface = configuration?.surface;
  const views = surface
    ? effective.views.filter((view) => view.surface === surface)
    : [];

  useEffect(() => {
    const current = configurationRef.current;
    if (!current?.currentViewId || effective.status !== "ready") {
      if (!current?.currentViewId) missingRef.current = null;
      return;
    }
    if (views.some((view) => view.id === current.currentViewId)) {
      if (!mutationRef.current) missingRef.current = null;
      return;
    }
    const key = `${current.userId}:${current.surface}:${current.currentViewId}`;
    if (missingRef.current === key) return;
    missingRef.current = key;
    current.onMissing();
  }, [effective.status, views]);

  return {
    status: effective.status,
    views,
    currentViewId: configuration?.currentViewId,
    error: effective.error,
    busy: effective.busy,
    load,
    apply,
    save,
    remove,
    resetFilters,
  };
}
