import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
} from "react-router";
import { ContentStudioSkeleton } from "../components/EditorSkeleton";
import { Button, InlineMessage } from "../components/ui/Primitives";
import { useContentQuickEditGuard } from "../context/ContentQuickActionsContext";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import type { ExitSaveOutcome } from "../lib/exit-save";
import { NotFoundBody } from "./NotFound";
import { useShell } from "./ShellContext";
import "../content-scan-flow.css";
import {
  canBrowseContentPages,
  canManageContentRecords,
  canSaveContent,
  canUseContentStudio,
} from "../lib/access";
import {
  contentLibraryPath,
  contentPagesPath,
  createRecordPath,
  editPagePath,
  editRecordPath,
  mountedSurfaceForRoute,
  parseContentPath,
  recordListPath,
  type EditorSurface,
} from "../lib/routes";

const ContentTab = lazy(async () => ({
  default: (await import("../components/ContentTab")).ContentTab,
}));

function mountedSurfaceForAccess(
  route: ReturnType<typeof parseContentPath>,
  canBrowseContent: boolean,
  canBrowsePages: boolean,
): EditorSurface | null {
  if (!canBrowseContent || (route.kind === "page-list" && !canBrowsePages)) {
    return null;
  }
  return mountedSurfaceForRoute(route);
}

// The persistent layout for every `/content/**` route. It stays mounted while the user moves
// between editor surfaces, so the content editor it renders (ContentTab -> EditorWorkspace) keeps
// its draft map, clean baselines, hydration state, and save signal across surface changes
// (#579/#595). The child surface is derived from the URL rather than held in a second piece of
// component state, which is what makes each surface addressable.
//
// It also owns the navigation protection for the subtree:
//   - While a save is in flight, every route change is held until the save settles.
//   - While the editor is dirty, movement inside `/content/**` is free (the mounted editor
//     preserves the work) but leaving the subtree is confirmed first.
//   - While any memory-only draft exists, a browser unload (reload, tab close) is warned.
//
// Dirty is raised by the editor through onDirtyChange. In this branch it reflects the presence of
// any in-memory draft for a surface, so any edit reads dirty until it is saved or discarded. #595
// replaces that signal at the same seam with the editor's clean-baseline comparison, after which
// typing and then reverting reads clean.

