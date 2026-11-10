import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import {
  WorkspaceActions,
  WorkspaceSecondaryActions,
  WorkspaceBrowseToolbar,
  WorkspaceStatus,
  useWorkspaceActionsAvailable,
} from "../components/WorkspaceActions";
import { ActionControl } from "../components/ui/ActionControl";
import { Inspector } from "../components/ui/Inspector";
import { useMediaQuery } from "../components/ui/floating";
import { Icon } from "../components/ui/Icon";
import { Menu } from "../components/ui/Menu";
import {
  Button,
  AsyncActionButton,
  InlineMessage,
  Tabs,
  TextInput,
  Textarea,
} from "../components/ui/Primitives";
import { LeaveGuardDialog } from "./LeaveGuardDialog";
import { useRegisterExitGuard } from "./ExitGuard";
import {
  hardwareMonthlyCents,
  validateHardwareMachine,
} from "../../../packages/content-core/src/cost-hardware";
import {
  money,
  monthName,
  type CostLedgerView,
  type HardwareDraft,
  type HardwareMachine,
  type ComparisonDraft,
  type LedgerComparison,
} from "./cost-ledger-drafts";

export type CostTask = "ledger" | "history" | "references" | "hardware";
const tasks = [
  { value: "ledger", label: "Ledger", panelId: "cost-panel-ledger" },
  { value: "history", label: "History", panelId: "cost-panel-history" },
  {
    value: "references",
    label: "Price references",
    panelId: "cost-panel-references",
  },
  { value: "hardware", label: "Hardware", panelId: "cost-panel-hardware" },
] as const;

