"use strict";

const { hardwareMonthlyCents, validateHardwareInput } = require("./cost-hardware");

// Pure cost-ledger model. No Firestore, no network, and no credentials.
// Amounts are integer USD cents. Null means the amount was not entered.

const CATEGORIES = Object.freeze(["cloud", "ai", "saas", "hardware"]);
const PROJECTS = Object.freeze(["cms", "spotlight", "hosting", "tooling"]);
const SOURCES = Object.freeze(["auto", "manual"]);
const CADENCES = Object.freeze(["monthly", "annual"]);
const COMPARISON_STATUSES = Object.freeze(["published", "quote-required"]);
const FRESHNESS = Object.freeze(["manual", "disabled", "fresh", "error", "blank"]);
const MAX_CENTS = 100_000_000_000;
const TIME_ZONE = "America/New_York";

const SEED_LINES = Object.freeze([
  lineSeed("gcp-cloud", "Google Cloud and Firebase", "cloud", "cms", "auto", "Google"),
  lineSeed("cloudflare", "Cloudflare", "cloud", "hosting", "auto", "Cloudflare"),
  lineSeed("aws-s3", "AWS S3", "cloud", "cms", "auto", "Amazon Web Services"),
  lineSeed("aws-lightsail", "AWS Lightsail Spotlight staging", "cloud", "spotlight", "auto", "Amazon Web Services"),
  lineSeed("aws-other", "AWS other services", "cloud", "hosting", "auto", "Amazon Web Services"),
  lineSeed("github-actions", "GitHub Actions", "cloud", "tooling", "auto", "GitHub"),
  lineSeed("github-other", "GitHub other products", "cloud", "tooling", "auto", "GitHub"),
  lineSeed("domains", "Domain registrations", "cloud", "hosting", "manual", ""),
  lineSeed("claude", "Claude", "ai", "tooling", "manual", "Anthropic"),
  lineSeed("openai", "OpenAI and Codex", "ai", "tooling", "manual", "OpenAI"),
  lineSeed("grok", "Grok", "ai", "tooling", "manual", "xAI"),
  lineSeed("kimi", "Kimi", "ai", "tooling", "manual", "Moonshot"),
  lineSeed("elevenlabs", "ElevenLabs", "ai", "cms", "manual", "ElevenLabs"),
  lineSeed("mailchimp", "Mailchimp", "saas", "cms", "manual", "Intuit Mailchimp"),
  lineSeed("firecrawl", "Firecrawl", "saas", "tooling", "manual", "Firecrawl"),
  lineSeed("airtable", "Airtable", "saas", "tooling", "manual", "Airtable"),
  lineSeed("analytics", "Analytics", "saas", "cms", "manual", ""),
  lineSeed("hardware-node-services", "node-services", "hardware", "hosting", "manual", ""),
  lineSeed("hardware-node-compute", "node-compute", "hardware", "hosting", "manual", ""),
  lineSeed("hardware-node-gpu-a", "node-gpu-a", "hardware", "tooling", "manual", ""),
  lineSeed("hardware-node-gpu-b", "node-gpu-b", "hardware", "tooling", "manual", ""),
  lineSeed("hardware-node-offsite", "node-offsite", "hardware", "hosting", "manual", ""),
]);

const SEED_MACHINES = Object.freeze([
  { id: "node-services", label: "node-services" },
  { id: "node-compute", label: "node-compute" },
  { id: "node-gpu-a", label: "node-gpu-a" },
  { id: "node-gpu-b", label: "node-gpu-b" },
  { id: "node-offsite", label: "node-offsite" },
]);

const READ_ON = "2026-09-25";

