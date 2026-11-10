import { useCallback, useEffect, useRef, useState } from "react";
import { useExitGuard } from "./ExitGuard";
import {
  CostWorkspaceChrome,
  CostLedgerGuard,
  CostHistory,
  CostReferencePanel,
  CostHardwarePanel,
  type CostTask,
} from "./CostLedgerWorkspace";
import {
  captureCostOperations,
  HardwareConflictError,
  closeBlock,
  mergeLatestHardware,
  validateCostRequest,
  type CostSaveOperation,
} from "./cost-ledger-save";
import { CostMonthReview } from "./CostMonthReview";
import { useAuth } from "../context/AuthContext";
import { canManageSettings } from "../lib/access";
import { cmsCostLedger } from "../lib/functions";
import { RequireCapability } from "./RequireCapability";
import {
  Button,
  AsyncActionButton,
  InlineMessage,
  Panel,
  TableFrame,
  TextInput,
  Textarea,
} from "../components/ui/Primitives";
import {
  SkeletonBlock,
  SkeletonCardGrid,
  SkeletonRegion,
  SkeletonTable,
  SkeletonText,
} from "../components/ui/Skeleton";
import { ActionControl } from "../components/ui/ActionControl";
import { Inspector } from "../components/ui/Inspector";
import { useMediaQuery } from "../components/ui/floating";
import costLedgerStyles from "./CostLedgerRoute.css?inline";

import {
  money,
  moneyInput,
  monthName,
  freshness,
  freshnessLabel,
  lineAmount,
  hardwareDraft,
  rebaseHardwareDraft,
  hardwareConflictError,
  parseHardwareDraft,
  comparisonDraft,
  lineDraft,
  sameDraft,
  message,
  type LedgerLine,
  type CostLedgerView,
  type CostLedgerMutation,
  type CostLedgerTransport,
  type LoadState,
  type HardwareDraft,
  type ComparisonDraft,
  type LineDraft,
} from "./cost-ledger-drafts";
export type { CostLedgerView, CostLedgerTransport } from "./cost-ledger-drafts";

