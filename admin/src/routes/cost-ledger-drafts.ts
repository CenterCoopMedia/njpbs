export type LedgerLine = {
  id: string;
  label: string;
  category: string;
  project: string;
  source: "auto" | "manual";
  cadence: "monthly" | "annual";
  monthlyCents: number | null;
  standingCents: number | null;
  vendor: string;
  notes: string;
  enabled: boolean;
  freshnessStatus: string;
  freshnessAt: string | null;
  state: "known" | "blank" | "inactive" | "absent";
};

export type LedgerComparison = {
  id: string;
  vendor: string;
  product: string;
  status: "published" | "quote-required";
  priceLabel: string;
  monthlyCents: number | null;
  annualCents: number | null;
  rangeNote: string;
  sourceUrl: string;
  sourceReadOn: string;
  excludes: string;
  notes: string;
};

export type HardwareMachine = {
  id: string;
  label: string;
  purchaseCents: number | null;
  lifeMonths: number | null;
  watts: number | null;
  hoursPerMonth: number | null;
  centsPerKwh: number | null;
  internetShareCents: number | null;
};

export type CostLedgerView = {
  success: true;
  canEdit: boolean;
  currency: "USD";
  currentPeriod?: string;
  period: string;
  periodStatus: "open" | "closed";
  monthlyCents: number;
  annualRunRateCents: number;
  yearToDateCents: number;
  yearToDateMonths: number;
  blankLineCount: number;
  knownLineCount: number;
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  lines: LedgerLine[];
  comparisons: LedgerComparison[];
  snapshots: Array<{
    id: string;
    period: string;
    takenAt: string;
    monthlyCents: number;
    annualRunRateCents: number;
    blankLineCount: number;
  }>;
  periods: Array<{ id: string; status: "open" | "closed" }>;
  hardware: { machines: HardwareMachine[] };
  csv: string;
};

export type CostLedgerMutation =
  | { action: "seed" }
  | {
      action: "saveLine";
      line: LineDraft & {
        id: string;
        label: string;
        cadence: LedgerLine["cadence"];
        amountCents: number | null;
      };
    }
  | {
      action: "savePeriodAmount";
      lineId: string;
      period: string;
      amountCents: number | null;
    }
  | { action: "saveHardware"; hardware: { machines: HardwareMachine[] } }
  | { action: "saveComparison"; comparison: LedgerComparison }
  | { action: "closeMonth"; period: string }
  | { action: "reopenMonth"; period: string };

export interface CostLedgerTransport {
  load: (period?: string) => Promise<CostLedgerView>;
  mutate: (request: CostLedgerMutation) => Promise<unknown>;
}

export type LoadState =
  | { status: "loading" }
  | { status: "ready"; view: CostLedgerView }
  | { status: "error"; message: string; period?: string };

export type HardwareDraft = Pick<HardwareMachine, "id" | "label"> & {
  purchaseCost: string;
  lifeMonths: string;
  watts: string;
  hoursPerMonth: string;
  centsPerKwh: string;
  internetShare: string;
};

export type ComparisonDraft = Omit<
  LedgerComparison,
  "monthlyCents" | "annualCents"
> & {
  monthlyAmount: string;
  annualAmount: string;
};

export type LineDraft = Pick<
  LedgerLine,
  "category" | "project" | "vendor" | "notes" | "enabled"
>;

export function lineDraft(line: LedgerLine): LineDraft {
  const { category, project, vendor, notes, enabled } = line;
  return { category, project, vendor, notes, enabled };
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "Blank";
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString("en-US");
  return `${negative ? "-" : ""}$${dollars}.${String(absolute % 100).padStart(2, "0")}`;
}

export function moneyInput(cents: number | null): string {
  if (cents === null) return "";
  const negative = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${negative}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export const MAX_CENTS = 100_000_000_000;

export function centsFromInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return undefined;
  const cents =
    Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return undefined;
  return match[1] === "-" ? -cents : cents;
}

export function whole(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const result = Number(trimmed);
  return Number.isSafeInteger(result) ? result : undefined;
}

export function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function freshnessLabel(
  status: string,
  at: string | null = null,
): string {
  if (status === "manual" && at) return "Freshness recorded";
  const labels: Record<string, string> = {
    disabled: "Pull off",
    blank: "No refresh record",
    fresh: "Freshness recorded",
    manual: "Not pulled",
    error: "Refresh error",
  };
  return labels[status] ?? status.replace(/-/g, " ");
}

export function freshness(line: LedgerLine): string {
  const status = freshnessLabel(line.freshnessStatus, line.freshnessAt);
  if (!line.freshnessAt) return status;
  return `${status} · ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(line.freshnessAt))}`;
}