export function ContentLayout() {
  const { principal } = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  const canBrowseContent = canUseContentStudio(principal);
  const canBrowsePages = canBrowseContentPages(principal);
  const canManageRecords = canManageContentRecords(principal);
  const {
    dirty: quickEditDirty,
    saving: quickEditSaving,
    hasUnsavedWork: quickEditHasUnsavedWork,
    save: saveQuickEdits,
  } = useContentQuickEditGuard();
  // A create save canonicalizes its URL only after the server has committed and minted the id.
  // That navigation is safe even though RecordForm has not yet cleared its saving signal, so the
  // next route evaluation may bypass the generic in-flight hold exactly once.
  const committedNavigation = useRef(false);

  // Raised by the editor: a page or record save is in flight, and whether any surface holds an
  // in-memory draft (the interim dirty signal; #595 swaps in a clean-baseline comparison here).
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Memoized on the pathname so the parsed route and the derived surface keep a stable identity
  // across re-renders that do not change the path (a save settling, the dirty signal flipping, the
  // blocker resetting). The editor's hydration effect keys on the surface object, so a fresh
  // surface object every render would re-read the page and remount the editor mid-edit, dropping
  // its blocks and its saved confirmation. The surface only gets a new identity when the path
  // genuinely changes, which is exactly when a re-hydration is wanted.
  const contentRoute = useMemo(
    () => parseContentPath(location.pathname),
    [location.pathname],
  );

  // `/content` was the library before the CMS became page-first. Preserve copied and bookmarked
  // filtered-library URLs by moving a query-bearing legacy root to the library's explicit route;
  // the query and fragment survive unchanged. Page-directory filters use their own names and stay
  // on this surface. A clean `/content` remains the page directory.
  useEffect(() => {
    if (contentRoute.kind !== "page-list" || !location.search) return;
    const params = new URLSearchParams(location.search);
    if (params.has("page_q") || params.has("page_section")) return;
    navigate(`${contentLibraryPath()}${location.search}${location.hash}`, { replace: true });
  }, [contentRoute.kind, location.hash, location.search, navigate]);

  // Every valid path, including the page directory and combined library, maps to one surface in
  // the persistent EditorWorkspace. That shared owner keeps drafts alive while a person filters
  // the library or moves between the library and an editor. A malformed sub-path still maps to
  // null (not-found).
  const effectiveSurface = useMemo(
    () => mountedSurfaceForAccess(contentRoute, canBrowseContent, canBrowsePages),
    [canBrowseContent, canBrowsePages, contentRoute],
  );

  // Turn a workspace surface into a URL so it is addressable. A page goes to its public-page
  // edit path; a record goes to its create path (id null) or its edit-by-id path (a string). The
  // shell list links open browse surfaces, while a completed create reports its canonical edit
  // surface here. Building the path from the surface's own id keeps this from silently dropping
  // the id the way the surface mapping used to (record read hydration lands with #540/#566).
  const navigateToSurface = useCallback(
    (next: EditorSurface, options?: { replace?: boolean; committed?: boolean }) => {
      const path =
        next.kind === "page-list"
          ? canBrowsePages
            ? contentPagesPath()
            : contentLibraryPath()
          : next.kind === "library"
          ? contentLibraryPath()
          : next.kind === "page"
          ? editPagePath(next.pageId)
          : next.kind === "record-list"
            ? recordListPath(next.record)
            : next.id === null
              ? createRecordPath(next.record)
              : editRecordPath(next.record, next.id);
      if (options?.committed) committedNavigation.current = true;
      // A committed navigation is the create surface replacing its own URL with the id the server
      // just minted. It is the same editing session at a new address, so the list it was opened
      // from travels with it; without this, Back after the first save falls to the record's own
      // list and quietly drops the filtered library the person started in (#1037).
      navigate(path, {
        replace: options?.replace,
        state: options?.committed ? location.state : undefined,
      });
      // React Router evaluates blockers during this navigation. Clear the escape hatch again at
      // the next microtask as a backstop, so it can never leak into a later unrelated leave.
      if (options?.committed) queueMicrotask(() => (committedNavigation.current = false));
    },
    [canBrowsePages, location.state, navigate],
  );

  // When no editor is mounted (a bad sub-path shows not-found), no save or draft can be
  // outstanding, so clear any stale signal that would otherwise keep the unload warning or the
  // blocker armed. Keyed on the mounted surface, not the parsed one: the library is a real surface
  // in the same workspace, so its draft signal must stand rather than be cleared from under it.
  useEffect(() => {
    if (effectiveSurface === null) {
      setSaving(false);
      setDirty(false);
    }
  }, [effectiveSurface]);

  // Why the current block exists, recorded when the block is decided rather than re-derived from
  // `saving` and `dirty` afterward. Those describe the editor now; the block was created from what
  // they said then, and the two come apart exactly where it matters. A failed save clears `saving`
  // but leaves `dirty` true, so a save-hold re-read from current state looks identical to a fresh
  // dirty leave — and the guard would offer to discard the very work whose save just failed, acting
  // on a click the person made before they knew it would fail.
  const blockReason = useRef<"save-hold" | "dirty-leave" | null>(null);

  // The editor's exact answer to "is any of this still unsaved", filled in by the mounted editor.
  // `dirty` only says a draft exists, which stays true through an undo back to the stored content,
  // because the comparison that would know better is a structural walk the editor refuses to run
  // per keystroke (#595). Asking here instead is that comparison at its intended moment: this runs
  // once, when a navigation is about to be held, so the person is stopped over work that is really
  // there rather than over an edit they already took back. Absent probe means no editor is mounted
  // to ask, in which case the conservative flag stands on its own.
  const unsavedProbeRef = useRef<(() => boolean) | null>(null);
  const hasUnsavedWork = useCallback(
    () => (unsavedProbeRef.current ? unsavedProbeRef.current() : true),
    [],
  );

  // The mounted editor's own save, published the same way as the probe above. It commits every
  // unsaved panel of the addressed surface and resolves true only when the server confirmed all
  // of it and nothing was left behind, which is what lets an exit wait for the exact save result
  // rather than for the click that asked for it (#1032). Absent means no editor is mounted, and
  // a save that cannot be attempted is not a save that landed.
  const saveRequestRef = useRef<(() => Promise<ExitSaveOutcome>) | null>(null);
  const saveBeforeExit = useCallback(
    (): Promise<ExitSaveOutcome> =>
      saveRequestRef.current?.() ??
      Promise.resolve<ExitSaveOutcome>({ status: "failed" }),
    [],
  );

  // The dirty flag as the exit guard needs to ask it: the cheap signal first, then the exact
  // probe. Read through a ref so the registration keeps one identity while the editor is mounted
  // and the shell always sees the current answer.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const editorHasUnsavedWork = useCallback(
    () => dirtyRef.current && hasUnsavedWork(),
    [hasUnsavedWork],
  );

  const hasAnyUnsavedWork = useCallback(
    () => editorHasUnsavedWork() || quickEditHasUnsavedWork(),
    [editorHasUnsavedWork, quickEditHasUnsavedWork],
  );

  const saveAllBeforeExit = useCallback(async (): Promise<ExitSaveOutcome> => {
    const outstanding: string[] = [];
    if (editorHasUnsavedWork()) {
      const outcome = await saveBeforeExit();
      if (outcome.status === "failed") return outcome;
      if (outcome.status === "unsaved-elsewhere") {
        outstanding.push(...outcome.items);
      }
    }
    if (quickEditHasUnsavedWork()) {
      const outcome = await saveQuickEdits();
      if (outcome.status === "failed") return outcome;
      if (outcome.status === "unsaved-elsewhere") {
        outstanding.push(...outcome.items);
      }
    }
    return outstanding.length > 0
      ? { status: "unsaved-elsewhere", items: [...new Set(outstanding)] }
      : { status: "saved" };
  }, [
    editorHasUnsavedWork,
    quickEditHasUnsavedWork,
    saveBeforeExit,
    saveQuickEdits,
  ]);

  const guardSaving = saving || quickEditSaving;

  // One dirty state for every exit. The blocker below holds route changes; this is the same
  // answer, published to the shell for the exits a router never sees — sign-out today (#1032).
  useRegisterExitGuard({
    saving: guardSaving,
    hasUnsavedWork: hasAnyUnsavedWork,
    save: saveAllBeforeExit,
  });

  // Hold navigation per the three-case contract. A query-only change (same pathname) stays free
  // while idle unless a list quick edit is dirty, because changing the browse query can unmount
  // the row that owns those fields. It is still a real navigation while any mutation is in flight.
  const blocker = useBlocker(
    useCallback(
      ({
        currentLocation,
        nextLocation,
      }: {
        currentLocation: { pathname: string; search: string; hash: string };
        nextLocation: { pathname: string; search: string; hash: string };
      }) => {
        if (
          currentLocation.pathname === nextLocation.pathname &&
          currentLocation.search === nextLocation.search &&
          currentLocation.hash === nextLocation.hash
        ) {
          return false;
        }
        if (committedNavigation.current && !quickEditDirty) {
          committedNavigation.current = false;
          return false;
        }
        if (guardSaving) {
          blockReason.current = "save-hold";
          return true;
        }
        if (quickEditDirty && quickEditHasUnsavedWork()) {
          blockReason.current = "dirty-leave";
          return true;
        }
        if (currentLocation.pathname === nextLocation.pathname) return false;
        // A dirty move only bypasses the leave prompt when the destination keeps this principal's
        // editor mounted. A malformed or inaccessible `/content/**` path renders outside the
        // editor and drops the draft, so it must be confirmed like any other leave.
        if (
          dirty &&
          mountedSurfaceForAccess(
            parseContentPath(nextLocation.pathname),
            canBrowseContent,
            canBrowsePages,
          ) === null &&
          hasUnsavedWork()
        ) {
          blockReason.current = "dirty-leave";
          return true;
        }
        return false;
      },
      [
        canBrowseContent,
        canBrowsePages,
        dirty,
        guardSaving,
        hasUnsavedWork,
        quickEditDirty,
        quickEditHasUnsavedWork,
      ],
    ),
  );

  // A block that is a dirty-leave (not a save-hold) is the one that asks the user. A save-hold is
  // silent and released once the save settles.
  const isDirtyLeave =
    blocker.state === "blocked" && blockReason.current === "dirty-leave";

  useEffect(() => {
    // Release a save-hold once the save settles, however it settled: the click that fired during
    // the save becomes a no-op, matching the pre-routing behavior where the nav was simply
    // disabled. Success and failure release alike, because the person clicked without knowing which
    // they would get, so neither outcome turns that click into an instruction about their draft.
    if (
      blocker.state === "blocked" &&
      blockReason.current === "save-hold" &&
      !guardSaving
    ) {
      blockReason.current = null;
      blocker.reset();
    }
  }, [blocker, guardSaving]);

  // Warn on a hard document navigation (reload, tab close, cross-origin) while work is unsaved.
  // useBlocker does not cover these; this does. It clears as soon as every editor is clean.
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (
          !guardSaving &&
          ((!dirty && !quickEditDirty) || !hasAnyUnsavedWork())
        ) {
          return;
        }
        event.preventDefault();
        event.returnValue = "";
      }, [dirty, guardSaving, hasAnyUnsavedWork, quickEditDirty],
    ),
  );

  // A scoped grant cannot reach these currently unsectioned records. Keep that account out of a
  // form the server must refuse, while site-wide editor and contributor grants use the same
  // capability-aware read/save boundaries as top-level administrators.
  if (!canBrowseContent) {
    return (
      <InlineMessage tone="info" title="Content studio is outside your current scope">
        These records do not have editorial areas yet, so this workspace requires a
        site-wide content grant. Ask an administrator to update your access.
      </InlineMessage>
    );
  }

  if (contentRoute.kind === "page-list" && !canBrowsePages) {
    return (
      <InlineMessage tone="info" title="Pages are outside your current access">
        The page directory contains site-wide pages owned by other editors. Use Posts or
        All content to create and revisit records you can access.
      </InlineMessage>
    );
  }

  // An unresolvable sub-path has no surface to mount. The page directory and library are both real
  // workspace surfaces, so only malformed paths reach this branch.
  if (effectiveSurface === null) {
    return (
      <>
        <NotFoundBody
          heading="That content page doesn't exist"
          message="This address isn't a content surface the editor can open. It may be mistyped."
        >
          <Button
            onClick={() =>
              navigate(canBrowsePages ? contentPagesPath() : contentLibraryPath())
            }
          >
            {canBrowsePages ? "Go to pages" : "Go to All content"}
          </Button>
        </NotFoundBody>
        {renderLeaveGuard(isDirtyLeave, blocker, saveAllBeforeExit)}
      </>
    );
  }

  return (
    <>
      <Suspense
        fallback={
          <ContentStudioSkeleton surface={effectiveSurface} label="Opening the editor." withSelect={canManageRecords} canCreate={canSaveContent(principal)} />
        }
      >
        <ContentTab
          principal={principal}
          canArchiveLibrary={canManageRecords}
          surface={effectiveSurface}
          onNavigateSurface={navigateToSurface}
          onSavingChange={setSaving}
          onDirtyChange={setDirty}
          unsavedProbeRef={unsavedProbeRef}
          saveRequestRef={saveRequestRef}
        />
      </Suspense>
      {renderLeaveGuard(isDirtyLeave, blocker, saveAllBeforeExit)}
    </>
  );
}

// The leave dialog is rendered by both branches, so it is centralized here. `blocker.proceed`
// and `blocker.reset` exist only while the blocker is blocked, which is exactly when isDirtyLeave
// can be true.
function renderLeaveGuard(
  isDirtyLeave: boolean,
  blocker: ReturnType<typeof useBlocker>,
  save: () => Promise<ExitSaveOutcome>,
) {
  if (!isDirtyLeave || blocker.state !== "blocked") return null;
  return (
    <LeaveGuardDialog
      onSave={save}
      onConfirm={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
    />
  );
}