const SEED_COMPARISONS = Object.freeze([
  comparisonSeed({
    id: "newspack",
    vendor: "Newspack",
    product: "Newspack",
    status: "published",
    priceLabel: "$750, $1,500, or $2,500 per month",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "Published tiers follow publisher annual revenue: under $300,000; $300,000 to $600,000; $600,000 to $1 million. Over $1 million, or more than one site, the page says contact us. Hosting and 200 GB are included. This row does not assign NJ PBS to a tier.",
    sourceUrl: "https://newspack.com/pricing/",
  }),
  comparisonSeed({
    id: "ghost-starter",
    vendor: "Ghost",
    product: "Ghost(Pro) Starter",
    status: "published",
    priceLabel: "$18 per month, billed yearly",
    monthlyCents: 1800,
    annualCents: 21600,
    rangeNote: "Card price on the initial audience shown on the pricing page, which lists 1,000 members. A larger audience changes the price and was not copied.",
    sourceUrl: "https://ghost.org/pricing/",
  }),
  comparisonSeed({
    id: "ghost-publisher",
    vendor: "Ghost",
    product: "Ghost(Pro) Publisher",
    status: "published",
    priceLabel: "$29 per month, billed yearly",
    monthlyCents: 2900,
    annualCents: 34800,
    rangeNote: "Card price on the initial audience shown on the pricing page, which lists 1,000 members. A larger audience changes the price and was not copied.",
    sourceUrl: "https://ghost.org/pricing/",
  }),
  comparisonSeed({
    id: "ghost-business",
    vendor: "Ghost",
    product: "Ghost(Pro) Business",
    status: "published",
    priceLabel: "$199 per month, billed yearly",
    monthlyCents: 19900,
    annualCents: 238800,
    rangeNote: "Card price on the initial audience shown on the pricing page, which lists 1,000 members. A larger audience changes the price and was not copied.",
    sourceUrl: "https://ghost.org/pricing/",
  }),
  comparisonSeed({
    id: "ghost-custom",
    vendor: "Ghost",
    product: "Ghost(Pro) Custom",
    status: "quote-required",
    priceLabel: "Custom",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "The pricing page lists a custom plan and does not publish a dollar amount.",
    sourceUrl: "https://ghost.org/pricing/",
  }),
  comparisonSeed({
    id: "wordpress-vip",
    vendor: "WordPress VIP",
    product: "WordPress VIP",
    status: "quote-required",
    priceLabel: "Quote required",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "The vendor pricing page publishes Standard, Enhanced, and Signature with no dollar amount. A 24 July 2026 Multidots article reports about $25,000 a year for Standard and about $60,000 to $500,000 or more above that (https://www.multidots.com/blog/wordpress-vip-pricing/). That article is not a vendor price.",
    sourceUrl: "https://wpvip.com/pricing/",
  }),
  comparisonSeed({
    id: "arc-xp",
    vendor: "Arc XP",
    product: "Arc XP",
    status: "quote-required",
    priceLabel: "Quote required",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "Arc XP publishes no platform price. Subscription examples in Arc docs are prices a publisher charges readers.",
    sourceUrl: "https://www.arcxp.com/",
  }),
  comparisonSeed({
    id: "brightspot",
    vendor: "Brightspot",
    product: "Brightspot",
    status: "quote-required",
    priceLabel: "Quote required",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "Brightspot's pricing page publishes no dollar amount.",
    sourceUrl: "https://www.brightspot.com/pricing",
  }),
  comparisonSeed({
    id: "blox",
    vendor: "BLOX Digital",
    product: "BLOX CMS",
    status: "quote-required",
    priceLabel: "Quote required",
    monthlyCents: null,
    annualCents: null,
    rangeNote: "BLOX Digital offers pricing through contact and publishes no platform price.",
    sourceUrl: "https://www.bloxdigital.com/",
  }),
]);

function lineSeed(id, label, category, project, source, vendor) {
  const notes = source === "auto"
    ? "Amount stays blank until the weekly pull for this source is enabled."
    : category === "hardware"
      ? "Amount stays blank until purchase, power, and internet assumptions are entered."
      : id === "analytics"
        ? "Enter a cost only if a paid analytics product is billed. GA4 alone is not a guessed amount."
        : id === "elevenlabs"
          ? "Tagged cms because the station uses ElevenLabs for transcription. Split the line if agent use should be separate."
          : "Amount stays blank until a super admin enters it.";
  return Object.freeze({
    id,
    label,
    category,
    project,
    source,
    cadence: "monthly",
    vendor,
    notes,
    autoKey: source === "auto" ? id : null,
  });
}

