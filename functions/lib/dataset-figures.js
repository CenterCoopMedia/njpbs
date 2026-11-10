// Generated from packages/content-core/src/data-figure.ts and dataset-figures.ts.
// Regenerate with: node scripts/generate-data-figure.mjs
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/dataset-figures.ts
var dataset_figures_exports = {};
__export(dataset_figures_exports, {
  createDatasetFigureResolver: () => createDatasetFigureResolver,
  isDatasetFigures: () => isDatasetFigures,
  renderDataFigure: () => renderDataFigure,
  resolveDatasetFigure: () => resolveDatasetFigure
});
module.exports = __toCommonJS(dataset_figures_exports);

// packages/content-core/src/datasets.ts
var MAX_DATASET_BYTES = 200 * 1024;
var DATASET_UNITS = ["percent", "percent_change", "percentage_points", "number", "jobs", "people", "usd", "usd_month", "usd_hour", "usd_billion", "cents_kwh", "inches", "fahrenheit"];
var DATASET_ADJUSTMENTS = ["seasonally_adjusted", "not_seasonally_adjusted", "not_applicable"];
var DATASET_GEOGRAPHIES = ["nation", "state", "county", "municipality", "metro"];
function validDatasetId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// packages/content-core/src/data-figure.ts
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields(value, fields2) {
  return Object.keys(value).every((key2) => fields2.includes(key2));
}
function isDraftId(value, complete) {
  return typeof value === "string" && (!complete && value === "" || validDatasetId(value));
}
function isDataFigureData(value, complete = false) {
  if (!isObject(value) || !hasOnlyFields(value, ["datasetId", "version", "display"]) || !isDraftId(value.datasetId, complete) || value.display !== "compact" && value.display !== "expanded" || !isObject(value.version)) return false;
  if (value.version.mode === "latestApproved") {
    return hasOnlyFields(value.version, ["mode"]);
  }
  if (value.version.mode === "pinned") {
    return hasOnlyFields(value.version, ["mode", "releaseId"]) && isDraftId(value.version.releaseId, complete);
  }
  return false;
}