export function CostWorkspaceChrome({
  view,
  periods,
  busy,
  activity,
  periodDisabled = false,
  pendingCount,
  task,
  taskSwitchLocked = false,
  onTask,
  onPeriod,
  onReload,
  onMonthAction,
  onCsv,
  saveAction,
  csvDisabled = false,
}: {
  view: CostLedgerView;
  periods: CostLedgerView["periods"];
  busy: boolean;
  activity?: string;
  periodDisabled?: boolean;
  pendingCount: number;
  task: CostTask;
  taskSwitchLocked?: boolean;
  onTask: (task: CostTask) => void;
  onPeriod: (period: string) => void;
  onReload: () => void;
  onMonthAction: () => void;
  onCsv: () => void;
  saveAction?: ReactNode;
  csvDisabled?: boolean;
}) {
  const shared = useWorkspaceActionsAvailable();
  const periodReasonId = useId();
  const phone = useMediaQuery("(max-width: 619px)");
  const tabletHint = useMediaQuery(
    "(min-width: 620px) and (max-width: 1023px)",
  );
  const fieldHint = phone || tabletHint;
  const origin = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const workspace = origin.current?.closest<HTMLElement>(".workspace-shell");
    const chrome = workspace?.querySelector<HTMLElement>(".workspace-chrome");
    if (!workspace || !chrome) return;
    const measure = () => {
      const height = chrome.getBoundingClientRect().height;
      const short = innerHeight < 540 || height > innerHeight * 0.45;
      workspace.style.setProperty("--costs-chrome-height", `${height}px`);
      workspace.style.setProperty(
        "--costs-sticky-offset",
        short ? "0px" : `${height}px`,
      );
      workspace.toggleAttribute("data-costs-short", short);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chrome);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      workspace.style.removeProperty("--costs-chrome-height");
      workspace.style.removeProperty("--costs-sticky-offset");
      workspace.removeAttribute("data-costs-short");
    };
  }, [shared]);
  const phoneAction = (action: () => void) => {
    const trigger = origin.current
      ?.closest(".workspace-shell")
      ?.querySelector<HTMLButtonElement>(".workspace-more-trigger");
    if (trigger?.getAttribute("aria-expanded") === "true") trigger.click();
    trigger?.focus();
    action();
  };
  const actions = (
    <div
      className="cost-ledger-header-actions"
      data-month-locked={pendingCount > 0 || undefined}
    >
      <div className="cost-ledger-month-controls">
        <select
          className="field-control field-size-compact"
          aria-label="Ledger month"
          disabled={busy || periodDisabled}
          aria-disabled={pendingCount > 0}
          aria-describedby={
            pendingCount
              ? fieldHint
                ? `${periodReasonId}-phone`
                : periodReasonId
              : undefined
          }
          value={view.period}
          onChange={(event) => {
            if (pendingCount === 0 && !periodDisabled)
              onPeriod(event.target.value);
          }}
        >
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {monthName(period.id)} · {period.status}
            </option>
          ))}
        </select>
        {pendingCount && fieldHint ? (
          <p id={`${periodReasonId}-phone`} className="cost-ledger-month-hint">
            Save or discard {pendingCount} change{pendingCount === 1 ? "" : "s"}{" "}
            to switch months.
          </p>
        ) : null}
      </div>
      {saveAction}
      <Button
        size="standard"
        variant="secondary"
        disabled={busy || csvDisabled}
        onClick={onCsv}
        aria-label="Download CSV"
      >
        CSV
      </Button>
      <Menu
        label="More cost actions"
        disabled={busy}
        items={[
          {
            key: "month",
            label:
              view.periodStatus === "open" ? "Close month" : "Reopen month",
            hidden: !view.canEdit,
            onSelect: onMonthAction,
          },
          { key: "reload", label: "Reload saved costs", onSelect: onReload },
        ]}
      />
    </div>
  );
  return (
    <>
      <span hidden ref={origin} />
      {shared ? <WorkspaceActions>{actions}</WorkspaceActions> : actions}
      {shared ? (
        <WorkspaceSecondaryActions>
          <div className="cost-ledger-phone-actions">
            <Button
              size="standard"
              variant="menu"
              disabled={busy || csvDisabled}
              aria-label="Download CSV"
              onClick={() => phoneAction(onCsv)}
            >
              <Icon name="download" /> Download CSV
            </Button>
            <Button
              size="standard"
              variant="menu"
              disabled={busy}
              onClick={() => phoneAction(onReload)}
            >
              <Icon name="refresh" /> Reload saved costs
            </Button>
            {view.canEdit ? (
              <Button
                size="standard"
                variant="menu"
                disabled={busy}
                onClick={() => phoneAction(onMonthAction)}
              >
                <Icon name={view.periodStatus === "open" ? "lock" : "undo"} />
                {view.periodStatus === "open" ? "Close month" : "Reopen month"}
              </Button>
            ) : null}
          </div>
        </WorkspaceSecondaryActions>
      ) : null}
      <WorkspaceStatus>
        <span
          id={periodReasonId}
          className="cost-ledger-save-state"
          aria-live="polite"
          data-activity={activity ? true : undefined}
        >
          {activity}
          {!fieldHint || !activity ? (
            <>
              {activity ? " · " : null}
              {view.periodStatus === "open" ? "Open" : "Closed"}{" "}
              <span className="cost-ledger-pending-copy">
                {" "}
                ·{" "}
                {pendingCount
                  ? `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}`
                  : "No unsaved changes"}
                {pendingCount && !fieldHint ? " · save or discard first" : ""}
              </span>
            </>
          ) : null}
        </span>
      </WorkspaceStatus>
      <WorkspaceBrowseToolbar>
        <Tabs
          id="cost-task"
          label="Cost tasks"
          value={task}
          options={tasks.map((option) => ({
            ...option,
            disabled: taskSwitchLocked && option.value !== task,
          }))}
          onChange={(next) => {
            if (!taskSwitchLocked && next !== task) onTask(next);
          }}
        />
      </WorkspaceBrowseToolbar>
    </>
  );
}

