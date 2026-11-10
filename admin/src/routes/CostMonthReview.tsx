import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EditorOverlayOwner } from "../components/EditorOverlayOwner";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import {
  AsyncActionButton,
  Button,
  InlineMessage,
} from "../components/ui/Primitives";
import { useOverlayRoot } from "../components/ui/floating";
import { monthName, money, type CostLedgerView } from "./cost-ledger-drafts";

/** Native modal uses the same dialog surface and controls as the shared leave guard. */
export function CostMonthReview({
  view,
  pendingCount,
  busy,
  monthSaving,
  draftSaving,
  reloadRequired,
  recoveryNotice,
  blocked,
  error,
  onClose,
  onSave,
  onDiscard,
  onConfirm,
}: {
  view: CostLedgerView;
  pendingCount: number;
  busy: boolean;
  monthSaving: boolean;
  draftSaving: boolean;
  reloadRequired: boolean;
  recoveryNotice: ReactNode;
  blocked: { reason: string; lineIds: string[] } | null;
  error: string | null;
  onClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null),
    cancel = useRef<HTMLButtonElement>(null),
    title = useId();
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [modalOwner, setModalOwner] = useState<HTMLDialogElement | null>(null);
  const bindDialog = useCallback((element: HTMLDialogElement | null) => {
    dialog.current = element;
    setModalOwner(element);
  }, []);
  const overlay = useOverlayRoot();
  useEffect(() => {
    const element = dialog.current;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (
      element &&
      (!element.contains(document.activeElement) ||
        (document.activeElement instanceof HTMLButtonElement &&
          document.activeElement.disabled))
    ) {
      (
        element.querySelector<HTMLElement>("button:not(:disabled)") ?? element
      ).focus();
    }
  }, [busy, pendingCount]);
  const closing = view.periodStatus === "open";
  return createPortal(
    <dialog
      ref={bindDialog}
      tabIndex={-1}
      aria-labelledby={title}
      className="leave-guard-dialog cost-ledger-month-review"
      onKeyDown={(event) => {
        if (discardConfirm || event.key !== "Tab") return;
        const controls = Array.from(
          dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        if (!controls.length) {
          event.preventDefault();
          dialog.current?.focus();
          return;
        }
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onClose={(event) => {
        const closed = event.currentTarget;
        if (!closed.isConnected || closed.open) return;
        if (!busy) {
          onClose();
          return;
        }
        queueMicrotask(() => {
          if (closed.isConnected && !closed.open) {
            closed.showModal();
            (
              closed.querySelector<HTMLElement>("button:not(:disabled)") ??
              closed
            ).focus();
          }
        });
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (discardConfirm) setDiscardConfirm(false);
        else if (!busy) onClose();
      }}
    >
      <h2 id={title}>
        {closing ? "Close" : "Reopen"} {monthName(view.period)}?
      </h2>
      <p>
        {closing
          ? "Review the saved amounts before freezing this month. A deliberate admin close can accept blank amounts; scheduler completeness is a separate check."
          : "Reopening lets you correct amounts. The month stays open until an admin closes it again."}
      </p>
      <dl className="cost-ledger-facts">
        <div>
          <dt>Saved known total</dt>
          <dd>
            {view.knownLineCount > 0 ? money(view.monthlyCents) : "No amounts"}
          </dd>
        </div>
        <div>
          <dt>Known lines</dt>
          <dd>{view.knownLineCount}</dd>
        </div>
        <div>
          <dt>Blank lines included</dt>
          <dd>{view.blankLineCount}</dd>
        </div>
      </dl>
      {view.blankLineCount > 0 ? (
        <p>
          Blank lines:{" "}
          {view.lines
            .filter((line) => line.state === "blank")
            .map((line) => line.label)
            .join(", ") || "See the saved ledger coverage"}
          . Blank is never zero.
        </p>
      ) : null}
      {pendingCount > 0 ? (
        <InlineMessage tone="warning" title="Resolve pending drafts first">
          <div>
            <p>
              {`${pendingCount} pending change${pendingCount === 1 ? " is" : "s are"} not in this review. Save or discard ${pendingCount === 1 ? "it" : "them"} first.`}
            </p>
            <div className="button-row cost-ledger-draft-actions">
              <AsyncActionButton
                label="Save changes first"
                variant="primary"
                pending={draftSaving}
                pendingLabel="Saving drafts…"
                disabled={busy || reloadRequired}
                onClick={onSave}
              />
              <Button
                variant="secondary"
                className="cost-ledger-discard"
                disabled={busy || reloadRequired}
                onClick={() => setDiscardConfirm(true)}
              >
                Discard pending changes
              </Button>
            </div>
          </div>
        </InlineMessage>
      ) : null}
      {reloadRequired ? recoveryNotice : null}
      {blocked ? (
        <InlineMessage tone="error" title="Month action blocked">
          <p>Returned reason: {blocked.reason}</p>
          <p>
            Returned line IDs: {blocked.lineIds.join(", ") || "None returned"}
          </p>
        </InlineMessage>
      ) : null}
      {error && !blocked && !reloadRequired ? (
        <InlineMessage tone="error" title="Costs need attention">
          {error}
        </InlineMessage>
      ) : null}
      <div className="button-row cost-ledger-month-actions">
        <Button ref={cancel} disabled={busy} onClick={onClose}>
          Keep reviewing
        </Button>
        <AsyncActionButton
          label={closing ? "Close month" : "Reopen month"}
          pending={monthSaving}
          pendingLabel="Saving month status…"
          variant="primary"
          className="cost-ledger-month-confirm"
          disabled={busy || !view.canEdit || pendingCount > 0 || reloadRequired}
          onClick={onConfirm}
        />
      </div>
      {discardConfirm && modalOwner ? (
        <EditorOverlayOwner.Provider value={modalOwner}>
          <LeaveGuardDialog
            title={`Discard ${pendingCount} pending change${pendingCount === 1 ? "" : "s"}?`}
            description={`${pendingCount} unsaved change${pendingCount === 1 ? "" : "s"} will be removed. Saved amounts do not change.`}
            confirmLabel="Discard changes"
            cancelLabel="Keep editing"
            onCancel={() => setDiscardConfirm(false)}
            onConfirm={() => {
              setDiscardConfirm(false);
              onDiscard();
            }}
          />
        </EditorOverlayOwner.Provider>
      ) : null}
    </dialog>,
    overlay ?? document.body,
  );
}
