import type { CostLedgerView } from "../routes/CostLedgerRoute";

const base: CostLedgerView = {
  success: true,
  canEdit: true,
  currency: "USD",
  currentPeriod: "2026-09",
  period: "2026-09",
  periodStatus: "open",
  monthlyCents: 163423,
  annualRunRateCents: 1961076,
  yearToDateCents: 1470807,
  yearToDateMonths: 9,
  blankLineCount: 1,
  knownLineCount: 3,
  byCategory: { cloud: 89423, ai: 74000, saas: 0, hardware: 0 },
  byProject: { cms: 89423, spotlight: 0, hosting: 0, tooling: 74000 },
  lines: [
    {
      id: "gcp",
      label: "Google Cloud Platform",
      category: "cloud",
      project: "cms",
      source: "auto",
      cadence: "monthly",
      monthlyCents: 89423,
      standingCents: null,
      vendor: "Google Cloud",
      notes: "The weekly pull updates this automatic line.",
      enabled: true,
      freshnessStatus: "fresh",
      freshnessAt: "2026-09-22T13:00:00.000Z",
      state: "known",
    },
    {
      id: "claude",
      label: "Claude",
      category: "ai",
      project: "tooling",
      source: "manual",
      cadence: "monthly",
      monthlyCents: 74000,
      standingCents: 74000,
      vendor: "Anthropic",
      notes: "A verified manual amount.",
      enabled: true,
      freshnessStatus: "manual",
      freshnessAt: null,
      state: "known",
    },
    {
      id: "domains",
      label: "Domain registrations",
      category: "cloud",
      project: "hosting",
      source: "manual",
      cadence: "annual",
      monthlyCents: null,
      standingCents: null,
      vendor: "Registrar",
      notes: "Blank stays separate from zero.",
      enabled: true,
      freshnessStatus: "blank",
      freshnessAt: null,
      state: "blank",
    },
    {
      id: "airtable",
      label: "Airtable",
      category: "saas",
      project: "spotlight",
      source: "manual",
      cadence: "monthly",
      monthlyCents: 0,
      standingCents: 0,
      vendor: "Airtable",
      notes: "A recorded zero is a real zero.",
      enabled: true,
      freshnessStatus: "manual",
      freshnessAt: null,
      state: "known",
    },
  ],
  comparisons: [
    {
      id: "ghost",
      vendor: "Ghost",
      product: "Ghost(Pro) Business",
      status: "published",
      priceLabel: "$199 per month",
      monthlyCents: 19900,
      annualCents: 238800,
      rangeNote: "Published list price.",
      sourceUrl: "https://ghost.org/pricing/",
      sourceReadOn: "2026-09-25",
      excludes: "labor",
      notes: "Hosting and CMS only.",
    },
    {
      id: "vip",
      vendor: "WordPress VIP",
      product: "WordPress VIP",
      status: "quote-required",
      priceLabel: "",
      monthlyCents: null,
      annualCents: null,
      rangeNote: "The vendor requires a quote.",
      sourceUrl: "https://wpvip.com/pricing/",
      sourceReadOn: "2026-09-25",
      excludes: "labor",
      notes: "Hosting and CMS only.",
    },
  ],
  snapshots: [
    {
      id: "2026-09-15",
      period: "2026-09",
      takenAt: "2026-09-15T13:00:00.000Z",
      monthlyCents: 158400,
      annualRunRateCents: 1900800,
      blankLineCount: 2,
    },
    {
      id: "2026-09-22",
      period: "2026-09",
      takenAt: "2026-09-22T13:00:00.000Z",
      monthlyCents: 163423,
      annualRunRateCents: 1961076,
      blankLineCount: 1,
    },
  ],
  periods: [
    { id: "2026-08", status: "closed" },
    { id: "2026-09", status: "open" },
  ],
  hardware: {
    machines: [
      "node-services",
      "node-compute",
      "node-gpu-a",
      "node-gpu-b",
      "node-offsite",
    ].map((id) => ({
      id,
      label: id,
      purchaseCents: 220000,
      lifeMonths: 48,
      watts: 300,
      hoursPerMonth: 120,
      centsPerKwh: 21,
      internetShareCents: 1200,
    })),
  },
  csv: "Period,Amount\n2026-09,1634.23\n",
};

// Sanitized local API response only. This entry is excluded from the production build.
export function costLedgerFixture(mode: string | null = null): CostLedgerView {
  const view = structuredClone(base);
  view.lines.push(
    ...Array.from({ length: 18 }, (_, index) => ({
      ...view.lines[index % 4],
      id: `fixture-${index}`,
      label:
        index === 0
          ? "Shared infrastructure with a long service name for readability checks"
          : `Sanitized service ${index + 1}`,
      notes: "A long sanitized billing note. ".repeat(12),
      monthlyCents:
        index < 3
          ? null
          : index === 3
            ? -12345
            : index === 4
              ? 987654
              : index * 125,
      state: (index < 3 ? "blank" : "known") as "blank" | "known",
    })),
  );
  view.lines[0].source = "manual";
  view.lines[0].freshnessStatus = "disabled";
  view.lines[view.lines.length - 1].state = "inactive";
  view.lines[view.lines.length - 1].monthlyCents = null;
  view.lines[view.lines.length - 1].enabled = false;
  view.canEdit = mode !== "readonly";
  if (mode === "manual-override" || mode === "manual-override-history") {
    view.lines[0].freshnessStatus = "manual";
    view.lines[0].freshnessAt = "2026-09-22T15:00:00.000Z";
  }
  if (mode === "manual-override-history") {
    view.period = "2026-08";
    view.periodStatus = "closed";
    view.lines[0].source = "auto";
    for (const line of view.lines) {
      if (line.state === "inactive") line.state = "absent";
    }
  }
  if (mode === "empty") {
    view.lines = [];
    view.hardware.machines = [];
    view.snapshots = [];
    view.comparisons = [];
  }
  if (mode === "closed") {
    view.periodStatus = "closed";
    view.periods = view.periods.map((period) => ({
      ...period,
      status: "closed",
    }));
    view.lines[1].state = "absent";
    view.lines[1].monthlyCents = null;
  }
  if (mode === "stress") {
    view.lines[7].monthlyCents = -123456789;
    view.lines[8].monthlyCents = 987654321;
  }
  // Fixed saved-response CSV fixtures, never derived from input drafts.
  const savedCsv: Record<string, string> = {
    default: "Period,Known total\n2026-09,11544.82\n",
    "manual-override-history": "Period,Known total\n2026-08,11544.82\n",
    closed: "Period,Known total\n2026-09,10804.82\n",
    empty: "Period,Known total\n2026-09,\n",
    stress: "Period,Known total\n2026-09,8643767.05\n",
  };
  view.csv = savedCsv[mode ?? "default"] ?? savedCsv.default;
  const known = view.lines.filter((line) => line.state === "known");
  view.monthlyCents = known.reduce((sum, line) => sum + line.monthlyCents!, 0);
  view.annualRunRateCents = view.monthlyCents * 12;
  view.yearToDateCents = view.monthlyCents;
  view.yearToDateMonths = mode === "empty" ? 0 : 1;
  view.knownLineCount = known.length;
  view.blankLineCount = view.lines.filter(
    (line) => line.state === "blank",
  ).length;
  for (const [field, totals] of [
    ["category", view.byCategory],
    ["project", view.byProject],
  ] as const) {
    for (const key of Object.keys(totals))
      totals[key] = known
        .filter((line) => line[field] === key)
        .reduce((sum, line) => sum + line.monthlyCents!, 0);
  }
  return view;
}
