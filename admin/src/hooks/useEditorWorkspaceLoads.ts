import { useEffect, type ComponentProps } from "react";
import type { EditorWorkspace, LoadedRecord, PageContent, Surface } from "../components/EditorWorkspace";

type PageSurface = Extract<Surface, { kind: "page" }>;
type RecordSurface = Extract<Surface, { kind: "record" }>;
type WorkspaceInputs = Pick<ComponentProps<typeof EditorWorkspace>, "loadPage" | "loadRecord">;

interface EditorWorkspaceLoadOptions extends WorkspaceInputs {
  surface: Surface;
  reloadCount: number;
  recordReloadCount: number;
  restorePageDraft: (surface: PageSurface) => boolean;
  onPageReadStarted: (surface: PageSurface) => void;
  onPageRead: (surface: PageSurface, content: PageContent) => void;
  onPageReadError: (message: string) => void;
  restoreRecordDraft: (surface: RecordSurface) => boolean;
  onRecordReadStarted: (surface: RecordSurface) => void;
  onRecordRead: (surface: RecordSurface, result: LoadedRecord) => void;
  onRecordReadError: (message: string) => void;
}

export function useEditorWorkspaceLoads({
  surface,
  loadPage,
  reloadCount,
  loadRecord,
  recordReloadCount,
  restorePageDraft,
  onPageReadStarted,
  onPageRead,
  onPageReadError,
  restoreRecordDraft,
  onRecordReadStarted,
  onRecordRead,
  onRecordReadError,
}: EditorWorkspaceLoadOptions) {
  // Hydrate the selected page from its stored blocks, or restore the draft if this session has
  // already edited it. Runs on every page selection and on an explicit reload. A save changes
  // neither, so it never re-runs mid-edit. A stale resolution from a page the user already
  // switched away from is dropped.
  useEffect(() => {
    if (surface.kind !== "page" || !loadPage) return;
    let cancelled = false;
    const { pageId, section } = surface;
    if (restorePageDraft(surface)) return;
    onPageReadStarted(surface);
    loadPage(pageId, section)
      .then(content => {
        if (!cancelled) onPageRead(surface, content);
      })
      .catch((error: unknown) => {
        if (!cancelled) onPageReadError(error instanceof Error ? error.message : "The page could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [surface, loadPage, reloadCount]);

  // Hydrate an addressed record before mounting its form. Absence, soft deletion, a mismatched
  // type discriminator, and read failure are distinct terminal states; none falls through to a
  // blank form, because saving that form would mint or overwrite the wrong document (#566).
  useEffect(() => {
    if (surface.kind !== "record" || surface.id === null || !loadRecord) return;
    let cancelled = false;
    const addressedSurface = surface;
    if (restoreRecordDraft(addressedSurface)) return;
    onRecordReadStarted(addressedSurface);
    loadRecord(surface.record, surface.id)
      .then(result => {
        if (cancelled) return;
        onRecordRead(addressedSurface, result);
      })
      .catch((error: unknown) => {
        if (!cancelled) onRecordReadError(error instanceof Error ? error.message : "The record could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [surface, loadRecord, recordReloadCount]);
}
