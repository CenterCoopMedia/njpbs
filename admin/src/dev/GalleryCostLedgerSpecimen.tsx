import {
  CostLedgerSurface,
  type CostLedgerView,
} from "../routes/CostLedgerRoute";
import costLedgerStyles from "../routes/CostLedgerRoute.css?inline";

const COST_LEDGER_SPECIMEN: CostLedgerView = {
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

export function CostLedgerGallery({ loading = false }: { loading?: boolean }) {
  const load = loading
    ? () => new Promise<CostLedgerView>(() => {})
    : async () => COST_LEDGER_SPECIMEN;

  return (
    <>
      <style>{costLedgerStyles}</style>
      <CostLedgerSurface
        load={load}
        mutate={async () => ({ success: true })}
      />
    </>
  );
}
