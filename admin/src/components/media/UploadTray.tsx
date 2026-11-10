import { useId, useLayoutEffect, useRef } from "react";
import { useMediaQuery } from "../ui/floating";
import { Button, StatusBadge, type StatusTone } from "../ui/Primitives";
import "./UploadTray.css";

export type UploadTrayRowStatus =
  | "ready"
  | "waiting"
  | "uploading"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface UploadTrayRow {
  id: string;
  name: string;
  status: UploadTrayRowStatus;
  /** Percentage from 0 through 100. Omit for indeterminate progress. */
  progress?: number;
  message?: string;
  onStop?: () => void;
  stopDisabled?: boolean;
  onPause?: () => void;
  pauseDisabled?: boolean;
  onResume?: () => void;
  resumeDisabled?: boolean;
  resumeLabel?: string;
  resumeText?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  onCancel?: () => void;
  cancelDisabled?: boolean;
  onClear?: () => void;
  clearDisabled?: boolean;
  clearLabel?: string;
  clearText?: string;
  onViewAsset?: () => void;
}

export interface UploadTrayProps {
  announcement?: string;
  collapsed: boolean;
  label?: string;
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Opens the route-owned upload sheet from the forced compact pill. */
  onOpen: () => void;
  openLockedReason?: string;
  rows: readonly UploadTrayRow[];
  summary: string;
}

const STATUS_LABELS: Record<UploadTrayRowStatus, string> = {
  ready: "Ready to start",
  waiting: "Waiting",
  uploading: "Uploading",
  paused: "Paused",
  succeeded: "Uploaded",
  failed: "Failed",
  cancelled: "Canceled",
};

const STATUS_TONES: Record<UploadTrayRowStatus, StatusTone> = {
  ready: "neutral",
  waiting: "pending",
  uploading: "publishing",
  paused: "neutral",
  succeeded: "success",
  failed: "failed",
  cancelled: "cancelled",
};

function safeProgress(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.min(100, Math.max(0, value));
}

function UploadTrayRowView({
  index,
  onAction,
  row,
}: {
  index: number;
  onAction: (index: number) => void;
  row: UploadTrayRow;
}) {
  const progress = safeProgress(row.progress);
  const showProgress = row.status === "uploading" || row.status === "paused";
  const run = (action: () => void) => {
    onAction(index);
    action();
  };
  return (
    <li className="media-upload-tray-row" data-status={row.status} data-upload-row-index={index}>
      <div className="media-upload-tray-row-head">
        <strong>{row.name}</strong>
        <StatusBadge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</StatusBadge>
      </div>
      {showProgress ? (
        <progress
          aria-label={`${row.name} upload progress`}
          max={100}
          value={progress}
        />
      ) : null}
      {row.message ? <p>{row.message}</p> : null}
      {row.onStop || row.onPause || row.onResume || row.onRetry || row.onCancel || row.onClear || row.onViewAsset ? (
        <div className="media-upload-tray-actions">
          {row.onStop ? <Button aria-label={`Stop ${row.name}`} disabled={row.stopDisabled} onClick={() => run(row.onStop!)}>Stop</Button> : null}
          {row.onPause ? <Button aria-label={`Pause ${row.name}`} disabled={row.pauseDisabled} onClick={() => run(row.onPause!)}>Pause</Button> : null}
          {row.onResume ? <Button aria-label={row.resumeLabel ?? `Resume ${row.name}`} disabled={row.resumeDisabled} onClick={() => run(row.onResume!)}>{row.resumeText ?? "Resume"}</Button> : null}
          {row.onRetry ? <Button aria-label={`Retry ${row.name}`} disabled={row.retryDisabled} onClick={() => run(row.onRetry!)}>Retry</Button> : null}
          {row.onCancel ? <Button aria-label={`Cancel ${row.name}`} disabled={row.cancelDisabled} onClick={() => run(row.onCancel!)}>Cancel</Button> : null}
          {row.onClear ? <Button aria-label={row.clearLabel ?? `Clear ${row.name}`} disabled={row.clearDisabled} variant="ghost" onClick={() => run(row.onClear!)}>{row.clearText ?? "Clear"}</Button> : null}
          {row.onViewAsset ? <Button aria-label={`View asset ${row.name}`} variant="ghost" onClick={() => run(row.onViewAsset!)}>View asset</Button> : null}
        </div>
      ) : null}
    </li>
  );
}