function downloadCsv(csv: string, period: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cost-ledger-${period}.csv`;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

type CostFailureScope = "global" | "line" | "reference" | "hardware" | "batch";

export function CostLedgerSurface({ load, mutate }: CostLedgerTransport) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [saveError, setFailureMessage] = useState<string | null>(null);
  const failedReadPeriod = useRef<string | undefined>(undefined);
  const [errorKind, setErrorKind] = useState<"save" | "load" | "hardware-load">(
    "save",
  );
  const [errorScope, setErrorScope] = useState<CostFailureScope>("global");
  const [errorIdentity, setErrorIdentity] = useState<string | null>(null);
  const setSaveError = useCallback(
    (
      value: string | null,
      scope: CostFailureScope = "global",
      identity: string | null = null,
    ) => {
      setFailureMessage(value);
      setErrorKind("save");
      setErrorScope(scope);
      setErrorIdentity(identity);
    },
    [],
  );
  const errorHeading =
    errorKind !== "save" ? "Costs could not be loaded" : "Costs need attention";
  const [hardwareNeedsReload, setHardwareNeedsReload] = useState(false);
  const [hardwareReloaded, setHardwareReloaded] = useState(false);
  const [saveReport, setReportMessage] = useState<string | null>(null);
  const failedBatchReport = useRef<string | null>(null);
  const setSaveReport = useCallback((value: string | null) => {
    if (value === null) failedBatchReport.current = null;
    setReportMessage(value);
  }, []);
  const [saveReportHadFailure, setSaveReportHadFailure] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const reloadRequiredRef = useRef(false);
  const saveLock = useRef(false);
  const generations = useRef<Record<string, number>>({});
  const completedOperations = useRef<CostSaveOperation[]>([]);
  const [acknowledged, setAcknowledged] = useState<Record<string, number>>({});
  const [monthReview, setMonthReview] = useState(false);
  const [monthReviewAttempted, setMonthReviewAttempted] = useState(false);
  const [monthBlocked, setMonthBlocked] = useState<{
    reason: string;
    lineIds: string[];
  } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [hardware, setHardware] = useState<HardwareDraft[]>([]);
  const hardwareConflicts = useRef(new Set<string>());
  const [comparisons, setComparisons] = useState<
    Record<string, ComparisonDraft>
  >({});
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const previousView = useRef<CostLedgerView | null>(null);
  const requestExit = useExitGuard();
  const [task, setTask] = useState<CostTask>("ledger");
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const readGeneration = useRef(0);
  // undefined selects month details; null closes the pane. Drafts belong to the route.
  const compactDetails = useMediaQuery("(max-width: 73.749rem)");
  const [selectedLine, setSelectedLine] = useState<string | null | undefined>(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 73.749rem)").matches
        ? null
        : undefined,
  );
  useEffect(() => {
    if (monthReview) return;
    const sheet = document.querySelector<HTMLElement>(
      '.cost-ledger-inspector[role="dialog"]',
    );
    const active = document.activeElement;
    if (
      sheet &&
      (active === document.body ||
        (active instanceof HTMLButtonElement && active.disabled))
    )
      sheet.querySelector<HTMLElement>(".ui-inspector-heading")?.focus();
  }, [
    saving,
    loadingPeriod,
    reloadRequired,
    selectedLine,
    monthReview,
    saveError,
    task,
  ]);
  useEffect(() => {
    if (compactDetails)
      setSelectedLine((current) => (current === undefined ? null : current));
  }, [compactDetails]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [project, setProject] = useState("");
  const [lineState, setLineState] = useState("");
  const [sort, setSort] = useState("name");
  const [comfortable, setComfortable] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const monthDetailsTrigger = useRef<HTMLButtonElement>(null);
  const [focusDetails, setFocusDetails] = useState(false);
  const [monthDrawer, setMonthDrawer] = useState(false);
  const returnTarget = useRef<{ id: string; amount: boolean } | null>(null);
  const rowControls = useRef(new Map<string, HTMLButtonElement>());
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const amountForm = useRef<HTMLFormElement>(null);
  const [amountFocus, setAmountFocus] = useState(0);
  useEffect(() => {
    if (amountFocus)
      amountForm.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [amountFocus]);

  const refresh = useCallback(
    async (
      period?: string,
      saved?: CostSaveOperation[],
      hardwareOnly = false,
    ) => {
      const generation = ++readGeneration.current;
      setHardwareReloaded(false);
      if (saved !== undefined && !saveLock.current) setLoadingPeriod(true);
      if (!saved) {
        setSaveReport(null);
        setFocusDetails(false);
        setMonthDrawer(false);
        if (previousView.current) setLoadingPeriod(true);
        else setState({ status: "loading" });
      }
      setSaveError(null);
      try {
        const view = await load(period);
        if (generation !== readGeneration.current) return false;
        const previous = previousView.current;
        const preserve =
          (hardwareOnly || saved !== undefined || reloadRequiredRef.current) &&
          previous?.period === view.period &&
          !completedOperations.current.some(
            (operation) => operation.request.action === "seed",
          );
        const successful = new Map(
          completedOperations.current.map((operation) => [
            operation.key,
            operation.generation,
          ]),
        );
        const wasReconciled = (key: string) =>
          successful.has(key) &&
          successful.get(key) === (generations.current[key] ?? 0);
        setAmounts((current) =>
          Object.fromEntries(
            view.lines.map((line) => {
              const oldLine = previous?.lines.find((row) => row.id === line.id);
              const edited =
                oldLine &&
                current[line.id] !== undefined &&
                current[line.id] !== moneyInput(oldLine.monthlyCents);
              const wasSaved = wasReconciled(`amount-${line.id}`);
              return [
                line.id,
                preserve && edited && !wasSaved
                  ? current[line.id]
                  : moneyInput(line.monthlyCents),
              ];
            }),
          ),
        );
        if (
          !preserve ||
          hardwareOnly ||
          completedOperations.current.some(
            (operation) => operation.request.action === "saveHardware",
          )
        ) {
          hardwareConflicts.current.clear();
          setHardwareNeedsReload(false);
        }
        setHardware((current) =>
          view.hardware.machines.map((machine) => {
            const oldMachine = previous?.hardware.machines.find(
              (row) => row.id === machine.id,
            );
            const draft = current.find((row) => row.id === machine.id);
            const edited =
              draft &&
              oldMachine &&
              !sameDraft(draft, hardwareDraft(oldMachine));
            return preserve &&
              edited &&
              !hardwareOnly &&
              !wasReconciled("hardware")
              ? rebaseHardwareDraft(
                  draft,
                  oldMachine!,
                  machine,
                  hardwareConflicts.current,
                )
              : hardwareDraft(machine);
          }),
        );
        setComparisons((current) =>
          Object.fromEntries(
            view.comparisons.map((row) => {
              const oldRow = previous?.comparisons.find(
                (item) => item.id === row.id,
              );
              const draft = current[row.id];
              const edited =
                draft && oldRow && !sameDraft(draft, comparisonDraft(oldRow));
              const wasSaved = wasReconciled(`comparison-${row.id}`);
              return [
                row.id,
                preserve && edited && !wasSaved ? draft : comparisonDraft(row),
              ];
            }),
          ),
        );
        setLines((current) =>
          Object.fromEntries(
            view.lines.map((row) => {
              const oldRow = previous?.lines.find((item) => item.id === row.id);
              const draft = current[row.id];
              const edited =
                draft && oldRow && !sameDraft(draft, lineDraft(oldRow));
              const wasSaved = wasReconciled(`line-${row.id}`);
              return [
                row.id,
                preserve && edited && !wasSaved ? draft : lineDraft(row),
              ];
            }),
          ),
        );
        previousView.current = view;
        setState({ status: "ready", view });
        if (hardwareOnly) setHardwareReloaded(true);
        completedOperations.current = [];
        setAcknowledged({});
        if (reloadRequiredRef.current) {
          const failedDetail = failedBatchReport.current;
          setSaveReport(null);
          setSaveReportHadFailure(false);
          if (failedDetail) setSaveError(failedDetail, "batch");
        }
        reloadRequiredRef.current = false;
        setReloadRequired(false);
        return true;
      } catch (error) {
        if (generation !== readGeneration.current) return false;
        if (completedOperations.current.length || reloadRequiredRef.current) {
          reloadRequiredRef.current = true;
          setReloadRequired(true);
          setSaveError(
            `The write succeeded for ${completedOperations.current.map((operation) => operation.label).join(", ")}. Reload failed: ${message(error, "view unavailable").replace(/[.!?]+$/, "")}. Reload saved costs before another write.`,
            "batch",
          );
          return false;
        }
        if (previousView.current) {
          const context = hardwareOnly
            ? "Hardware assumptions could not be reloaded. All drafts remain."
            : "The requested cost view could not be loaded. The last saved view remains displayed. Any drafts you chose to discard are already cleared.";
          failedReadPeriod.current = period;
          setSaveError(context, hardwareOnly ? "hardware" : "global");
          setErrorKind(hardwareOnly ? "hardware-load" : "load");
          return false;
        }
        setState({
          status: "error",
          message: message(error, "The cost ledger could not be loaded."),
          period,
        });
        return false;
      } finally {
        if (generation === readGeneration.current) setLoadingPeriod(false);
      }
    },
    [load, setSaveError, setSaveReport],
  );

  useEffect(() => {
    void refresh();
    return () => {
      readGeneration.current++;
    };
  }, [refresh]);

  if (state.status === "loading") return <CostLedgerSkeleton />;
  if (state.status === "error") {
    return (
      <div className="cost-ledger">
        <InlineMessage tone="error" title="Costs could not be loaded">
          <p>{state.message}</p>
          <Button onClick={() => void refresh(state.period)}>Retry</Button>
        </InlineMessage>
      </div>
    );
  }

  const { view } = state;
  const periods = [...view.periods];
  if (!periods.some((period) => period.id === view.period)) {
    periods.push({ id: view.period, status: view.periodStatus });
  }
  if (
    typeof view.currentPeriod === "string" &&
    view.currentPeriod.length > 0 &&
    !periods.some((period) => period.id === view.currentPeriod)
  ) {
    periods.push({ id: view.currentPeriod, status: "open" });
  }
  periods.sort((left, right) => left.id.localeCompare(right.id));
  const selected = view.lines.find((line) => line.id === selectedLine);
  const lineErrorInDetails =
    !!selected &&
    errorKind === "save" &&
    (errorScope === "batch" ||
      (errorScope === "line" && errorIdentity === selected.id));
  const visibleLines = view.lines
    .filter((line) => {
      const matchesSearch = `${line.label} ${line.vendor} ${line.notes}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase());
      return (
        matchesSearch &&
        (!category || line.category === category) &&
        (!project || line.project === project) &&
        (!lineState || line.state === lineState)
      );
    })
    .sort((left, right) => {
      if (sort === "amount") {
        const leftKnown = left.state === "known" && left.monthlyCents !== null;
        const rightKnown =
          right.state === "known" && right.monthlyCents !== null;
        if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
        if (leftKnown && rightKnown && left.monthlyCents !== right.monthlyCents)
          return left.monthlyCents! - right.monthlyCents!;
      }
      return (
        left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
      );
    });
  function openLine(line: LedgerLine, focusAmount: boolean) {
    setFocusDetails(true);
    returnTarget.current = { id: line.id, amount: focusAmount };
    setSelectedLine(line.id);
    if (focusAmount) setAmountFocus((value) => value + 1);
  }
  function restoreLineFocus() {
    if (selectedLine === undefined && !focusDetails) return;
    const target = returnTarget.current;
    const control =
      target && rowControls.current.get(`${target.id}:${target.amount}`);
    if (control && !control.disabled) {
      control.focus();
      return;
    }
    const fallback =
      target || monthDetailsTrigger.current?.disabled
        ? resultsHeading.current
        : (monthDetailsTrigger.current ?? resultsHeading.current);
    fallback?.focus();
  }

  const pendingCount =
    view.lines.reduce(
      (count, line) =>
        count +
        Number(
          acknowledged[`amount-${line.id}`] !==
            (generations.current[`amount-${line.id}`] ?? 0) &&
            amounts[line.id] !== undefined &&
            amounts[line.id] !== moneyInput(line.monthlyCents),
        ) +
        Number(
          acknowledged[`line-${line.id}`] !==
            (generations.current[`line-${line.id}`] ?? 0) &&
            lines[line.id] !== undefined &&
            !sameDraft(lines[line.id], lineDraft(line)),
        ),
      0,
    ) +
    view.hardware.machines.filter((machine) => {
      const draft = hardware.find((row) => row.id === machine.id);
      return (
        acknowledged.hardware !== (generations.current.hardware ?? 0) &&
        draft &&
        !sameDraft(draft, hardwareDraft(machine))
      );
    }).length +
    view.comparisons.filter(
      (row) =>
        acknowledged[`comparison-${row.id}`] !==
          (generations.current[`comparison-${row.id}`] ?? 0) &&
        comparisons[row.id] &&
        !sameDraft(comparisons[row.id], comparisonDraft(row)),
    ).length;

  const writeLocked = saving !== null || loadingPeriod || reloadRequired;
  const changed = (key: string) => {
    if (saveLock.current) return false;
    generations.current[key] = (generations.current[key] ?? 0) + 1;
    setSaveReport(null);
    return true;
  };

  async function execute(only?: string, direct?: CostLedgerMutation) {
    if (
      saveLock.current ||
      loadingPeriod ||
      reloadRequiredRef.current ||
      !view.canEdit
    )
      return { status: "failed" } as const;
    setMonthBlocked(null);
    setHardwareNeedsReload(false);
    if (
      direct &&
      (direct.action === "closeMonth" || direct.action === "reopenMonth") &&
      pendingCount > 0
    ) {
      setSaveError(
        "Save or discard pending drafts before changing month status.",
      );
      return { status: "failed" } as const;
    }
    const single = only?.match(/^(amount|line|comparison)-(.+)$/);
    const failureScope: CostFailureScope = direct
      ? "global"
      : only === "hardware"
        ? "hardware"
        : single
          ? single[1] === "comparison"
            ? "reference"
            : "line"
          : "batch";
    const failureIdentity = single?.[2] ?? null;
    saveLock.current = true;
    setSaving(only ?? "all");
    setSaveError(null);
    setSaveReport(null);
    setSaveReportHadFailure(false);
    let operations: CostSaveOperation[] = [];
    const completed: CostSaveOperation[] = [];
    let failedAt = 0,
      failure: unknown;
    try {
      operations = direct
        ? [
            {
              key: only ?? direct.action,
              label:
                direct.action === "seed"
                  ? "Ledger setup"
                  : `${view.period} ${direct.action === "closeMonth" ? "close" : "reopen"}`,
              generation: 0,
              request: structuredClone(direct),
            },
          ]
        : captureCostOperations(
            view,
            { amounts, hardware, comparisons, lines },
            generations.current,
            only,
            hardwareConflicts.current,
          );
      // Validate the entire captured batch and merge the latest full fleet before the first write.
      if (
        operations.some(
          (operation) => operation.request.action === "saveHardware",
        )
      ) {
        const latest = await load(view.period);
        if (latest.period !== view.period)
          throw new Error(
            "The requested hardware month changed. Reload before saving.",
          );
        if (!latest.canEdit)
          throw new Error("The server no longer permits edits to this ledger.");
        for (const operation of operations) {
          if (operation.request.action === "savePeriodAmount") {
            const amountRequest = operation.request;
            const latestLine = latest.lines.find(
              (row) => row.id === amountRequest.lineId,
            );
            if (
              latest.periodStatus !== "open" ||
              !latestLine ||
              !latestLine.enabled ||
              latestLine.state === "inactive" ||
              latestLine.state === "absent"
            )
              throw new Error(
                "The latest month or line no longer permits this amount edit. Reload before saving.",
              );
          }
          if (operation.request.action === "saveLine") {
            const lineRequest = operation.request.line;
            const latestLine = latest.lines.find(
              (row) => row.id === lineRequest.id,
            );
            if (
              !latestLine ||
              latestLine.standingCents !== lineRequest.amountCents ||
              latestLine.label !== lineRequest.label ||
              latestLine.cadence !== lineRequest.cadence
            )
              throw new Error(
                `${lineRequest.label} standing fields changed in the saved ledger. Reload and reconcile before saving.`,
              );
          }
        }
        operations = operations.map((operation) =>
          mergeLatestHardware(operation, view, latest),
        );
      }
      for (const operation of operations)
        validateCostRequest(operation.request);
      for (let index = 0; index < operations.length; index++) {
        failedAt = index;
        const operation = operations[index];
        try {
          const result = await mutate(operation.request);
          const blocked = closeBlock(result);
          if (blocked) {
            setMonthBlocked(blocked);
            throw new Error(
              `Month action blocked: ${blocked.reason}. Lines: ${blocked.lineIds.join(", ") || "none returned"}.`,
            );
          }
          completed.push(operation);
          completedOperations.current.push(operation);
          setAcknowledged((current) => ({
            ...current,
            [operation.key]: operation.generation,
          }));
          if (
            operation.request.action === "closeMonth" ||
            operation.request.action === "reopenMonth"
          )
            setMonthReview(false);
        } catch (error) {
          failure = error;
          break;
        }
      }
      const reloaded = completed.length
        ? await refresh(view.period, completed)
        : true;
      if (failure) {
        setSaveReportHadFailure(true);
        const saved = completed.length
          ? `Saved ${completed.length} of ${operations.length}: ${completed.map((operation) => operation.label).join("; ")}. `
          : "No changes were saved. ";
        const remaining = operations.slice(failedAt + 1);
        const detail = `${saved}Failed: ${operations[failedAt].label}. ${message(failure, "Request failed.")} ${remaining.length ? `Not sent: ${remaining.map((operation) => operation.label).join("; ")}.` : ""}`;
        failedBatchReport.current = detail;
        setSaveReport(detail);
        if (reloaded) setSaveError(detail, failureScope, failureIdentity);
        return { status: "failed" } as const;
      }
      if (completed.length)
        setSaveReport(
          `Saved ${completed.length} change${completed.length === 1 ? "" : "s"}: ${completed.map((operation) => operation.label).join("; ")}.${reloaded ? " Saved totals and CSV are refreshed." : " Reload is required before another write."}`,
        );
      return { status: reloaded ? "saved" : "failed" } as const;
    } catch (error) {
      if (error instanceof HardwareConflictError) setHardwareNeedsReload(true);
      setSaveError(
        message(
          error,
          "The cost drafts could not be validated. No changes were sent.",
        ),
        failureScope,
        failureIdentity,
      );
      return { status: "failed" } as const;
    } finally {
      saveLock.current = false;
      setSaving(null);
    }
  }
  function saveAmount(line: LedgerLine) {
    void execute(`amount-${line.id}`);
  }
  function saveLine(line: LedgerLine) {
    void execute(`line-${line.id}`);
  }
  function saveHardware() {
    void execute("hardware");
  }
  function saveComparison(row: ComparisonDraft) {
    void execute(`comparison-${row.id}`);
  }
  function retryRead() {
    const period = failedReadPeriod.current;
    const hardwareOnly = errorKind === "hardware-load";
    const retry = async () => {
      document
        .querySelector<HTMLSelectElement>('select[aria-label="Ledger month"]')
        ?.focus();
      if (!hardwareOnly) discardDrafts();
      const read = refresh(period, undefined, hardwareOnly);
      const generation = readGeneration.current;
      await read;
      requestAnimationFrame(() => {
        if (
          generation === readGeneration.current &&
          document.activeElement === document.body
        ) {
          document
            .querySelector<HTMLSelectElement>(
              'select[aria-label="Ledger month"]',
            )
            ?.focus();
        }
      });
    };
    if (hardwareOnly) void retry();
    else requestExit(() => void retry());
  }

  function discardDrafts() {
    if (saveLock.current) return;
    const savedView = previousView.current ?? view;
    hardwareConflicts.current.clear();
    setHardwareNeedsReload(false);
    setAmounts(
      Object.fromEntries(
        savedView.lines.map((line) => [line.id, moneyInput(line.monthlyCents)]),
      ),
    );
    setLines(
      Object.fromEntries(
        savedView.lines.map((line) => [line.id, lineDraft(line)]),
      ),
    );
    setHardware(savedView.hardware.machines.map(hardwareDraft));
    setComparisons(
      Object.fromEntries(
        savedView.comparisons.map((row) => [row.id, comparisonDraft(row)]),
      ),
    );
    for (const key of Object.keys(generations.current))
      generations.current[key]++;
    setSaveError(null);
    setSaveReport(null);
  }

  function reloadConfirmedView() {
    if (saving !== null || loadingPeriod || !reloadRequiredRef.current) return;
    const active = document.activeElement;
    const owner =
      active instanceof HTMLElement
        ? active.closest<HTMLElement>(
            ".cost-ledger-month-review, .cost-ledger-inspector",
          )
        : null;
    const target = owner?.matches(".cost-ledger-month-review")
      ? owner
      : (owner?.querySelector<HTMLElement>(".ui-inspector-heading") ??
        (task === "ledger"
          ? resultsHeading.current
          : document
              .getElementById(`cost-panel-${task}`)
              ?.querySelector<HTMLElement>("h2")));
    target?.focus();
    void refresh(view.period, []);
  }

  const recoveryNotice = reloadRequired ? (
    <InlineMessage
      className="cost-ledger-recovery"
      tone="warning"
      role="alert"
      title="Saved view needs a reload"
    >
      <div>
        {saveReportHadFailure && saveReport ? <p>{saveReport}</p> : null}
        <p>
          {saveError ||
            "A write was confirmed, but its saved view could not be reloaded."}
          {pendingCount > 0 ? " Failed and unsent drafts remain." : ""}
        </p>
        <Button
          disabled={loadingPeriod || saving !== null}
          onClick={reloadConfirmedView}
        >
          Reload saved costs
        </Button>
      </div>
    </InlineMessage>
  ) : null;

  return (
    <div
      className="cost-ledger"
      data-density={comfortable ? "comfortable" : "compact"}
    >
      <CostLedgerGuard dirty={pendingCount > 0} busy={saving !== null} />
      <CostWorkspaceChrome
        view={view}
        periods={periods}
        busy={saving !== null || loadingPeriod}
        periodDisabled={reloadRequired}
        activity={
          saving !== null
            ? "Saving costs…"
            : loadingPeriod
              ? "Loading saved costs…"
              : reloadRequired
                ? "Saved view needs a reload"
                : undefined
        }
        pendingCount={pendingCount}
        task={task}
        onTask={(next) => {
          setSelectedLine(null);
          setFocusDetails(false);
          // Batch errors name their scope and stay visible while staff find that draft.
          setHardwareReloaded(false);
          setTask(next);
        }}
        onPeriod={(period) =>
          requestExit(() => {
            discardDrafts();
            void refresh(period);
          })
        }
        onReload={() =>
          reloadRequired
            ? reloadConfirmedView()
            : requestExit(() => {
                discardDrafts();
                void refresh(view.period);
              })
        }
        onMonthAction={() => {
          setMonthBlocked(null);
          setMonthReviewAttempted(false);
          setMonthReview(true);
        }}
        saveAction={
          view.canEdit ? (
            <AsyncActionButton
              className="cost-ledger-global-save"
              size="standard"
              variant={pendingCount ? "primary" : "secondary"}
              label="Save changes"
              pending={saving !== null}
              pendingLabel="Saving costs…"
              disabled={!pendingCount || loadingPeriod || reloadRequired}
              onClick={() => void execute()}
            />
          ) : undefined
        }
        csvDisabled={reloadRequired}
        onCsv={() => {
          if (!reloadRequired) downloadCsv(view.csv, view.period);
        }}
      />
      {monthReview ? (
        <CostMonthReview
          view={view}
          pendingCount={pendingCount}
          busy={saving !== null || loadingPeriod}
          monthSaving={saving === "close" || saving === "reopen"}
          draftSaving={saving === "all"}
          reloadRequired={reloadRequired}
          recoveryNotice={recoveryNotice}
          blocked={monthBlocked}
          error={
            monthReviewAttempted && errorKind === "save" ? saveError : null
          }
          onClose={() => setMonthReview(false)}
          onSave={() => {
            setMonthReviewAttempted(true);
            void execute();
          }}
          onDiscard={discardDrafts}
          onConfirm={() => {
            setMonthReviewAttempted(true);
            void execute(view.periodStatus === "open" ? "close" : "reopen", {
              action:
                view.periodStatus === "open" ? "closeMonth" : "reopenMonth",
              period: view.period,
            });
          }}
        />
      ) : null}
      {saveReport && !saveReportHadFailure && !reloadRequired ? (
        <p role="status">{saveReport}</p>
      ) : null}
      {!monthReview && (task === "history" || (task === "ledger" && !selected))
        ? recoveryNotice
        : null}
      {task === "ledger" ? (
        <div className="cost-ledger-intro">
          <div>
            <h2>Monthly ledger</h2>
            <p>
              CMS, hosting, tooling and hardware costs. Labor excluded.
              USD.
            </p>
          </div>
        </div>
      ) : null}
      {saveError &&
      !reloadRequired &&
      !monthReview &&
      !lineErrorInDetails &&
      (task === "ledger" || task === "history") ? (
        <InlineMessage
          tone="error"
          className={
            errorKind !== "save" ? "cost-ledger-load-error" : undefined
          }
          title={errorHeading ?? "Costs need attention"}
        >
          <p>{saveError}</p>
          {errorKind !== "save" ? (
            <Button
              disabled={loadingPeriod || saving !== null}
              onClick={retryRead}
            >
              Try again
            </Button>
          ) : null}
        </InlineMessage>
      ) : null}
      {!reloadRequired && (pendingCount || saving !== null) ? (
        <p role="status">
          {saving !== null
            ? "Saving cost changes…"
            : `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}.`}{" "}
          Saved totals and CSV exclude local drafts.
        </p>
      ) : null}
      <section
        id="cost-panel-ledger"
        role="tabpanel"
        aria-labelledby="cost-task-tab-ledger"
        hidden={task !== "ledger"}
      >
        <div
          className="cost-ledger-layout"
          data-details-open={selectedLine !== null}
        >
          <div className="cost-ledger-main">
            <section
              className="cost-ledger-total-grid"
              aria-label="Saved cost totals"
            >
              <TotalCard
                label="Known monthly total"
                value={
                  view.knownLineCount ? money(view.monthlyCents) : "No amounts"
                }
                detail={`${monthName(view.period)} · ${view.periodStatus} month`}
              />
              <TotalCard
                label="Year to date"
                value={
                  view.yearToDateMonths
                    ? money(view.yearToDateCents)
                    : "No tracked months"
                }
                detail={`${view.yearToDateMonths} calendar month${view.yearToDateMonths === 1 ? "" : "s"} tracked`}
              />
              <TotalCard
                label="Annual run rate"
                value={
                  view.knownLineCount
                    ? money(view.annualRunRateCents)
                    : "No amounts"
                }
                detail="Known monthly total × 12"
              />
            </section>
            <div className="cost-ledger-coverage">
              <span>
                {view.knownLineCount} known · {view.blankLineCount} blank ·{" "}
                {view.lines.filter((line) => line.state === "inactive").length}{" "}
                inactive
                {view.lines.some((line) => line.state === "absent")
                  ? ` · ${view.lines.filter((line) => line.state === "absent").length} not included`
                  : ""}
                . Blank amounts are excluded, not counted as zero.
              </span>
              {view.blankLineCount ? (
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => {
                    setLineState("blank");
                    setSearch("");
                    setCategory("");
                    setProject("");
                  }}
                >
                  Review blanks
                </Button>
              ) : null}
            </div>
            <section aria-labelledby="cost-ledger-lines">
              <div className="cost-ledger-section-heading">
                <h3 id="cost-ledger-lines" tabIndex={-1} ref={resultsHeading}>
                  Cost lines
                </h3>
                <div className="cost-ledger-tools">
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-pressed={comfortable}
                    onClick={() => setComfortable((value) => !value)}
                  >
                    Comfortable rows
                  </Button>
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-expanded={
                      task === "ledger" &&
                      selectedLine === undefined &&
                      (!compactDetails || monthDrawer)
                    }
                    ref={monthDetailsTrigger}
                    disabled={writeLocked}
                    onClick={() => {
                      setFocusDetails(true);
                      setMonthDrawer(compactDetails);
                      returnTarget.current = null;
                      setSelectedLine(
                        selectedLine === undefined ? null : undefined,
                      );
                    }}
                  >
                    Month details
                  </Button>
                </div>
              </div>
              <div
                className="cost-ledger-tools"
                data-filters-open={showFilters}
              >
                <TextInput
                  aria-label="Search cost lines"
                  controlSize="compact"
                  placeholder="Find a service or cost line…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <Button
                  className="cost-ledger-filter-toggle"
                  size="standard"
                  variant="secondary"
                  aria-expanded={showFilters}
                  onClick={() => setShowFilters((value) => !value)}
                >
                  Filters
                </Button>
                <label className="cost-ledger-filter">
                  <span className="sr-only">Category filter</span>
                  <select
                    className="field-control"
                    aria-label="Category filter"
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    <option value="">All categories</option>
                    {Object.keys(view.byCategory).map((value) => (
                      <option key={value} value={value}>
                        {breakdownLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cost-ledger-filter">
                  <span className="sr-only">Project filter</span>
                  <select
                    className="field-control"
                    aria-label="Project filter"
                    value={project}
                    onChange={(event) => setProject(event.target.value)}
                  >
                    <option value="">All projects</option>
                    {Object.keys(view.byProject).map((value) => (
                      <option key={value} value={value}>
                        {breakdownLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="cost-ledger-tools cost-ledger-scopes">
                <label>
                  Show{" "}
                  <select
                    className="field-control"
                    aria-label="Line state"
                    value={lineState}
                    onChange={(event) => setLineState(event.target.value)}
                  >
                    <option value="">All lines</option>
                    <option value="known">Known</option>
                    <option value="blank">Blank</option>
                    <option value="inactive">Inactive</option>
                    <option value="absent">Not included</option>
                  </select>
                </label>
                <label>
                  Sort{" "}
                  <select
                    className="field-control"
                    aria-label="Sort cost lines"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="name">Name</option>
                    <option value="amount">Amount</option>
                  </select>
                </label>
                <span>
                  {visibleLines.length} of {view.lines.length} lines
                </span>
              </div>
              {view.lines.length === 0 ? (
                <InlineMessage title="The cost ledger has not been set up">
                  <p>Set up the ledger before it can show cost lines.</p>
                  {view.canEdit ? (
                    <Button
                      disabled={writeLocked}
                      onClick={() => void execute("seed", { action: "seed" })}
                    >
                      {saving === "seed" ? "Setting up…" : "Set up cost ledger"}
                    </Button>
                  ) : null}
                </InlineMessage>
              ) : (
                <TableFrame
                  aria-label="Cost ledger lines"
                  className="cost-ledger-table-frame cost-ledger-lines-frame"
                >
                  <table className="cost-ledger-lines-table">
                    <thead>
                      <tr>
                        <th scope="col">Cost line</th>
                        <th scope="col" className="cost-ledger-category">
                          Category
                        </th>
                        <th scope="col" className="cost-ledger-project">
                          Project
                        </th>
                        <th scope="col" className="cost-ledger-number">
                          Amount
                        </th>
                        <th scope="col" className="cost-ledger-source">
                          Source / refresh
                        </th>
                        <th scope="col">
                          <span className="sr-only">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleLines.map((line) => {
                        const pending =
                          acknowledged[`amount-${line.id}`] !==
                            (generations.current[`amount-${line.id}`] ?? 0) &&
                          amounts[line.id] !== undefined &&
                          amounts[line.id] !== moneyInput(line.monthlyCents);
                        return (
                          <tr
                            key={line.id}
                            data-selected={selectedLine === line.id}
                          >
                            <td data-label="Line">
                              <button
                                type="button"
                                className="cost-ledger-name"
                                ref={(element) => {
                                  if (element)
                                    rowControls.current.set(
                                      `${line.id}:false`,
                                      element,
                                    );
                                  else
                                    rowControls.current.delete(
                                      `${line.id}:false`,
                                    );
                                }}
                                disabled={writeLocked}
                                onClick={() => openLine(line, false)}
                              >
                                {line.label}
                              </button>
                              <small className="cost-ledger-mobile-meta">
                                {breakdownLabel(line.category)} ·{" "}
                                {breakdownLabel(line.project)}
                              </small>
                            </td>
                            <td className="cost-ledger-category">
                              {breakdownLabel(line.category)}
                            </td>
                            <td className="cost-ledger-project">
                              {breakdownLabel(line.project)}
                            </td>
                            <td
                              data-label="Amount"
                              className="cost-ledger-number"
                            >
                              <button
                                type="button"
                                className={`cost-ledger-amount ${line.state === "blank" ? "cost-ledger-blank" : ""}`}
                                ref={(element) => {
                                  if (element)
                                    rowControls.current.set(
                                      `${line.id}:true`,
                                      element,
                                    );
                                  else
                                    rowControls.current.delete(
                                      `${line.id}:true`,
                                    );
                                }}
                                aria-label={`${line.label} amount for ${monthName(view.period)}: ${lineAmount(line)}${pending ? "; pending edit" : ""}`}
                                disabled={writeLocked}
                                onClick={() => openLine(line, true)}
                              >
                                {lineAmount(line)}
                                {pending ? (
                                  <span className="cost-ledger-pending">
                                    Pending
                                  </span>
                                ) : null}
                              </button>
                            </td>
                            <td className="cost-ledger-source">
                              <span>
                                {line.source === "auto"
                                  ? "Automatic"
                                  : "Manual"}
                              </span>
                              <small>
                                {freshnessLabel(
                                  line.freshnessStatus,
                                  line.freshnessAt,
                                )}
                              </small>
                            </td>
                            <td>
                              <ActionControl
                                action={view.canEdit ? "edit" : "preview"}
                                label={view.canEdit ? "Edit" : "View"}
                                size="compact"
                                accessibleName={
                                  view.canEdit
                                    ? `Edit ${line.label} line`
                                    : `View ${line.label} details`
                                }
                                disabled={writeLocked}
                                onClick={() => openLine(line, false)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                      {!visibleLines.length ? (
                        <tr>
                          <td colSpan={6}>No lines match these filters.</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </TableFrame>
              )}
            </section>
          </div>
          <Inspector
            compactQuery="(max-width: 73.749rem)"
            label={selected ? "Line details" : "Month details"}
            heading={selected?.label ?? monthName(view.period)}
            open={
              task === "ledger" &&
              selectedLine !== null &&
              !(compactDetails && selectedLine === undefined && !monthDrawer)
            }
            autoFocusOnOpen={focusDetails}
            storageKey="costs"
            resizable={false}
            fitViewport
            focusReturn={null}
            onFocusFallback={restoreLineFocus}
            onClose={() => setSelectedLine(null)}
            className="cost-ledger-inspector"
          >
            {selected && !monthReview ? recoveryNotice : null}
            {saveError &&
            !reloadRequired &&
            !monthReview &&
            lineErrorInDetails ? (
              <InlineMessage
                tone="error"
                className={
                  errorKind !== "save" ? "cost-ledger-load-error" : undefined
                }
                title={errorHeading ?? "Costs need attention"}
              >
                <p>{saveError}</p>
                {errorKind !== "save" ? (
                  <Button
                    disabled={loadingPeriod || saving !== null}
                    onClick={retryRead}
                  >
                    Try again
                  </Button>
                ) : null}
              </InlineMessage>
            ) : null}
            {selected ? (
              <>
                <section className="cost-ledger-detail-section">
                  <h3>Period amount</h3>
                  <p>
                    {monthName(view.period)} · {view.periodStatus}
                  </p>
                  {view.canEdit &&
                  view.periodStatus === "open" &&
                  (selected.state === "known" || selected.state === "blank") ? (
                    <form
                      ref={amountForm}
                      aria-label={`${selected.label} period amount`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveAmount(selected);
                      }}
                    >
                      <label>
                        Amount ($)
                        <TextInput
                          aria-label={`${selected.label} amount for ${monthName(view.period)}`}
                          aria-describedby="cost-ledger-amount-help"
                          disabled={writeLocked}
                          inputMode="decimal"
                          value={amounts[selected.id] ?? ""}
                          onChange={(event) =>
                            changed(`amount-${selected.id}`) &&
                            setAmounts((current) => ({
                              ...current,
                              [selected.id]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <p id="cost-ledger-amount-help">
                        Affects this month only. Saving replaces the automatic
                        value with a manual amount. Clearing creates a blank
                        manual override; it does not restore automatic values.
                        Zero and signed credits are valid.
                      </p>
                      <Button
                        type="submit"
                        size="standard"
                        disabled={writeLocked}
                      >
                        {saving === `amount-${selected.id}`
                          ? "Saving…"
                          : "Save amount"}
                      </Button>
                    </form>
                  ) : (
                    <p>
                      {lineAmount(selected)}
                      {view.periodStatus === "closed"
                        ? ". Closed-month amounts are frozen."
                        : ""}
                    </p>
                  )}
                  {(!view.canEdit ||
                    view.periodStatus !== "open" ||
                    (selected.state !== "known" &&
                      selected.state !== "blank")) &&
                  amounts[selected.id] !== undefined &&
                  amounts[selected.id] !== moneyInput(selected.monthlyCents) ? (
                    <section
                      aria-label="Retained amount change"
                      className="cost-ledger-retained-amount"
                    >
                      <p>
                        This amount change cannot be saved in the current line
                        or month state. Other drafts remain.
                      </p>
                      <dl>
                        <div>
                          <dt>Draft amount</dt>
                          <dd>
                            {amounts[selected.id].trim() === ""
                              ? "Blank"
                              : `${amounts[selected.id]} USD`}
                          </dd>
                        </div>
                        <div>
                          <dt>Saved amount</dt>
                          <dd>
                            {selected.monthlyCents === null
                              ? "Blank"
                              : `${moneyInput(selected.monthlyCents)} USD`}
                          </dd>
                        </div>
                      </dl>
                      <Button
                        type="button"
                        size="standard"
                        variant="secondary"
                        disabled={writeLocked}
                        onClick={(event) => {
                          if (!changed(`amount-${selected.id}`)) return;
                          event.currentTarget
                            .closest(".cost-ledger-inspector")
                            ?.querySelector<HTMLButtonElement>(
                              'button[aria-label="Close details"]',
                            )
                            ?.focus();
                          setAmounts((current) => ({
                            ...current,
                            [selected.id]: moneyInput(selected.monthlyCents),
                          }));
                        }}
                      >
                        Discard amount change
                      </Button>
                    </section>
                  ) : null}
                </section>
                <section className="cost-ledger-detail-section">
                  <h3>Standing line</h3>
                  {view.canEdit ? (
                    <LineEditor
                      line={selected}
                      draft={lines[selected.id] ?? lineDraft(selected)}
                      onChange={(draft) =>
                        changed(`line-${selected.id}`) &&
                        setLines((current) => ({
                          ...current,
                          [selected.id]: draft,
                        }))
                      }
                      onSave={() => saveLine(selected)}
                      onCancel={() => {
                        changed(`line-${selected.id}`) &&
                          setLines((current) => ({
                            ...current,
                            [selected.id]: lineDraft(selected),
                          }));
                        setSelectedLine(null);
                      }}
                      saving={writeLocked}
                      savingThis={saving === `line-${selected.id}`}
                    />
                  ) : (
                    <p>{selected.notes || "No notes recorded."}</p>
                  )}
                </section>
                <section className="cost-ledger-detail-section">
                  <h3>Source facts</h3>
                  <dl className="cost-ledger-facts">
                    <div>
                      <dt>Amount source</dt>
                      <dd>
                        {selected.source === "auto" ? "Automatic" : "Manual"}
                      </dd>
                    </div>
                    <div>
                      <dt>Line freshness</dt>
                      <dd>{freshness(selected)}</dd>
                    </div>
                    <div>
                      <dt>Category</dt>
                      <dd>{breakdownLabel(selected.category)}</dd>
                    </div>
                    <div>
                      <dt>Project</dt>
                      <dd>{breakdownLabel(selected.project)}</dd>
                    </div>
                    <div>
                      <dt>Vendor</dt>
                      <dd>{selected.vendor || "Not recorded"}</dd>
                    </div>
                    <div>
                      <dt>Standing amount</dt>
                      <dd>
                        {money(selected.standingCents)} · {selected.cadence}
                      </dd>
                    </div>
                    <div>
                      <dt>Included state</dt>
                      <dd>
                        {
                          {
                            known: "Known",
                            blank: "Blank",
                            inactive: "Inactive",
                            absent: "Not included",
                          }[selected.state]
                        }
                      </dd>
                    </div>
                  </dl>
                </section>
              </>
            ) : (
              <>
                <p>
                  Known amounts only. These totals use saved values; local
                  drafts are excluded.
                </p>
                <Breakdown
                  heading="By category"
                  values={view.byCategory}
                  knownKeys={view.lines
                    .filter((line) => line.state === "known")
                    .map((line) => line.category)}
                />
                <Breakdown
                  heading="By project"
                  values={view.byProject}
                  knownKeys={view.lines
                    .filter((line) => line.state === "known")
                    .map((line) => line.project)}
                />
              </>
            )}
          </Inspector>
        </div>
      </section>
      <section
        id="cost-panel-history"
        role="tabpanel"
        aria-labelledby="cost-task-tab-history"
        hidden={task !== "history"}
      >
        {task === "history" ? (
          <CostHistory
            view={view}
            busy={writeLocked}
            onPeriod={(period) =>
              requestExit(() => {
                discardDrafts();
                void refresh(period);
                setTask("ledger");
              })
            }
          />
        ) : null}
      </section>
      <section
        id="cost-panel-references"
        role="tabpanel"
        aria-labelledby="cost-task-tab-references"
        hidden={task !== "references"}
      >
        {task === "references" ? (
          <CostReferencePanel
            view={view}
            drafts={comparisons}
            busy={writeLocked}
            savingKey={saving}
            notice={monthReview ? null : recoveryNotice}
            errorHeading={errorHeading}
            onRetryLoad={errorKind !== "save" ? retryRead : undefined}
            error={reloadRequired || monthReview ? null : saveError}
            errorReferenceId={
              errorKind !== "save" ||
              (errorScope !== "batch" && errorScope !== "reference")
                ? null
                : errorScope === "reference"
                  ? errorIdentity
                  : undefined
            }
            onChange={(draft) =>
              changed(`comparison-${draft.id}`) &&
              setComparisons((current) => ({ ...current, [draft.id]: draft }))
            }
            onSave={saveComparison}
          />
        ) : null}
      </section>
      <section
        id="cost-panel-hardware"
        role="tabpanel"
        aria-labelledby="cost-task-tab-hardware"
        hidden={task !== "hardware"}
      >
        {task === "hardware" ? (
          <CostHardwarePanel
            view={view}
            drafts={hardware}
            busy={writeLocked}
            savingKey={saving}
            notice={monthReview ? null : recoveryNotice}
            errorHeading={errorHeading}
            onRetryLoad={errorKind !== "save" ? retryRead : undefined}
            error={reloadRequired || monthReview ? null : saveError}
            errorInDetails={errorScope === "hardware" || errorScope === "batch"}
            reloadStatus={
              hardwareReloaded
                ? "Hardware assumptions reloaded. Other drafts were kept."
                : null
            }
            onChange={(draft) => {
              if (!changed("hardware")) return;
              setHardwareReloaded(false);
              setHardware((current) =>
                current.map((row) => (row.id === draft.id ? draft : row)),
              );
            }}
            onSave={saveHardware}
            onReloadHardware={
              hardwareNeedsReload
                ? () => {
                    if (saveLock.current || reloadRequiredRef.current) return;
                    void refresh(view.period, undefined, true);
                  }
                : undefined
            }
            parse={parseHardwareDraft}
          />
        ) : null}
      </section>
    </div>
  );
}

function LineEditor({
  line,
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  savingThis,
}: {
  line: LedgerLine;
  draft: LineDraft;
  onChange: (draft: LineDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  savingThis: boolean;
}) {
  return (
    <div className="cost-ledger-comparison-edit">
      <form
        aria-label={`${line.label} standing line`}
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <fieldset disabled={saving}>
          {(["category", "project"] as const).map((field) => (
            <label key={field}>
              {field === "category" ? "Category" : "Project"}
              <select
                aria-label={`${line.label} ${field}`}
                className="field-control"
                value={draft[field]}
                onChange={(event) =>
                  onChange({ ...draft, [field]: event.target.value })
                }
              >
                {(field === "category"
                  ? ["cloud", "ai", "saas", "hardware"]
                  : ["cms", "spotlight", "hosting", "tooling"]
                ).map((value) => (
                  <option key={value} value={value}>
                    {breakdownLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            Vendor
            <TextInput
              aria-label={`${line.label} vendor`}
              maxLength={80}
              value={draft.vendor}
              onChange={(event) =>
                onChange({ ...draft, vendor: event.target.value })
              }
            />
          </label>
          <label>
            Notes
            <Textarea
              rows={4}
              aria-label={`${line.label} notes`}
              maxLength={500}
              value={draft.notes}
              onChange={(event) =>
                onChange({ ...draft, notes: event.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              aria-label={`${line.label} active`}
              aria-describedby={`line-${line.id}-active-help`}
              checked={draft.enabled}
              onChange={(event) =>
                onChange({ ...draft, enabled: event.target.checked })
              }
            />
            Active
          </label>
          <p id={`line-${line.id}-active-help`}>
            An inactive line is not counted in open months and does not block
            month close. Closed-month amounts stay unchanged.
          </p>
          <Button type="submit" size="standard">
            {savingThis ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="standard"
            variant="ghost"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </fieldset>
      </form>
    </div>
  );
}

function TotalCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Panel className="cost-ledger-total">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </Panel>
  );
}

function Breakdown({
  heading,
  values,
  knownKeys,
}: {
  heading: string;
  values: Record<string, number>;
  knownKeys: string[];
}) {
  return (
    <Panel className="cost-ledger-breakdown">
      <h4>{heading}</h4>
      <dl>
        {Object.entries(values).map(([label, cents]) => (
          <div key={label}>
            <dt>{breakdownLabel(label)}</dt>
            <dd>{knownKeys.includes(label) ? money(cents) : "No amounts"}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function breakdownLabel(label: string): string {
  const labels: Record<string, string> = {
    ai: "AI",
    cloud: "Cloud",
    cms: "CMS",
    hardware: "Hardware",
    hosting: "Hosting",
    saas: "Third-party services",
    spotlight: "Spotlight",
    tooling: "Tooling",
  };
  return labels[label] ?? label;
}

function CostLedgerSkeleton() {
  return (
    <div className="cost-ledger">
      <SkeletonRegion
        label="Loading cost ledger"
        className="cost-ledger-skeleton"
      >
        <div className="cost-ledger-intro">
          <SkeletonText width={92} />
          <SkeletonText width="48%" />
        </div>
        <SkeletonCardGrid
          card={
            <>
              <SkeletonText width="48%" />
              <SkeletonBlock height={38} width="70%" radius="small" />
              <SkeletonText width="74%" />
            </>
          }
          className="cost-ledger-total-grid"
          count={3}
        />
        <div className="cost-ledger-skeleton-breakdowns">
          <SkeletonBlock height={150} radius="panel" />
          <SkeletonBlock height={150} radius="panel" />
        </div>
        <SkeletonTable
          className="cost-ledger-table-frame"
          columns={[
            { kind: "text" },
            { kind: "text" },
            { kind: "text" },
            { kind: "text" },
          ]}
          headings={["Snapshot", "Month", "Known monthly total", "Blank lines"]}
          label="Loading weekly trend"
          rows={4}
          tableClassName="cost-ledger-table"
        />
        <SkeletonTable
          className="cost-ledger-table-frame"
          columns={[
            { kind: "text", lines: 2 },
            { kind: "text" },
            { kind: "text" },
            { kind: "text" },
            { kind: "chip" },
            { kind: "text" },
          ]}
          headings={[
            "Line",
            "Category",
            "Project",
            "Amount",
            "Source",
            "Line freshness",
          ]}
          label="Loading cost lines"
          rows={6}
          tableClassName="cost-ledger-table cost-ledger-lines-table"
        />
        <SkeletonTable
          className="cost-ledger-table-frame"
          columns={[
            { kind: "text", lines: 2 },
            { kind: "text" },
            { kind: "text" },
            { kind: "text" },
            { kind: "text", lines: 2 },
          ]}
          headings={["Vendor and product", "Price", "Source", "Read", "Notes"]}
          label="Loading comparison rows"
          rows={5}
          tableClassName="cost-ledger-table cost-ledger-comparison-table"
        />
      </SkeletonRegion>
    </div>
  );
}

function ConnectedCostLedgerSurface() {
  const { getIdToken } = useAuth();
  const load = useCallback(
    (period?: string) =>
      getIdToken().then((token) =>
        cmsCostLedger<CostLedgerView>(token, {
          action: "view",
          ...(period ? { period } : {}),
        }),
      ),
    [getIdToken],
  );
  const mutate = useCallback(
    (request: CostLedgerMutation) =>
      getIdToken().then((token) => cmsCostLedger(token, request)),
    [getIdToken],
  );
  return <CostLedgerSurface load={load} mutate={mutate} />;
}

export function CostLedgerRoute() {
  return (
    <RequireCapability
      allowed={canManageSettings}
      notice="Costs aren't available for your account."
    >
      <style>{costLedgerStyles}</style>
      <ConnectedCostLedgerSurface />
    </RequireCapability>
  );
}
