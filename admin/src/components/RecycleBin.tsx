import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { listOriginState } from "../lib/editor-back";
import { useContentQuickActions, useContentQuickEditGuard } from "../context/ContentQuickActionsContext";
import { ContentQuickEdit, type ContentQuickEditTarget } from "./ContentQuickEdit";
import { Button, InlineMessage, StatusBadge, TableFrame } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

export interface RecycleBinItem {
  id: string;
  title: string;
  editorPath?: string;
  target?: ContentQuickEditTarget;
  restoreUnavailableReason?: string;
}

export interface RecycleBinPage {
  items: RecycleBinItem[];
  page: number;
  pageCount: number;
}

export function RecycleBin({
  count,
  loadPage,
  onRestore,
  persistentEditorDirty = false,
  disabled = false,
}: {
  count: number;
  loadPage: (page: number) => Promise<RecycleBinPage>;
  onRestore: () => void;
  persistentEditorDirty?: boolean;
  disabled?: boolean;
}) {
  const headingId = useId();
  const api = useContentQuickActions();
  const { saving } = useContentQuickEditGuard();
  const origin = listOriginState(useLocation());
  const [opened, setOpened] = useState(false);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<RecycleBinPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controlsDisabled = disabled || loading || saving;

  useEffect(() => {
    if (!opened) return;
    let active = true;
    setLoading(true);
    setError(null);
    void loadPage(page).then((next) => {
      if (active) setResult(next);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Deleted items could not be loaded.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [opened, page, attempt, loadPage]);

  return (
    <details className="content-recycle-bin" onToggle={(event) => {
      if (event.currentTarget.open) setOpened(true);
    }}>
      <summary id={headingId}>Recycle bin <span>({count})</span></summary>
      <section aria-labelledby={headingId}>
        <p>Deleted items stay here until you restore them to draft. Restoring does not publish them.</p>
        {notice ? <p role="status">{notice}</p> : null}
        {loading ? <LoadingIndicator label="Loading deleted items" /> : null}
        {error ? <InlineMessage tone="error" title="Recycle bin could not be loaded">
          <p>{error}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
        </InlineMessage> : null}
        {!error && result ? <>
          <TableFrame aria-label="Deleted content table">
            <table className="data-table" aria-label="Deleted content">
              <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
              <tbody>
                {result.items.map((item) => <tr key={item.id}>
                  <td data-label="Name">{item.title}</td>
                  <td data-label="Status"><StatusBadge tone="deleted">Deleted</StatusBadge></td>
                  <td data-label="Actions">
                    <div className="button-row">
                      {api && item.target ? <Button disabled={controlsDisabled} onClick={() => setRestoringId(item.id)}>
                        Restore
                      </Button> : null}
                      {item.editorPath && !controlsDisabled ? <Link to={item.editorPath} state={origin}>Open editor</Link> : null}
                    </div>
                    {item.restoreUnavailableReason ? (
                      <p className="content-quick-edit-note">{item.restoreUnavailableReason}</p>
                    ) : null}
                    {restoringId === item.id && item.target ? <ContentQuickEdit
                      restoreOnly
                      label={item.title}
                      target={item.target}
                      persistentEditorDirty={persistentEditorDirty || disabled}
                      onDocumentChange={(document) => {
                        if (document.status !== "draft") return;
                        setRestoringId(null);
                        setNotice(`${item.title} restored to draft.`);
                        onRestore();
                        setAttempt((value) => value + 1);
                      }}
                    /> : null}
                  </td>
                </tr>)}
                {result.items.length === 0 ? <tr><td colSpan={3}>No deleted items match the current filters.</td></tr> : null}
              </tbody>
            </table>
          </TableFrame>
          {result.pageCount > 1 ? <nav className="content-library-pagination" aria-label="Recycle bin pages">
            <Button disabled={controlsDisabled || result.page === 1} onClick={() => { setRestoringId(null); setPage(result.page - 1); }}>Previous</Button>
            <span>Page {result.page} of {result.pageCount}</span>
            <Button disabled={controlsDisabled || result.page === result.pageCount} onClick={() => { setRestoringId(null); setPage(result.page + 1); }}>Next</Button>
          </nav> : null}
        </> : null}
      </section>
    </details>
  );
}
