import { validateHardwareInput } from "../../../packages/content-core/src/cost-hardware";
import {
  hardwareFieldLabel,
  centsFromInput,
  comparisonDraft,
  hardwareDraft,
  hardwareDraftParseError,
  hardwareConflictError,
  lineDraft,
  moneyInput,
  parseHardwareDraft,
  sameDraft,
  MAX_CENTS,
  type ComparisonDraft,
  type CostLedgerMutation,
  type CostLedgerView,
  type HardwareDraft,
  type HardwareMachine,
  type LineDraft,
} from "./cost-ledger-drafts";

export class HardwareConflictError extends Error {}

export interface CostDrafts {
  amounts: Record<string, string>;
  lines: Record<string, LineDraft>;
  hardware: HardwareDraft[];
  comparisons: Record<string, ComparisonDraft>;
}
export interface CostSaveOperation {
  key: string;
  label: string;
  generation: number;
  request: CostLedgerMutation;
}

function text(value: string, max: number, label: string, required = false) {
  if (value.trim().length > max || (required && !value.trim()))
    throw new Error(
      `${label} ${required && !value.trim() ? "is required" : "is too long"}.`,
    );
}
export function validateCostRequest(request: CostLedgerMutation) {
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 16 * 1024)
    throw new Error(
      "A cost request exceeds the server 16 KiB limit. No changes were sent.",
    );
  const id =
    request.action === "saveLine"
      ? request.line.id
      : request.action === "saveComparison"
        ? request.comparison.id
        : request.action === "savePeriodAmount"
          ? request.lineId
          : null;
  if (id !== null && !/^[a-z0-9-]{1,64}$/.test(id))
    throw new Error("The saved cost ID is invalid. Reload before saving.");
  if ("period" in request && !/^\d{4}-(0[1-9]|1[0-2])$/.test(request.period))
    throw new Error("The selected cost month is invalid.");

  if (request.action === "savePeriodAmount") {
    if (
      request.amountCents !== null &&
      (!Number.isSafeInteger(request.amountCents) ||
        Math.abs(request.amountCents) > MAX_CENTS)
    )
      throw new Error("Enter a dollar amount with at most two decimal places.");
  } else if (request.action === "saveLine") {
    const line = request.line;
    text(line.label, 120, "Label", true);
    text(line.vendor, 80, "Vendor");
    text(line.notes, 500, "Notes");
    if (
      !["cloud", "ai", "saas", "hardware"].includes(line.category) ||
      !["cms", "spotlight", "hosting", "tooling"].includes(line.project)
    )
      throw new Error("Choose a recognized category and project.");
    if (
      !["monthly", "annual"].includes(line.cadence) ||
      typeof line.enabled !== "boolean" ||
      (line.amountCents !== null &&
        (!Number.isSafeInteger(line.amountCents) ||
          Math.abs(line.amountCents) > MAX_CENTS))
    )
      throw new Error(
        "The saved standing line is invalid. Reload before saving.",
      );
  } else if (request.action === "saveComparison") {
    const row = request.comparison;
    text(row.vendor, 80, "Reference vendor", true);
    text(row.product, 120, "Reference product", true);
    text(row.priceLabel, 200, "Price label", true);
    text(row.rangeNote, 800, "Range note");
    text(row.notes, 500, "Reference notes");
    if (!["published", "quote-required"].includes(row.status))
      throw new Error("Choose a recognized reference status.");
    if (
      [row.monthlyCents, row.annualCents].some(
        (value) =>
          value !== null &&
          (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS),
      )
    )
      throw new Error("Reference amounts must be blank or non-negative cents.");
    if (!/^https:\/\/\S+$/.test(row.sourceUrl) || row.sourceUrl.length > 300)
      throw new Error("Source URL must be an https address.");
    const [year, month, day] = row.sourceReadOn.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.sourceReadOn) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== row.sourceReadOn
    )
      throw new Error("Source date must be a valid YYYY-MM-DD date.");
  } else if (request.action === "saveHardware") {
    const error = validateHardwareInput(request.hardware);
    if (error) throw new Error(error);
  }
}
/** Capture immutable scope values and edit generations before any asynchronous work. */
export function captureCostOperations(
  view: CostLedgerView,
  drafts: CostDrafts,
  generations: Record<string, number>,
  only?: string,
  conflicts: ReadonlySet<string> = new Set(),
): CostSaveOperation[] {
  if (!view.canEdit)
    throw new Error("The server does not permit edits to this ledger.");
  const result: CostSaveOperation[] = [];
  const add = (
    key: string,
    label: string,
    changed: boolean,
    request: () => CostLedgerMutation,
  ) => {
    if (only ? key !== only : !changed) return;
    try {
      const payload = request();
      validateCostRequest(payload);
      result.push({
        key,
        label,
        generation: generations[key] ?? 0,
        request: structuredClone(payload),
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "This draft could not be validated.";
      const ValidationError =
        error instanceof HardwareConflictError ? HardwareConflictError : Error;
      throw new ValidationError(`${label}: ${detail}`);
    }
  };
  for (const line of view.lines) {
    const value = drafts.amounts[line.id] ?? moneyInput(line.monthlyCents);
    add(
      `amount-${line.id}`,
      `${line.label} · ${view.period} amount`,
      value !== moneyInput(line.monthlyCents),
      () => {
        if (
          view.periodStatus !== "open" ||
          line.state === "inactive" ||
          line.state === "absent"
        )
          throw new Error(
            `${line.label} has no editable amount in this month.`,
          );
        const amount = centsFromInput(value);
        if (amount === undefined)
          throw new Error(
            "Enter a dollar amount with at most two decimal places.",
          );
        return {
          action: "savePeriodAmount",
          lineId: line.id,
          period: view.period,
          amountCents: amount,
        };
      },
    );
    const draft = drafts.lines[line.id] ?? lineDraft(line);
    add(
      `line-${line.id}`,
      `${line.label} · standing fields`,
      !sameDraft(draft, lineDraft(line)),
      () => ({
        action: "saveLine",
        line: {
          ...draft,
          id: line.id,
          label: line.label,
          cadence: line.cadence,
          amountCents: line.standingCents,
        },
      }),
    );
  }
  add(
    "hardware",
    "Hardware assumptions",
    view.hardware.machines.some(
      (machine) =>
        !sameDraft(
          drafts.hardware.find((row) => row.id === machine.id),
          hardwareDraft(machine),
        ),
    ),
    () => {
      const machines = drafts.hardware.map(parseHardwareDraft);
      const invalidIndex = machines.findIndex((row) => row === null);
      if (invalidIndex >= 0)
        throw new Error(hardwareDraftParseError(drafts.hardware[invalidIndex]));
      const conflict = hardwareConflictError(
        machines as HardwareMachine[],
        view.hardware.machines,
        conflicts,
      );
      if (conflict) throw new HardwareConflictError(conflict);
      return {
        action: "saveHardware",
        hardware: { machines: machines as HardwareMachine[] },
      };
    },
  );
  for (const row of view.comparisons) {
    const draft = drafts.comparisons[row.id] ?? comparisonDraft(row);
    add(
      `comparison-${row.id}`,
      `${row.product} · reference`,
      !sameDraft(draft, comparisonDraft(row)),
      () => {
        const { monthlyAmount, annualAmount, ...comparison } = draft;
        const monthlyCents =
            draft.status === "quote-required"
              ? null
              : centsFromInput(monthlyAmount),
          annualCents =
            draft.status === "quote-required"
              ? null
              : centsFromInput(annualAmount);
        if (monthlyCents === undefined || annualCents === undefined)
          throw new Error(
            "Enter comparison amounts with no more than two decimal places.",
          );
        return {
          action: "saveComparison",
          comparison: { ...comparison, monthlyCents, annualCents },
        };
      },
    );
  }
  return result;
}
export function mergeLatestHardware(
  operation: CostSaveOperation,
  baseline: CostLedgerView,
  latest: CostLedgerView,
): CostSaveOperation {
  if (operation.request.action !== "saveHardware") return operation;
  if (!latest.canEdit)
    throw new Error("The server no longer permits hardware edits.");
  const edited = operation.request.hardware.machines;
  const machines = latest.hardware.machines.map((machine) => {
    const prior = baseline.hardware.machines.find(
        (row) => row.id === machine.id,
      ),
      draft = edited.find((row) => row.id === machine.id);
    if (!prior || !draft)
      throw new HardwareConflictError(
        "The hardware fleet changed. Reload and reconcile before saving.",
      );
    const merged = { ...machine };
    for (const field of [
      "purchaseCents",
      "lifeMonths",
      "watts",
      "hoursPerMonth",
      "centsPerKwh",
      "internetShareCents",
    ] as const) {
      if (draft[field] === prior[field]) continue;
      if (machine[field] !== prior[field] && machine[field] !== draft[field])
        throw new HardwareConflictError(
          `${machine.label}: ${hardwareFieldLabel(field)} changed in the saved ledger. Reload and reconcile before saving; your drafts are unchanged.`,
        );
      merged[field] = draft[field];
    }
    return merged;
  });
  const request: CostLedgerMutation = {
    action: "saveHardware",
    hardware: { machines },
  };
  validateCostRequest(request);
  return { ...operation, request };
}
export function closeBlock(
  result: unknown,
): { reason: string; lineIds: string[] } | null {
  if (!result || typeof result !== "object" || !("blocked" in result))
    return null;
  const blocked = result.blocked;
  if (
    !blocked ||
    typeof blocked !== "object" ||
    !("reason" in blocked) ||
    typeof blocked.reason !== "string" ||
    !("lineIds" in blocked) ||
    !Array.isArray(blocked.lineIds) ||
    !blocked.lineIds.every((id) => typeof id === "string")
  )
    return null;
  return { reason: blocked.reason, lineIds: blocked.lineIds };
}