// packages/content-core/src/exact-https-url.ts
function isExactHttpsUrl(value, maxLength = Number.POSITIVE_INFINITY) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value || /[\u0000-\u0020\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// packages/content-core/src/safe-href.ts
var HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// packages/content-core/src/data-figure-render.ts
var FAILURE_MARKUP = '<p class="cms-data-figure__message">This data figure is unavailable.</p>';
var CHART_WIDTH = 1e3;
var CHART_HEIGHT = 320;
var CHART_LEFT = 56;
var CHART_RIGHT = 976;
var CHART_TOP = 24;
var CHART_BOTTOM = 276;
function isObject2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields2(value, fields2) {
  return Object.keys(value).every((key2) => fields2.includes(key2));
}
function isText(value, limit, required = true) {
  return typeof value === "string" && value.length <= limit && (!required || Boolean(value.trim()));
}
function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function isTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function fitsReleaseLimit(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && new TextEncoder().encode(json).length <= MAX_DATASET_BYTES;
  } catch {
    return false;
  }
}
function isBoundedNumber(value, unit) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15 && (unit !== "percent" || value >= 0 && value <= 100);
}
function isPeriod(value) {
  return isObject2(value) && hasOnlyFields2(value, ["start", "end", "label"]) && isDate(value.start) && isDate(value.end) && value.start <= value.end && isText(value.label, 120);
}
function isGeography(value) {
  if (!isObject2(value) || !hasOnlyFields2(value, ["level", "code", "label"]) || typeof value.level !== "string" || !DATASET_GEOGRAPHIES.includes(value.level) || !isText(value.code, 32) || !isText(value.label, 240)) return false;
  const patterns = {
    nation: /^[A-Z]{2}$/,
    state: /^[A-Z]{2}$/,
    county: /^\d{5}$/,
    municipality: /^\d{10}$/,
    metro: /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/
  };
  return patterns[value.level].test(value.code);
}
function isSource(value) {
  return isObject2(value) && hasOnlyFields2(value, ["publisher", "title", "url", "seriesId"]) && isText(value.publisher, 300) && isText(value.title, 300) && isExactHttpsUrl(value.url, 2e3) && (value.seriesId === void 0 || isText(value.seriesId, 120, false));
}
function isComparator(value, release) {
  if (!isObject2(value) || !hasOnlyFields2(value, ["label", "unit", "value", "period", "geography", "adjustment", "source", "comparisonNote"]) || !isText(value.label, 300) || value.unit !== release.unit || !isBoundedNumber(value.value, value.unit) || !isPeriod(value.period) || !isGeography(value.geography) || !isSource(value.source) || typeof value.adjustment !== "string" || !DATASET_ADJUSTMENTS.includes(value.adjustment) || !isText(value.comparisonNote, 2e3, false)) return false;
  const primaryPeriod = release.period;
  const primaryGeography = release.geography;
  const mismatch = value.adjustment !== release.adjustment || value.geography.code !== primaryGeography.code || value.geography.level !== primaryGeography.level || value.period.start !== primaryPeriod.start || value.period.end !== primaryPeriod.end;
  return !mismatch || Boolean(value.comparisonNote.trim());
}
function isPoint(value, unit, previousPeriod) {
  if (!isObject2(value) || !hasOnlyFields2(value, ["period", "value", "missingReason"]) || !isDate(value.period) || value.period <= previousPeriod) return false;
  if (value.value === null) return isText(value.missingReason, 500);
  return isBoundedNumber(value.value, unit) && value.missingReason === void 0;
}
function isPublicRelease(value) {
  if (!isObject2(value) || !hasOnlyFields2(value, ["label", "unit", "value", "period", "geography", "adjustment", "points", "chartText", "methodNote", "comparators", "source", "releasedOn", "verifiedOn", "changeKind", "changeNote", "reuse"]) || !fitsReleaseLimit(value) || !isText(value.label, 300) || typeof value.unit !== "string" || !DATASET_UNITS.includes(value.unit) || !isBoundedNumber(value.value, value.unit) || !isPeriod(value.period) || !isGeography(value.geography) || typeof value.adjustment !== "string" || !DATASET_ADJUSTMENTS.includes(value.adjustment) || !isSource(value.source) || !isText(value.chartText, 2e3) || !isText(value.methodNote, 4e3) || !isDate(value.releasedOn) || !isDate(value.verifiedOn) || value.verifiedOn < value.releasedOn || value.changeKind !== "new_release" && value.changeKind !== "correction" || !isText(value.changeNote, 2e3, value.changeKind === "correction") || !Array.isArray(value.points) || value.points.length < 1 || value.points.length > 240 || !Array.isArray(value.comparators) || value.comparators.length > 3 || !isObject2(value.reuse) || !hasOnlyFields2(value.reuse, ["display", "exports", "note"]) || value.reuse.display !== "allowed" || typeof value.reuse.exports !== "string" || !["unknown", "allowed", "denied"].includes(value.reuse.exports) || !isText(value.reuse.note, 2e3, false)) return false;
  let previousPeriod = "";
  for (const point of value.points) {
    if (!isPoint(point, value.unit, previousPeriod)) return false;
    previousPeriod = point.period;
  }
  return value.comparators.every((comparator) => isComparator(comparator, value));
}
function isDatasetPublicProjection(value) {
  return isObject2(value) && hasOnlyFields2(value, ["datasetId", "releaseId", "revision", "digest", "approvedAt", "release"]) && validDatasetId(value.datasetId) && validDatasetId(value.releaseId) && Number.isSafeInteger(value.revision) && value.revision >= 1 && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest) && isTimestamp(value.approvedAt) && isPublicRelease(value.release);
}
function matchesBlock(data, projection) {
  return data.datasetId === projection.datasetId && (data.version.mode === "latestApproved" || data.version.releaseId === projection.releaseId);
}
function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 21,
    notation: value !== 0 && Math.abs(value) < 1e-6 ? "scientific" : "standard"
  }).format(value);
}
function formatDatasetValue(value, unit) {
  const number = formatNumber(value);
  switch (unit) {
    case "percent":
      return `${number}%`;
    case "percent_change":
      return `${number}% change`;
    case "percentage_points":
      return `${number} percentage points`;
    case "jobs":
      return `${number} jobs`;
    case "people":
      return `${number} people`;
    case "usd":
      return `$${number}`;
    case "usd_month":
      return `$${number} per month`;
    case "usd_hour":
      return `$${number} per hour`;
    case "usd_billion":
      return `$${number} billion`;
    case "cents_kwh":
      return `${number} cents per kWh`;
    case "inches":
      return `${number} inches`;
    case "fahrenheit":
      return `${number}\xB0F`;
    default:
      return number;
  }
}
function adjustmentLabel(value) {
  if (value === "seasonally_adjusted") return "Seasonally adjusted";
  if (value === "not_seasonally_adjusted") return "Not seasonally adjusted";
  return "No adjustment";
}
function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value));
}
function hasAnnualChartPeriods(release) {
  const annualEnd = /* @__PURE__ */ new Date(`${release.period.start}T00:00:00Z`);
  annualEnd.setUTCFullYear(annualEnd.getUTCFullYear() + 1);
  annualEnd.setUTCDate(annualEnd.getUTCDate() - 1);
  if (annualEnd.toISOString().slice(0, 10) !== release.period.end) return false;
  const dates = release.points.map((point) => point.period);
  return dates.every((date) => date.slice(5) === dates[0].slice(5)) && new Set(dates.map((date) => date.slice(0, 4))).size === dates.length;
}
function formatChartPeriod(value, annual) {
  if (annual) return value.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(/* @__PURE__ */ new Date(`${value}T00:00:00Z`));
}
function chartUnitLabel(unit) {
  switch (unit) {
    case "percent":
      return "Percent";
    case "percent_change":
      return "Percent change";
    case "percentage_points":
      return "Percentage points";
    case "jobs":
      return "Jobs";
    case "people":
      return "People";
    case "usd":
      return "U.S. dollars";
    case "usd_month":
      return "U.S. dollars per month";
    case "usd_hour":
      return "U.S. dollars per hour";
    case "usd_billion":
      return "Billions of U.S. dollars";
    case "cents_kwh":
      return "Cents per kWh";
    case "inches":
      return "Inches";
    case "fahrenheit":
      return "Degrees Fahrenheit";
    default:
      return "Value";
  }
}
function chartCoordinate(value, min, max, low, high) {
  const ratio = min === max ? 0.5 : (value - min) / (max - min);
  const coordinate = low + Math.max(0, Math.min(1, ratio)) * (high - low);
  return Number.isFinite(coordinate) ? Math.round(coordinate * 100) / 100 : (low + high) / 2;
}
function renderValueAxis(ids, min, max, hasValues, unit, baselineOnly = false) {
  let labels;
  if (!hasValues) labels = '<span class="cms-data-figure__point-label">Missing</span>';
  else if (baselineOnly) labels = `<span class="cms-data-figure__point-label"><span class="cms-data-figure__sr-only">Scale baseline: </span>${escapeHtml(formatDatasetValue(0, unit))}</span>`;
  else if (min === max) labels = `<span class="cms-data-figure__point-label"><span class="cms-data-figure__sr-only">Value: </span>${escapeHtml(formatDatasetValue(min, unit))}</span>`;
  else labels = `<span><span class="cms-data-figure__sr-only">Scale top: </span>${escapeHtml(formatDatasetValue(max, unit))}</span> <span><span class="cms-data-figure__sr-only">Scale bottom: </span>${escapeHtml(formatDatasetValue(min, unit))}</span>`;
  return `<p class="cms-data-figure__value-axis${baselineOnly ? " cms-data-figure__value-axis--baseline" : min === max ? " cms-data-figure__value-axis--single" : ""}" id="${ids.chartRange}">${labels}</p>`;
}
function renderChart(ids, release) {
  const observed = release.points.filter((point) => point.value !== null);
  const times = release.points.map((point) => (/* @__PURE__ */ new Date(`${point.period}T00:00:00Z`)).getTime());
  const values = observed.map((point) => point.value);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const absolute = ["number", "jobs", "people", "usd", "usd_month", "usd_hour", "usd_billion", "cents_kwh"].includes(release.unit);
  const domainValues = absolute ? [0, ...values] : values;
  const minValue = domainValues.length ? Math.min(...domainValues) : 0;
  const observedMax = domainValues.length ? Math.max(...domainValues) : 0;
  const baselineOnly = absolute && values.length > 0 && minValue === 0 && observedMax === 0;
  const maxValue = baselineOnly ? 1 : observedMax;
  const coordinates = release.points.map((point, index) => ({
    point,
    x: chartCoordinate(times[index], minTime, maxTime, CHART_LEFT, CHART_RIGHT),
    y: point.value === null ? null : chartCoordinate(point.value, minValue, maxValue, CHART_BOTTOM, CHART_TOP)
  }));
  const paths = [];
  let segment = [];
  const closeSegment = () => {
    if (segment.length > 1) {
      const d = segment.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
      paths.push(`<path class="cms-data-figure__series" d="${d}" />`);
    }
    segment = [];
  };
  for (const coordinate of coordinates) {
    if (coordinate.y === null) closeSegment();
    else segment.push({ x: coordinate.x, y: coordinate.y });
  }
  closeSegment();
  const points = coordinates.flatMap(({ x, y }) => y === null ? [] : [
    `<path class="cms-data-figure__point" d="M ${x} ${y} h 0" />`
  ]).join("");
  const valueAxis = renderValueAxis(ids, minValue, maxValue, values.length > 0, release.unit, baselineOnly);
  const firstPeriod = release.points[0].period;
  const lastPeriod = release.points[release.points.length - 1].period;
  const singlePeriod = firstPeriod === lastPeriod;
  const annual = hasAnnualChartPeriods(release);
  const axisLabels = `<p class="cms-data-figure__axis-labels${singlePeriod ? " cms-data-figure__axis-labels--single" : ""}" id="${ids.chartAxis}"><span class="cms-data-figure__axis-start">${escapeHtml(formatChartPeriod(firstPeriod, annual))}</span>${singlePeriod ? "" : `<span class="cms-data-figure__axis-end">${escapeHtml(formatChartPeriod(lastPeriod, annual))}</span>`}</p>`;
  return `<div class="cms-data-figure__chart"><p class="cms-data-figure__unit" id="${ids.chartUnit}">${escapeHtml(chartUnitLabel(release.unit))}</p><div class="cms-data-figure__plot">${valueAxis}<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-labelledby="${ids.chartTitle} ${ids.chartDescription}" aria-describedby="${ids.chartUnit} ${ids.chartRange} ${ids.chartAxis}"><title id="${ids.chartTitle}">${escapeHtml(release.label)} chart</title><desc id="${ids.chartDescription}">${escapeHtml(release.chartText)}</desc><path class="cms-data-figure__axis" d="M ${CHART_LEFT} ${CHART_TOP} V ${CHART_BOTTOM} H ${CHART_RIGHT}" />${paths.join("")}${points}</svg>${axisLabels}</div><p class="cms-data-figure__chart-text" id="${ids.chartText}">${escapeHtml(release.chartText)}</p></div>`;
}
function renderTable(release) {
  const rows = release.points.map((point) => {
    const value = point.value === null ? "Missing" : formatDatasetValue(point.value, release.unit);
    const note = point.value === null ? point.missingReason : "";
    return `<tr><th scope="row">${escapeHtml(formatDate(point.period))}</th><td>${escapeHtml(value)}</td><td>${escapeHtml(note ?? "")}</td></tr>`;
  }).join("");
  return `<div class="cms-data-figure__values"><p class="cms-data-figure__scroll-cue">Scroll sideways to see all columns.</p><div class="cms-data-figure__table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(release.label)} source values"><table><caption>Source values for ${escapeHtml(release.label)}</caption><thead><tr><th scope="col">Period</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function renderSource(source) {
  return `<a href="${escapeHtml(source.url)}">${escapeHtml(source.publisher)}, ${escapeHtml(source.title)}</a>`;
}
function renderComparators(release) {
  if (!release.comparators.length) return "";
  const comparators = release.comparators.map(
    (comparator) => `<section class="cms-data-figure__comparison"><p class="cms-data-figure__subheading">${escapeHtml(comparator.label)}</p><dl><div><dt>Value</dt><dd>${escapeHtml(formatDatasetValue(comparator.value, comparator.unit))}</dd></div><div><dt>Period</dt><dd>${escapeHtml(comparator.period.label)}</dd></div><div><dt>Geography</dt><dd>${escapeHtml(comparator.geography.label)}</dd></div><div><dt>Adjustment</dt><dd>${escapeHtml(adjustmentLabel(comparator.adjustment))}</dd></div></dl><p>${escapeHtml(comparator.comparisonNote)}</p><p><strong>Comparison source:</strong> ${renderSource(comparator.source)}</p></section>`
  ).join("");
  return `<section class="cms-data-figure__comparisons" aria-label="Reviewed comparison context"><p class="cms-data-figure__subheading">Comparison context</p>${comparators}</section>`;
}
function figureIds(blockId) {
  const prefix = `data-figure-${blockId}`;
  return {
    chartTitle: `${prefix}-chart-title`,
    chartDescription: `${prefix}-chart-description`,
    chartAxis: `${prefix}-chart-axis`,
    chartUnit: `${prefix}-chart-unit`,
    chartRange: `${prefix}-chart-range`,
    chartText: `${prefix}-chart-text`,
    disclosure: `${prefix}-details`
  };
}
function renderDisclosure(ids, release, chart, compact) {
  const summary = compact ? "View chart, source values and method" : "View source values and method";
  return `<details class="cms-data-figure__details" id="${ids.disclosure}"><summary>${summary}</summary>${compact ? chart : ""}${renderTable(release)}<section class="cms-data-figure__method" aria-label="Method and source notes"><p class="cms-data-figure__subheading">Method and source notes</p><p>${escapeHtml(release.methodNote)}</p>${renderComparators(release)}</section></details>`;
}
function renderDataFigure(blockId, data, projection, headingLevel = 2) {
  if (!validDatasetId(blockId) || !isDataFigureData(data, true) || !isDatasetPublicProjection(projection) || !matchesBlock(data, projection)) return FAILURE_MARKUP;
  const release = projection.release;
  const ids = figureIds(blockId);
  const heading = Number.isInteger(headingLevel) && headingLevel >= 2 && headingLevel <= 6 ? headingLevel : 2;
  const chart = renderChart(ids, release);
  const compact = data.display === "compact";
  const correction = release.changeKind === "correction" ? `<span>Corrected ${escapeHtml(formatDate(projection.approvedAt))}: ${escapeHtml(release.changeNote)}</span>` : "";
  const creditNote = release.reuse.note.trim();
  const creditLabel = /^credits?\b/i.test(creditNote) ? "" : "<strong>Credit:</strong> ";
  const credit = creditNote ? `<p class="cms-data-figure__credit">${creditLabel}${escapeHtml(creditNote)}</p>` : "";
  return `<figure class="cms-data-figure cms-data-figure--${data.display}" data-dataset-id="${escapeHtml(projection.datasetId)}" data-release-id="${escapeHtml(projection.releaseId)}"><h${heading}>${escapeHtml(release.label)}</h${heading}><p class="cms-data-figure__value">${escapeHtml(formatDatasetValue(release.value, release.unit))}</p><p class="cms-data-figure__context"><span>${escapeHtml(release.period.label)}</span><span>${escapeHtml(release.geography.label)}</span><span>${escapeHtml(adjustmentLabel(release.adjustment))}</span></p>${compact ? "" : chart}${renderDisclosure(ids, release, chart, compact)}<figcaption><p class="cms-data-figure__source"><strong>Source:</strong> ${renderSource(release.source)}</p><p class="cms-data-figure__dates"><span>Released ${escapeHtml(formatDate(release.releasedOn))}</span><span>Verified ${escapeHtml(formatDate(release.verifiedOn))}</span><span>Revision ${projection.revision}</span>${correction}</p>${credit}</figcaption></figure>`;
}

// packages/content-core/src/dataset-figures.ts
var key = (release) => `${release.datasetId}/${release.releaseId}/${release.revision}/${release.digest}`;
function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fields(value, allowed) {
  return Object.keys(value).every((field) => allowed.includes(field));
}
function isDatasetFigures(value) {
  if (!object(value) || !fields(value, ["figures", "releases"]) || !Array.isArray(value.figures) || value.figures.length > 200 || !Array.isArray(value.releases) || value.releases.length > 200) return false;
  const releases = /* @__PURE__ */ new Set();
  for (const release of value.releases) {
    if (!isDatasetPublicProjection(release) || releases.has(key(release))) return false;
    releases.add(key(release));
  }
  const blocks = /* @__PURE__ */ new Set();
  const used = /* @__PURE__ */ new Set();
  for (const binding of value.figures) {
    if (!object(binding) || !validDatasetId(binding.blockId) || !validDatasetId(binding.datasetId) || blocks.has(binding.blockId)) return false;
    blocks.add(binding.blockId);
    if (binding.withdrawn === true) {
      if (!fields(binding, ["blockId", "datasetId", "withdrawn"])) return false;
      continue;
    }
    if (!fields(binding, ["blockId", "datasetId", "releaseId", "revision", "digest"]) || !validDatasetId(binding.releaseId) || !Number.isSafeInteger(binding.revision) || Number(binding.revision) < 1 || typeof binding.digest !== "string" || !/^[a-f0-9]{64}$/.test(binding.digest)) return false;
    const identity = `${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`;
    if (!releases.has(identity)) return false;
    used.add(identity);
  }
  return used.size === releases.size;
}
function createDatasetFigureResolver(figures) {
  if (!isDatasetFigures(figures)) return () => null;
  const bindings = new Map(figures.figures.map((binding) => [binding.blockId, binding]));
  const releases = new Map(figures.releases.map((release) => [key(release), release]));
  return (blockId, data) => {
    if (!isDataFigureData(data, true)) return null;
    const binding = bindings.get(blockId);
    if (!binding || binding.datasetId !== data.datasetId || "withdrawn" in binding || data.version.mode === "pinned" && binding.releaseId !== data.version.releaseId) return null;
    return releases.get(`${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`) ?? null;
  };
}
function resolveDatasetFigure(figures, blockId, data) {
  return createDatasetFigureResolver(figures)(blockId, data);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createDatasetFigureResolver,
  isDatasetFigures,
  renderDataFigure,
  resolveDatasetFigure
});