export function UploadTrayRows({
  label,
  onAction = () => undefined,
  rows,
}: {
  label?: string;
  onAction?: (index: number) => void;
  rows: readonly UploadTrayRow[];
}) {
  return (
    <ol aria-label={label} className="media-upload-tray-rows">
      {rows.map((row, index) => (
        <UploadTrayRowView index={index} key={row.id} onAction={onAction} row={row} />
      ))}
    </ol>
  );
}

/** Controlled upload progress and receipt presentation. It performs no upload work. */
export function UploadTray({
  announcement = "",
  collapsed,
  label = "Upload progress",
  onCollapsedChange,
  onOpen,
  openLockedReason,
  rows,
  summary,
}: UploadTrayProps) {
  const compact = useMediaQuery("(max-width: 61.99rem)");
  const openNoteId = useId();
  const showPill = compact || collapsed;
  const trayRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef<"collapse" | "pill" | { rowIndex: number } | null>(null);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    const tray = trayRef.current;
    if (!pending || !tray) return;

    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) {
      pendingFocus.current = null;
      return;
    }

    let target: HTMLElement | null = null;
    if (pending === "collapse") {
      target = tray.querySelector('[data-upload-tray-focus="collapse"]');
    } else if (pending === "pill") {
      target = tray.querySelector('[data-upload-tray-focus="pill"]');
    } else {
      for (let index = pending.rowIndex; index < rows.length && !target; index += 1) {
        target = tray.querySelector(`[data-upload-row-index="${index}"] button:not([disabled])`);
      }
      for (let index = Math.min(pending.rowIndex - 1, rows.length - 1); index >= 0 && !target; index -= 1) {
        target = tray.querySelector(`[data-upload-row-index="${index}"] button:not([disabled])`);
      }
      target ??= tray.querySelector('[data-upload-tray-focus="collapse"], [data-upload-tray-focus="pill"]');
      target ??= tray;
    }
    pendingFocus.current = null;
    target?.focus();
  });

  return (
    <div className="media-upload-tray-dock"
      onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "none"; }}
      onDrop={event => { event.preventDefault(); event.stopPropagation(); }}>
      <section aria-label={label} className="media-upload-tray" data-collapsed={showPill || undefined} ref={trayRef} tabIndex={-1}>
        <p aria-atomic="true" className="sr-only" role="status">{announcement}</p>
        {showPill ? (
          compact ? (
            <Button
              aria-describedby={openLockedReason ? openNoteId : undefined}
              aria-disabled={openLockedReason ? "true" : undefined}
              aria-label={`Open upload details, ${summary}`}
              className="media-upload-tray-pill"
              onClick={() => { if (!openLockedReason) onOpen(); }}
            >
              {summary}
              {openLockedReason ? <span className="sr-only" id={openNoteId}>{openLockedReason}</span> : null}
            </Button>
          ) : !compact && onCollapsedChange ? (
            <Button
              aria-expanded="false"
              className="media-upload-tray-pill"
              data-upload-tray-focus="pill"
              onClick={() => {
                pendingFocus.current = "collapse";
                onCollapsedChange(false);
              }}
            >
              {summary}
            </Button>
          ) : <p className="media-upload-tray-pill">{summary}</p>
        ) : (
          <>
            <header className="media-upload-tray-header">
              <h2>Uploads</h2>
              <span>{summary}</span>
              {onCollapsedChange ? (
                <Button
                  aria-expanded="true"
                  aria-label="Collapse upload tray"
                  data-upload-tray-focus="collapse"
                  variant="ghost"
                  onClick={() => {
                    pendingFocus.current = "pill";
                    onCollapsedChange(true);
                  }}
                >
                  Collapse
                </Button>
              ) : null}
            </header>
            <UploadTrayRows
              onAction={(rowIndex) => {
                pendingFocus.current = { rowIndex };
              }}
              rows={rows}
            />
          </>
        )}
      </section>
    </div>
  );
}