export function CostLedgerGuard({
  dirty,
  busy,
}: {
  dirty: boolean;
  busy: boolean;
}) {
  const current = useRef({ dirty, busy });
  current.current = { dirty, busy };
  const hasUnsavedWork = useCallback(() => current.current.dirty, []);
  useRegisterExitGuard({ hasUnsavedWork, saving: busy });
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (current.current.dirty || current.current.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <CostRouteBlocker dirty={dirty} busy={busy} /> : null;
}
function CostRouteBlocker({ dirty, busy }: { dirty: boolean; busy: boolean }) {
  const current = useRef({ dirty, busy });
  current.current = { dirty, busy };
  const shouldBlock = useCallback(
    () => current.current.dirty || current.current.busy,
    [],
  );
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (blocker.state === "blocked" && !dirty && !busy) blocker.proceed();
  }, [blocker, dirty, busy]);
  return blocker.state === "blocked" && !busy && dirty ? (
    <LeaveGuardDialog
      onCancel={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    />
  ) : null;
}

export function CostHistory({
  view,
  busy = false,
  onPeriod,
}: {
  view: CostLedgerView;
  busy?: boolean;
  onPeriod: (period: string) => void;
}) {
  const closed = view.periods
    .filter((period) => period.status === "closed")
    .sort((a, b) => b.id.localeCompare(a.id));
  return (
    <section aria-label="Cost history" className="cost-ledger-task-body">
      <h2 tabIndex={-1}>History</h2>
      <p>
        Closed periods and monthly totals observed by the weekly refresh.
        Snapshots are not weekly spend.
      </p>
      <div className="cost-ledger-history-periods">
        {closed.length ? (
          closed.map((period) => (
            <Button
              key={period.id}
              variant="ghost"
              size="standard"
              disabled={busy}
              onClick={() => onPeriod(period.id)}
            >
              {monthName(period.id)} · closed
            </Button>
          ))
        ) : (
          <p>No closed periods are included in this response.</p>
        )}
      </div>
      <h3>Saved snapshots</h3>
      {view.snapshots.length ? (
        <table className="cost-ledger-history-table">
          <thead>
            <tr>
              <th scope="col">Observed</th>
              <th scope="col">Month</th>
              <th scope="col">Known monthly total</th>
              <th scope="col">Blank lines</th>
            </tr>
          </thead>
          <tbody>
            {view.snapshots.map((row) => (
              <tr key={row.id}>
                <td data-label="Observed">
                  {new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                  }).format(new Date(row.takenAt))}
                </td>
                <td data-label="Month">{monthName(row.period)}</td>
                <td
                  data-label="Known monthly total"
                  className="cost-ledger-number"
                >
                  {money(row.monthlyCents)}
                </td>
                <td data-label="Blank lines">{row.blankLineCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <InlineMessage title="No weekly snapshots yet">
          <p>No observed monthly totals are included in this response.</p>
        </InlineMessage>
      )}
    </section>
  );
}

function TaskDetails({
  heading,
  label,
  open,
  onClose,
  onFocusFallback,
  children,
}: {
  heading: string;
  label: string;
  open: boolean;
  onClose: () => void;
  onFocusFallback?: () => void;
  children: ReactNode;
}) {
  return (
    <Inspector
      compactQuery="(max-width: 73.749rem)"
      heading={heading}
      label={label}
      open={open}
      onClose={onClose}
      onFocusFallback={onFocusFallback}
      storageKey={`costs-${label}`}
      resizable={false}
      fitViewport
      className="cost-ledger-inspector"
    >
      {children}
    </Inspector>
  );
}

export function CostReferencePanel({
  view,
  drafts,
  busy,
  retryBusy = busy,
  savingKey = null,
  error,
  errorHeading,
  onRetryLoad,
  errorReferenceId,
  notice,
  onChange,
  onSave,
}: {
  view: CostLedgerView;
  drafts: Record<string, ComparisonDraft>;
  busy: boolean;
  retryBusy?: boolean;
  savingKey?: string | null;
  error: string | null;
  errorHeading?: string;
  onRetryLoad?: () => void;
  /** Null is a global failure; omitted identity permits a named batch notice. */
  errorReferenceId?: string | null;
  notice?: ReactNode;
  onChange: (draft: ComparisonDraft) => void;
  onSave: (draft: ComparisonDraft) => void;
}) {
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const row = view.comparisons.find((item) => item.id === selection);
  const draft = row && drafts[row.id];
  const errorRow = view.comparisons.find(
    (item) => item.id === errorReferenceId,
  );
  const errorInDetails =
    !!row && (errorReferenceId === undefined || row.id === errorReferenceId);
  const errorTitle =
    errorHeading ??
    (errorRow
      ? `${errorRow.product} needs attention`
      : "Costs could not be saved");
  return (
    <div className="cost-ledger-layout">
      <section className="cost-ledger-main cost-ledger-task-body">
        {notice && !row ? notice : null}
        {error && !errorInDetails ? (
          <InlineMessage
            tone="error"
            className={onRetryLoad ? "cost-ledger-load-error" : undefined}
            title={errorTitle}
          >
            <p>{error}</p>
            {onRetryLoad ? (
              <Button disabled={retryBusy} onClick={onRetryLoad}>
                Try again
              </Button>
            ) : null}
          </InlineMessage>
        ) : null}
        <h2 ref={taskHeading} tabIndex={-1}>
          Price references
        </h2>
        <p>
          Dated research, excluded from operating totals. No vendor tier is
          assigned to NJ PBS.
        </p>
        <table className="cost-ledger-lines-table cost-ledger-reference-table">
          <thead>
            <tr>
              <th scope="col">Vendor / product</th>
              <th scope="col">Recorded price</th>
              <th scope="col">Source / read date</th>
              <th scope="col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.comparisons.map((item) => (
              <tr key={item.id} data-selected={item.id === selection}>
                <td>
                  <button
                    className="cost-ledger-name"
                    type="button"
                    disabled={busy}
                    onClick={() => setSelection(item.id)}
                  >
                    {item.product}
                  </button>
                  <small>{item.vendor}</small>
                </td>
                <td>
                  {item.status === "quote-required"
                    ? "Quote required"
                    : item.priceLabel}
                </td>
                <td>
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                    Source
                  </a>
                  <small>{item.sourceReadOn}</small>
                </td>
                <td>
                  <ActionControl
                    action={view.canEdit ? "edit" : "preview"}
                    label={view.canEdit ? "Edit" : "View"}
                    size="compact"
                    accessibleName={`${view.canEdit ? "Edit" : "View"} ${item.product} reference`}
                    disabled={busy}
                    onClick={() => setSelection(item.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <TaskDetails
        heading={row?.product ?? "Price reference"}
        label="Price reference details"
        open={!!row}
        onClose={() => setSelection(null)}
        onFocusFallback={() => taskHeading.current?.focus()}
      >
        {notice && row ? notice : null}
        {error && errorInDetails ? (
          <InlineMessage
            tone="error"
            className={onRetryLoad ? "cost-ledger-load-error" : undefined}
            title={errorTitle}
          >
            <p>{error}</p>
            {onRetryLoad ? (
              <Button disabled={retryBusy} onClick={onRetryLoad}>
                Try again
              </Button>
            ) : null}
          </InlineMessage>
        ) : null}
        {row ? (
          <>
            <p>{row.rangeNote}</p>
            <p>Excludes: {row.excludes || "Not recorded"}</p>
            {!view.canEdit ? (
              <>
                <dl className="cost-ledger-facts">
                  <div>
                    <dt>Recorded price</dt>
                    <dd>
                      {row.status === "quote-required"
                        ? "Quote required"
                        : row.priceLabel}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{row.status}</dd>
                  </div>
                  <div>
                    <dt>Monthly reference</dt>
                    <dd>
                      {row.status === "quote-required"
                        ? "Quote required"
                        : money(row.monthlyCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Annual reference</dt>
                    <dd>
                      {row.status === "quote-required"
                        ? "Quote required"
                        : money(row.annualCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Source / read date</dt>
                    <dd>
                      <a href={row.sourceUrl} target="_blank" rel="noreferrer">
                        Source
                      </a>{" "}
                      · {row.sourceReadOn}
                    </dd>
                  </div>
                </dl>
                <p>{row.notes}</p>
              </>
            ) : draft ? (
              <ComparisonEditor
                row={row}
                draft={draft}
                busy={busy}
                saving={savingKey === `comparison-${row.id}`}
                onChange={onChange}
                onSave={() => onSave(draft)}
              />
            ) : null}
          </>
        ) : null}
      </TaskDetails>
    </div>
  );
}

function ComparisonEditor({
  row,
  draft,
  busy,
  saving,
  onChange,
  onSave,
}: {
  row: LedgerComparison;
  draft: ComparisonDraft;
  busy: boolean;
  saving: boolean;
  onChange: (draft: ComparisonDraft) => void;
  onSave: () => void;
}) {
  return (
    <form
      className="cost-ledger-detail-section"
      aria-label={`${row.product} reference`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <fieldset disabled={busy} className="cost-ledger-comparison-edit">
        <label>
          Price label
          <TextInput
            aria-label={`${row.product} price label`}
            maxLength={200}
            value={draft.priceLabel}
            onChange={(event) =>
              onChange({ ...draft, priceLabel: event.target.value })
            }
          />
        </label>
        <label>
          Status
          <select
            className="field-control field-size-standard"
            aria-label={`${row.product} price status`}
            value={draft.status}
            onChange={(event) =>
              onChange({
                ...draft,
                status: event.target.value as ComparisonDraft["status"],
              })
            }
          >
            <option value="published">Published</option>
            <option value="quote-required">Quote required</option>
          </select>
        </label>
        {(["monthlyAmount", "annualAmount"] as const).map((field) => (
          <label key={field}>
            {field === "monthlyAmount"
              ? "Monthly amount ($)"
              : "Annual amount ($)"}
            <TextInput
              aria-label={`${row.product} ${field === "monthlyAmount" ? "monthly" : "annual"} amount`}
              disabled={draft.status === "quote-required"}
              inputMode="decimal"
              value={draft[field]}
              onChange={(event) =>
                onChange({ ...draft, [field]: event.target.value })
              }
            />
          </label>
        ))}
        <label>
          Price range note
          <Textarea
            aria-label={`${row.product} price range note`}
            maxLength={800}
            value={draft.rangeNote}
            onChange={(event) =>
              onChange({ ...draft, rangeNote: event.target.value })
            }
          />
        </label>
        <label>
          Source URL
          <TextInput
            aria-label={`${row.product} source URL`}
            type="url"
            value={draft.sourceUrl}
            onChange={(event) =>
              onChange({ ...draft, sourceUrl: event.target.value })
            }
          />
        </label>
        <label>
          Read date
          <TextInput
            aria-label={`${row.product} source read date`}
            type="date"
            value={draft.sourceReadOn}
            onChange={(event) =>
              onChange({ ...draft, sourceReadOn: event.target.value })
            }
          />
        </label>
        <label>
          Notes
          <Textarea
            aria-label={`${row.product} comparison notes`}
            maxLength={500}
            value={draft.notes}
            onChange={(event) =>
              onChange({ ...draft, notes: event.target.value })
            }
          />
        </label>
        <AsyncActionButton
          type="submit"
          size="standard"
          variant="secondary"
          label="Save comparison"
          pending={saving}
          pendingLabel="Saving…"
        />
      </fieldset>
    </form>
  );
}

const groups = [
  {
    label: "Purchase",
    fields: [
      ["purchaseCost", "Purchase cost ($)"],
      ["lifeMonths", "Life (months)"],
    ],
  },
  {
    label: "Power",
    fields: [
      ["watts", "Watts"],
      ["hoursPerMonth", "Hours per month"],
      ["centsPerKwh", "Cents per kWh"],
    ],
  },
  { label: "Internet", fields: [["internetShare", "Internet share ($)"]] },
] as const;
export function CostHardwarePanel({
  view,
  drafts,
  busy,
  retryBusy = busy,
  savingKey = null,
  error,
  errorInDetails = false,
  errorHeading,
  onRetryLoad,
  notice,
  onChange,
  onSave,
  onReloadHardware,
  reloadStatus,
  parse,
}: {
  view: CostLedgerView;
  drafts: HardwareDraft[];
  busy: boolean;
  retryBusy?: boolean;
  savingKey?: string | null;
  error: string | null;
  errorInDetails?: boolean;
  errorHeading?: string;
  onRetryLoad?: () => void;
  notice?: ReactNode;
  onChange: (draft: HardwareDraft) => void;
  onSave: () => void;
  onReloadHardware?: () => void;
  reloadStatus?: string | null;
  parse: (draft: HardwareDraft) => HardwareMachine | null;
}) {
  const taskHeading = useRef<HTMLHeadingElement>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const row = view.hardware.machines.find((item) => item.id === selection);
  const draft = drafts.find((item) => item.id === selection);
  const parsed = draft && parse(draft);
  const conflictReason = error
    ?.replace(
      / Reload and reconcile before saving; your drafts are (?:unchanged|retained)\.$/,
      "",
    )
    .replace(
      "changed while your draft was pending.",
      "changed in the saved ledger.",
    )
    .replace(/[.!?]+$/, "");
  const errorNotice = error ? (
    <InlineMessage
      tone="error"
      className={onRetryLoad ? "cost-ledger-load-error" : undefined}
      title={errorHeading ?? "Costs could not be saved"}
    >
      <div>
        <p>
          {onReloadHardware && !onRetryLoad
            ? `${conflictReason}. Your drafts are unchanged. Reload hardware assumptions to replace only hardware drafts; other drafts stay.`
            : error}
        </p>
        {onRetryLoad ? (
          <Button disabled={retryBusy} onClick={onRetryLoad}>
            Try again
          </Button>
        ) : null}
        {onReloadHardware && !onRetryLoad ? (
          <Button disabled={busy} onClick={onReloadHardware}>
            Reload hardware assumptions
          </Button>
        ) : null}
      </div>
    </InlineMessage>
  ) : null;
  const recoveryStatus = (
    <p role="status" aria-label="Hardware recovery" className="sr-only">
      {reloadStatus}
    </p>
  );
  return (
    <div className="cost-ledger-layout">
      <section className="cost-ledger-main cost-ledger-task-body">
        {!row ? recoveryStatus : null}
        {notice && !row ? notice : null}
        {!row || !errorInDetails ? errorNotice : null}
        <h2 ref={taskHeading} tabIndex={-1}>
          Hardware
        </h2>
        <p>
          Saved assumptions, separate from period overrides. A purchase cost
          requires a positive life. Optional groups can stay blank; complete
          groups can stand alone.
        </p>
        <table className="cost-ledger-lines-table cost-ledger-fleet-table">
          <thead>
            <tr>
              <th scope="col">Machine</th>
              <th scope="col" className="cost-ledger-number">
                Calculated / month
              </th>
              <th scope="col">Saved components</th>
              <th scope="col">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.hardware.machines.map((item) => (
              <tr key={item.id} data-selected={item.id === selection}>
                <td>
                  <button
                    className="cost-ledger-name"
                    type="button"
                    disabled={busy}
                    onClick={() => setSelection(item.id)}
                  >
                    {item.label}
                  </button>
                </td>
                <td className="cost-ledger-number">
                  {money(hardwareMonthlyCents(item))}
                </td>
                <td>
                  <small>
                    Purchase {money(item.purchaseCents)} /{" "}
                    {item.lifeMonths ?? "Blank"} months
                  </small>
                  <small>
                    Power {item.watts ?? "Blank"} W ·{" "}
                    {item.hoursPerMonth ?? "Blank"} h ·{" "}
                    {item.centsPerKwh ?? "Blank"} ¢/kWh
                  </small>
                  <small>Internet {money(item.internetShareCents)}</small>
                </td>
                <td>
                  <ActionControl
                    action={view.canEdit ? "edit" : "preview"}
                    label={view.canEdit ? "Edit" : "View"}
                    size="compact"
                    accessibleName={`${view.canEdit ? "Edit" : "View"} ${item.label} assumptions`}
                    disabled={busy}
                    onClick={() => setSelection(item.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!view.hardware.machines.length ? (
          <p>Set up the ledger before editing hardware assumptions.</p>
        ) : null}
      </section>
      <TaskDetails
        heading={row?.label ?? "Hardware"}
        label="Hardware details"
        open={!!row}
        onClose={() => setSelection(null)}
        onFocusFallback={() => taskHeading.current?.focus()}
      >
        {row ? recoveryStatus : null}
        {notice && row ? notice : null}
        {row && errorInDetails ? errorNotice : null}
        {row && draft ? (
          <>
            <p>
              Saved calculation: {money(hardwareMonthlyCents(row))}. A manual
              period override still wins; closed-month amounts stay frozen.
            </p>
            <p>
              Local calculation:{" "}
              {parsed && !validateHardwareMachine(parsed)
                ? money(hardwareMonthlyCents(parsed))
                : "Invalid inputs"}
              . Local drafts do not change saved totals.
            </p>
            {view.canEdit ? (
              <form
                aria-label={`${row.label} assumptions`}
                onSubmit={(event) => {
                  event.preventDefault();
                  onSave();
                }}
              >
                <fieldset
                  disabled={busy}
                  className="cost-ledger-comparison-edit"
                >
                  {groups.map((group) => (
                    <fieldset key={group.label}>
                      <legend>{group.label}</legend>
                      {group.fields.map(([field, label]) => (
                        <label key={field}>
                          {label}
                          <TextInput
                            aria-label={`${row.label} ${field === "purchaseCost" ? "purchase cost" : field === "lifeMonths" ? "life months" : field === "hoursPerMonth" ? "hours per month" : field === "centsPerKwh" ? "cents per kWh" : field === "internetShare" ? "internet share" : "watts"}`}
                            inputMode={
                              field === "purchaseCost" ||
                              field === "internetShare"
                                ? "decimal"
                                : "numeric"
                            }
                            value={draft[field]}
                            onChange={(event) =>
                              onChange({
                                ...draft,
                                [field]: event.target.value,
                              })
                            }
                          />
                        </label>
                      ))}
                    </fieldset>
                  ))}
                  <p>
                    Purchase ÷ life; watts × hours × cents/kWh ÷ 1,000; plus
                    internet. Hours: 0–744. All blank stays blank; an entered
                    zero is valid. Saving sends the complete five-machine set.
                  </p>
                  <AsyncActionButton
                    size="standard"
                    type="submit"
                    variant="primary"
                    label="Save hardware assumptions"
                    pending={savingKey === "hardware"}
                    pendingLabel="Saving…"
                  />
                </fieldset>
              </form>
            ) : (
              <dl className="cost-ledger-facts">
                <div>
                  <dt>Purchase cost</dt>
                  <dd>{money(row.purchaseCents)}</dd>
                </div>
                <div>
                  <dt>Life (months)</dt>
                  <dd>{row.lifeMonths ?? "Blank"}</dd>
                </div>
                <div>
                  <dt>Watts</dt>
                  <dd>{row.watts ?? "Blank"}</dd>
                </div>
                <div>
                  <dt>Hours per month</dt>
                  <dd>{row.hoursPerMonth ?? "Blank"}</dd>
                </div>
                <div>
                  <dt>Cents per kWh</dt>
                  <dd>{row.centsPerKwh ?? "Blank"}</dd>
                </div>
                <div>
                  <dt>Internet share</dt>
                  <dd>{money(row.internetShareCents)}</dd>
                </div>
              </dl>
            )}
          </>
        ) : null}
      </TaskDetails>
    </div>
  );
}