export function lineAmount(line: LedgerLine): string {
  if (line.state === "inactive") return "Inactive";
  if (line.state === "absent") return "Not included";
  return money(line.monthlyCents);
}

export function hardwareDraft(machine: HardwareMachine): HardwareDraft {
  return {
    id: machine.id,
    label: machine.label,
    purchaseCost: moneyInput(machine.purchaseCents),
    lifeMonths: machine.lifeMonths === null ? "" : String(machine.lifeMonths),
    watts: machine.watts === null ? "" : String(machine.watts),
    hoursPerMonth:
      machine.hoursPerMonth === null ? "" : String(machine.hoursPerMonth),
    centsPerKwh:
      machine.centsPerKwh === null ? "" : String(machine.centsPerKwh),
    internetShare: moneyInput(machine.internetShareCents),
  };
}

export function comparisonDraft(row: LedgerComparison): ComparisonDraft {
  const { monthlyCents, annualCents, ...details } = row;
  return {
    ...details,
    monthlyAmount: moneyInput(monthlyCents),
    annualAmount: moneyInput(annualCents),
  };
}

export function sameDraft<T extends object>(
  draft: T | undefined,
  previous: T,
): boolean {
  return (
    draft !== undefined &&
    (Object.keys(previous) as Array<keyof T>).every(
      (key) => draft[key] === previous[key],
    )
  );
}

export function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function parseHardwareDraft(
  machine: HardwareDraft,
): HardwareMachine | null {
  const purchaseCents = centsFromInput(machine.purchaseCost),
    internetShareCents = centsFromInput(machine.internetShare);
  const lifeMonths = whole(machine.lifeMonths),
    watts = whole(machine.watts),
    hoursPerMonth = whole(machine.hoursPerMonth),
    centsPerKwh = whole(machine.centsPerKwh);
  if (
    [
      purchaseCents,
      internetShareCents,
      lifeMonths,
      watts,
      hoursPerMonth,
      centsPerKwh,
    ].some((value) => value === undefined)
  )
    return null;
  return {
    id: machine.id,
    label: machine.label,
    purchaseCents: purchaseCents!,
    internetShareCents: internetShareCents!,
    lifeMonths: lifeMonths!,
    watts: watts!,
    hoursPerMonth: hoursPerMonth!,
    centsPerKwh: centsPerKwh!,
  };
}

export function hardwareFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    purchaseCost: "Purchase cost ($)",
    purchaseCents: "Purchase cost ($)",
    lifeMonths: "Life (months)",
    watts: "Watts",
    hoursPerMonth: "Hours per month",
    centsPerKwh: "Cents per kWh",
    internetShare: "Internet share ($)",
    internetShareCents: "Internet share ($)",
  };
  return labels[field] ?? field;
}

const hardwareFields = [
  ["purchaseCost", "purchaseCents"],
  ["lifeMonths", "lifeMonths"],
  ["watts", "watts"],
  ["hoursPerMonth", "hoursPerMonth"],
  ["centsPerKwh", "centsPerKwh"],
  ["internetShare", "internetShareCents"],
] as const;

export function hardwareDraftParseError(machine: HardwareDraft): string {
  for (const [field] of hardwareFields) {
    const monetary = field === "purchaseCost" || field === "internetShare";
    const parsed = monetary
      ? centsFromInput(machine[field])
      : whole(machine[field]);
    if (parsed === undefined)
      return `${machine.label}: ${hardwareFieldLabel(field)} needs ${monetary ? "a dollar amount with at most two decimal places" : "a whole number"}.`;
  }
  return `${machine.label}: Check hardware inputs.`;
}

/** Refresh untouched fields without silently adopting a changed base for edited fields. */
export function rebaseHardwareDraft(
  draft: HardwareDraft,
  previous: HardwareMachine,
  latest: HardwareMachine,
  conflicts: Set<string>,
): HardwareDraft {
  const before = hardwareDraft(previous),
    fresh = hardwareDraft(latest),
    result = { ...fresh };
  for (const [field] of hardwareFields) {
    if (draft[field] === before[field]) continue;
    result[field] = draft[field];
    if (before[field] !== fresh[field] && draft[field] !== fresh[field])
      conflicts.add(`${draft.id}:${field}`);
  }
  return result;
}
export function hardwareConflictError(
  machines: HardwareMachine[],
  saved: HardwareMachine[],
  conflicts: ReadonlySet<string>,
): string | null {
  for (const machine of machines) {
    const current = saved.find((row) => row.id === machine.id);
    for (const [field, storedField] of hardwareFields)
      if (
        conflicts.has(`${machine.id}:${field}`) &&
        machine[storedField] !== current?.[storedField]
      )
        return `${machine.label}: ${hardwareFieldLabel(field)} changed while your draft was pending. Reload and reconcile before saving; your drafts are retained.`;
  }
  return null;
}