function comparisonSeed(row) {
  return Object.freeze({
    ...row,
    scope: "platform-and-hosting",
    sourceReadOn: READ_ON,
    excludes: "labor",
    notes: "Platform and hosting only.",
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value) {
  return typeof value === "string" && /^[a-z0-9-]{1,64}$/.test(value);
}

function validPeriod(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function centsOrNull(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Math.abs(value) > MAX_CENTS) {
    return undefined;
  }
  return value;
}

function usdToCents(value) {
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error("Amount is not a dollar value.");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = `${fraction}000`;
  const cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  const rounded = padded[2] >= "5" ? cents + 1 : cents;
  if (!Number.isSafeInteger(rounded) || rounded > MAX_CENTS) {
    throw new Error("Amount is out of range.");
  }
  return negative ? -rounded : rounded;
}

function formatUsdPlain(cents) {
  if (cents === null || cents === undefined) return "";
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function partValue(parts, type) {
  return parts.find((part) => part.type === type)?.value ?? null;
}

function zonedParts(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
}

function periodFor(date, timeZone = TIME_ZONE) {
  const parts = zonedParts(date, timeZone);
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  if (!year || !month) throw new Error("Period could not be resolved.");
  return `${year}-${month}`;
}

function dateKey(date, timeZone = TIME_ZONE) {
  const parts = zonedParts(date, timeZone);
  const year = partValue(parts, "year");
  const month = partValue(parts, "month");
  const day = partValue(parts, "day");
  if (!year || !month || !day) throw new Error("Date could not be resolved.");
  return `${year}-${month}-${day}`;
}

function shiftPeriod(period, deltaMonths) {
  if (!validPeriod(period)) throw new Error("Period must be YYYY-MM.");
  const index = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + deltaMonths;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function previousPeriod(period) {
  return shiftPeriod(period, -1);
}

function monthsThrough(period) {
  const year = period.slice(0, 4);
  const end = Number(period.slice(5, 7));
  const months = [];
  for (let month = 1; month <= end; month += 1) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

function emptyBreakdown() {
  return {
    byCategory: Object.fromEntries(CATEGORIES.map((category) => [category, 0])),
    byProject: Object.fromEntries(PROJECTS.map((project) => [project, 0])),
  };
}

function monthlyCentsFromStanding(line) {
  if (line.amountCents === null || line.amountCents === undefined) return null;
  if (line.cadence === "annual") return Math.round(line.amountCents / 12);
  return line.amountCents;
}

function lineState(line, entry, closed) {
  if (closed) {
    if (!entry) return { state: "absent" };
    if (entry.amountCents === null || entry.amountCents === undefined) return { state: "blank" };
    return { state: "known", cents: entry.amountCents };
  }
  if (line.enabled === false) return { state: "inactive" };
  if (entry) {
    if (entry.amountCents === null || entry.amountCents === undefined) return { state: "blank" };
    return { state: "known", cents: entry.amountCents };
  }
  const standing = monthlyCentsFromStanding(line);
  if (standing === null) return { state: "blank" };
  return { state: "known", cents: standing };
}

function rollupLines(lines, periodDoc) {
  const closed = periodDoc?.status === "closed";
  const entries = periodDoc?.entries && isPlainObject(periodDoc.entries) ? periodDoc.entries : {};
  const breakdown = emptyBreakdown();
  let monthlyCents = 0;
  let knownLineCount = 0;
  let blankLineCount = 0;
  const rows = [];
  for (const line of lines) {
    const state = lineState(line, entries[line.id], closed);
    rows.push({ ...presentationLine(line, entries[line.id]), state: state.state, monthlyCents: state.cents ?? null });
    if (state.state === "known") {
      monthlyCents += state.cents;
      knownLineCount += 1;
      breakdown.byCategory[line.category] += state.cents;
      breakdown.byProject[line.project] += state.cents;
    } else if (state.state === "blank") {
      blankLineCount += 1;
    }
  }
  return {
    monthlyCents,
    annualRunRateCents: monthlyCents * 12,
    knownLineCount,
    blankLineCount,
    ...breakdown,
    rows,
  };
}

function presentationLine(line, entry) {
  return {
    id: line.id,
    label: line.label,
    category: line.category,
    project: line.project,
    source: entry?.source || line.source,
    cadence: line.cadence,
    standingCents: line.amountCents ?? null,
    vendor: line.vendor,
    notes: line.notes,
    enabled: line.enabled !== false,
    freshnessStatus: line.freshnessStatus,
    freshnessAt: line.freshnessAt ?? null,
  };
}

function lineDocument(seed, nowIso, actorUid) {
  return {
    label: seed.label,
    category: seed.category,
    project: seed.project,
    source: seed.source,
    currency: "USD",
    cadence: seed.cadence,
    amountCents: null,
    vendor: seed.vendor,
    notes: seed.notes,
    enabled: true,
    autoKey: seed.autoKey,
    freshnessStatus: seed.source === "auto" ? "disabled" : "blank",
    freshnessAt: null,
    updatedAt: nowIso,
    updatedBy: actorUid,
  };
}

function comparisonDocument(seed, nowIso, actorUid) {
  return {
    vendor: seed.vendor,
    product: seed.product,
    scope: seed.scope,
    status: seed.status,
    priceLabel: seed.priceLabel,
    monthlyCents: seed.monthlyCents,
    annualCents: seed.annualCents,
    rangeNote: seed.rangeNote,
    sourceUrl: seed.sourceUrl,
    sourceReadOn: seed.sourceReadOn,
    excludes: seed.excludes,
    notes: seed.notes,
    updatedAt: nowIso,
    updatedBy: actorUid,
  };
}

function emptyMachine(machine) {
  return {
    id: machine.id,
    label: machine.label,
    purchaseCents: null,
    lifeMonths: null,
    watts: null,
    hoursPerMonth: null,
    centsPerKwh: null,
    internetShareCents: null,
  };
}

function hardwareDocument(nowIso, actorUid) {
  return {
    machines: SEED_MACHINES.map(emptyMachine),
    updatedAt: nowIso,
    updatedBy: actorUid,
  };
}

function boundedText(value, max, label) {
  if (typeof value !== "string") return `${label} must be text.`;
  const trimmed = value.trim();
  if (trimmed.length > max) return `${label} is too long.`;
  return null;
}

function validateLineInput(input, { creating }) {
  if (!isPlainObject(input)) return "Line must be an object.";
  if (!validId(input.id)) return "Line id must be lowercase letters, numbers, and hyphens.";
  const labelError = boundedText(input.label, 120, "Label");
  if (labelError) return labelError;
  if (input.label.trim() === "") return "Label is required.";
  if (!CATEGORIES.includes(input.category)) return "Category is not recognized.";
  if (!PROJECTS.includes(input.project)) return "Project is not recognized.";
  if (!CADENCES.includes(input.cadence)) return "Cadence is not recognized.";
  if (centsOrNull(input.amountCents) === undefined) return "Amount must be blank or a whole number of cents.";
  const vendorError = boundedText(input.vendor ?? "", 80, "Vendor");
  if (vendorError) return vendorError;
  const notesError = boundedText(input.notes ?? "", 500, "Notes");
  if (notesError) return notesError;
  if (typeof input.enabled !== "boolean") return "Enabled must be true or false.";
  if (input.source !== undefined && !SOURCES.includes(input.source)) {
    return "Source is not recognized.";
  }
  if (creating && input.source !== undefined && input.source !== "manual") {
    return "New lines are manual.";
  }
  return null;
}

function validateComparisonInput(input) {
  if (!isPlainObject(input) || !validId(input.id)) return "Comparison id is invalid.";
  const vendorError = boundedText(input.vendor, 80, "Vendor");
  if (vendorError || input.vendor.trim() === "") return vendorError || "Vendor is required.";
  const productError = boundedText(input.product, 120, "Product");
  if (productError || input.product.trim() === "") return productError || "Product is required.";
  if (!COMPARISON_STATUSES.includes(input.status)) return "Comparison status is not recognized.";
  const priceError = boundedText(input.priceLabel, 200, "Price label");
  if (priceError || input.priceLabel.trim() === "") return priceError || "Price label is required.";
  const monthlyCents = centsOrNull(input.monthlyCents);
  if (monthlyCents === undefined || monthlyCents < 0) return "Monthly amount must be blank or cents.";
  const annualCents = centsOrNull(input.annualCents);
  if (annualCents === undefined || annualCents < 0) return "Annual amount must be blank or cents.";
  const rangeError = boundedText(input.rangeNote ?? "", 800, "Range note");
  if (rangeError) return rangeError;
  if (typeof input.sourceUrl !== "string" || !/^https:\/\/\S+$/.test(input.sourceUrl) || input.sourceUrl.length > 300) {
    return "Source URL must be an https address.";
  }
  if (!validDate(input.sourceReadOn)) return "Source date must be YYYY-MM-DD.";
  const notesError = boundedText(input.notes ?? "", 500, "Notes");
  if (notesError) return notesError;
  return null;
}

function applyAutoEntries(periodDoc, period, updates, pulledAt) {
  if (periodDoc?.status === "closed") return { skipped: true, period: periodDoc };
  const entries = { ...(periodDoc?.entries || {}) };
  for (const update of updates) {
    const current = entries[update.lineId];
    if (current?.source === "manual") continue;
    entries[update.lineId] = {
      amountCents: update.amountCents,
      source: "auto",
      pulledAt,
      estimated: update.estimated === true,
    };
  }
  return {
    skipped: false,
    period: {
      period,
      status: "open",
      currency: "USD",
      entries,
      closedAt: null,
      closedBy: null,
      schedulerCloseBlockedAt: periodDoc?.schedulerCloseBlockedAt ?? null,
      updatedAt: pulledAt,
    },
  };
}

// The frozen month includes existing lines unless explicitly disabled.
function isPeriodLineEligible(line) {
  return Boolean(line) && line.enabled !== false;
}

function hasValidManualOverride(entry) {
  return entry?.source === "manual" && Number.isSafeInteger(entry.amountCents)
    && centsOrNull(entry.amountCents) !== undefined;
}

function freezePeriod(lines, periodDoc, period, actorUid, nowIso) {
  if (periodDoc?.status === "closed") return { changed: false, period: periodDoc };
  const entries = {};
  const prior = periodDoc?.entries || {};
  for (const line of lines) {
    if (!isPeriodLineEligible(line)) continue;
    const current = prior[line.id];
    const amountCents = current && current.amountCents !== undefined
      ? current.amountCents
      : monthlyCentsFromStanding(line);
    entries[line.id] = {
      amountCents,
      source: current?.source || line.source,
      pulledAt: current?.pulledAt ?? null,
    };
  }
  return {
    changed: true,
    period: {
      period,
      status: "closed",
      currency: "USD",
      entries,
      closedAt: nowIso,
      closedBy: actorUid,
      schedulerCloseBlockedAt: periodDoc?.schedulerCloseBlockedAt ?? null,
      updatedAt: nowIso,
    },
  };
}

function reopenPeriod(periodDoc, nowIso) {
  if (!periodDoc || periodDoc.status !== "closed") return { changed: false, period: periodDoc };
  return {
    changed: true,
    period: {
      ...periodDoc,
      status: "open",
      closedAt: null,
      closedBy: null,
      schedulerCloseBlockedAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

function snapshotDocument(period, rollup, nowIso) {
  return {
    period,
    takenAt: nowIso,
    monthlyCents: rollup.monthlyCents,
    annualRunRateCents: rollup.annualRunRateCents,
    blankLineCount: rollup.blankLineCount,
    knownLineCount: rollup.knownLineCount,
    byCategory: rollup.byCategory,
    byProject: rollup.byProject,
  };
}

function csvCell(value, numeric = false) {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = !numeric && /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

function buildCsv(view) {
  const header = [
    "type", "id", "label", "category", "project", "source", "cadence", "period",
    "status", "amount_usd", "freshness", "vendor", "source_url", "source_read_on", "notes",
  ];
  const rows = [header];
  for (const line of view.lines) {
    rows.push([
      "line", line.id, line.label, line.category, line.project, line.source, line.cadence,
      view.period, line.state, formatUsdPlain(line.monthlyCents), line.freshnessStatus,
      line.vendor, "", "", line.notes,
    ]);
  }
  rows.push([
    "total", "monthly", "Known monthly total", "", "", "", "", view.period, "",
    formatUsdPlain(view.monthlyCents), "", "", "", "", `${view.blankLineCount} lines have no amount`,
  ]);
  rows.push([
    "total", "annual-run-rate", "Known annual run rate", "", "", "", "", view.period, "",
    formatUsdPlain(view.annualRunRateCents), "", "", "", "", "Selected month times 12",
  ]);
  rows.push([
    "total", "year-to-date", "Known year to date", "", "", "", "", view.period.slice(0, 4), "",
    formatUsdPlain(view.yearToDateCents), "", "", "", "", `${view.yearToDateMonths} months`,
  ]);
  for (const row of view.comparisons) {
    rows.push([
      "comparison", row.id, row.product, "", "", "", "", "", row.status,
      formatUsdPlain(row.monthlyCents), "", row.vendor, row.sourceUrl, row.sourceReadOn, row.rangeNote,
    ]);
  }
  return rows.map((row) => row.map((value, index) => csvCell(value, index === 9)).join(",")).join("\n");
}

function buildView({ lines, periods, snapshots, comparisons, period }) {
  const periodDoc = periods.find((item) => item.id === period) || null;
  const selected = rollupLines(lines, periodDoc && periodDoc.status === "closed"
    ? periodDoc
    : { ...(periodDoc || {}), status: periodDoc?.status || "open", period });
  let yearToDateCents = 0;
  let yearToDateMonths = 0;
  for (const month of monthsThrough(period)) {
    const doc = periods.find((item) => item.id === month) || null;
    if (month !== period && !doc) continue;
    const rollup = month === period
      ? selected
      : rollupLines(lines, doc);
    yearToDateCents += rollup.monthlyCents;
    yearToDateMonths += 1;
  }
  const orderedSnapshots = [...snapshots].sort((left, right) => left.id < right.id ? 1 : -1).slice(0, 16);
  return {
    currency: "USD",
    period,
    periodStatus: periodDoc?.status || "open",
    monthlyCents: selected.monthlyCents,
    annualRunRateCents: selected.annualRunRateCents,
    blankLineCount: selected.blankLineCount,
    knownLineCount: selected.knownLineCount,
    byCategory: selected.byCategory,
    byProject: selected.byProject,
    yearToDateCents,
    yearToDateMonths,
    lines: selected.rows,
    comparisons: comparisons.map((row) => ({
      id: row.id,
      vendor: row.vendor,
      product: row.product,
      status: row.status,
      priceLabel: row.priceLabel,
      monthlyCents: row.monthlyCents ?? null,
      annualCents: row.annualCents ?? null,
      rangeNote: row.rangeNote,
      sourceUrl: row.sourceUrl,
      sourceReadOn: row.sourceReadOn,
      excludes: row.excludes,
      notes: row.notes,
    })),
    snapshots: orderedSnapshots.map((row) => ({
      id: row.id,
      period: row.period,
      takenAt: row.takenAt,
      monthlyCents: row.monthlyCents,
      annualRunRateCents: row.annualRunRateCents,
      blankLineCount: row.blankLineCount,
    })),
    periods: periods.map((item) => ({ id: item.id, status: item.status })).sort((left, right) => left.id < right.id ? -1 : 1),
  };
}

module.exports = {
  CATEGORIES,
  COMPARISON_STATUSES,
  FRESHNESS,
  MAX_CENTS,
  PROJECTS,
  SEED_COMPARISONS,
  SEED_LINES,
  SEED_MACHINES,
  TIME_ZONE,
  applyAutoEntries,
  buildCsv,
  buildView,
  centsOrNull,
  comparisonDocument,
  dateKey,
  formatUsdPlain,
  freezePeriod,
  hasValidManualOverride,
  isPeriodLineEligible,
  hardwareDocument,
  hardwareMonthlyCents,
  lineDocument,
  monthlyCentsFromStanding,
  periodFor,
  previousPeriod,
  reopenPeriod,
  rollupLines,
  shiftPeriod,
  snapshotDocument,
  usdToCents,
  validDate,
  validId,
  validPeriod,
  validateComparisonInput,
  validateHardwareInput,
  validateLineInput,
};
