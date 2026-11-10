/** Staff-owned associations for the compiled Data Hub; never figure data or markup. */
export const DATA_HUB_FIGURES = {
  unemployment: "Unemployment", industryjobs: "Industry jobs", propertytax: "Property taxes",
  precipitation: "Precipitation", minimumwage: "Minimum wage", electricity: "Electricity",
  medianrent: "Median rent", medianincome: "Median income", housingpermits: "Housing permits",
  voterregistration: "Voter registration", statebudget: "State budget", temperature: "Temperature",
  familycare: "NJ FamilyCare", uninsured: "Health insurance", inflationmetro: "Metro inflation",
  schoolabsence: "Chronic absenteeism", graduation: "Graduation", snap: "NJ SNAP",
} as const;
export type DataHubFigure = keyof typeof DATA_HUB_FIGURES;
export interface ReportingTerm { id: number; slug: string; label: string }
export interface ReportingIdentity { source: "posts" | "spotlight"; id: string; canonicalHref?: string }
export interface ReportingPin extends ReportingIdentity { note?: string }
export interface ReportingMapping {
  posts: { tags: string[]; categories: string[] };
  spotlight: { tags: ReportingTerm[]; categories: ReportingTerm[] };
  pins: ReportingPin[];
  hidden: ReportingIdentity[];
}
export interface DataHubReporting {
  schemaVersion: 1;
  figures: Partial<Record<DataHubFigure, ReportingMapping>>;
  featured: { inheritFigure: true } | { inheritFigure: false; mapping: ReportingMapping };
}
export const emptyReportingMapping = (): ReportingMapping => ({ posts: { tags: [], categories: [] },
  spotlight: { tags: [], categories: [] }, pins: [], hidden: [] });
export const emptyDataHubReporting = (): DataHubReporting => ({ schemaVersion: 1, figures: {}, featured: { inheritFigure: true } });
function fail(): never { throw new Error("Check the Data Hub reporting terms, story selections and limits."); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
}
export function reportingIdentity(value: unknown, pin = false): asserts value is ReportingIdentity {
  const keys = ["source", "id"];
  if (pin && value && typeof value === "object" && Object.hasOwn(value, "note")) keys.push("note");
  if (value && typeof value === "object" && Object.hasOwn(value, "canonicalHref")) keys.push("canonicalHref");
  object(value, keys);
  if (!["posts", "spotlight"].includes(String(value.source))) fail();
  if (typeof value.id !== "string" || (value.source === "posts" ? !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) : !/^[1-9]\d{0,14}$/.test(value.id))) fail();
  if (value.note !== undefined) text(value.note, 500);
  if (value.canonicalHref !== undefined && reportingStoryUrl(value.canonicalHref) === null) fail();
}
export const reportingIdentityKey = (value: ReportingIdentity) => `${value.source}:${value.id}`;
export function parseReportingMapping(value: unknown): ReportingMapping {
  object(value, ["posts", "spotlight", "pins", "hidden"]);
  for (const source of ["posts", "spotlight"] as const) {
    const terms = value[source]; object(terms, ["tags", "categories"]);
    for (const taxonomy of ["tags", "categories"] as const) {
      const list = terms[taxonomy]; if (!Array.isArray(list) || list.length > 5) fail();
      const keys = list.map(term => {
        if (source === "posts") { text(term, 200); if (/^format:/i.test(term)) fail(); return term; }
        object(term, ["id", "slug", "label"]);
        if (!Number.isSafeInteger(term.id) || Number(term.id) < 1) fail();
        text(term.slug, 200); text(term.label, 200);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(term.slug))) fail();
        return term.id;
      });
      if (new Set(keys).size !== keys.length) fail();
    }
  }
  for (const field of ["pins", "hidden"] as const) {
    const list = value[field]; if (!Array.isArray(list) || list.length > (field === "pins" ? 3 : 20)) fail();
    list.forEach(item => reportingIdentity(item, field === "pins"));
    if (new Set(list.map(reportingIdentityKey)).size !== list.length) fail();
  }
  const mapping = value as unknown as ReportingMapping;
  if (mapping.pins.some(pin => mapping.hidden.some(hidden => reportingIdentityKey(pin) === reportingIdentityKey(hidden)))) fail();
  return structuredClone(mapping);
}
export function parseDataHubReporting(value: unknown): DataHubReporting | undefined {
  if (value === undefined) return undefined;
  object(value, ["schemaVersion", "figures", "featured"]);
  if (value.schemaVersion !== 1 || !value.figures || typeof value.figures !== "object" || Array.isArray(value.figures)) fail();
  if (Object.keys(value.figures).some(key => !Object.hasOwn(DATA_HUB_FIGURES, key))) fail();
  for (const mapping of Object.values(value.figures)) parseReportingMapping(mapping);
  const featured = value.featured;
  object(featured, featured && typeof featured === "object" && (featured as { inheritFigure?: unknown }).inheritFigure === true ? ["inheritFigure"] : ["inheritFigure", "mapping"]);
  if (featured.inheritFigure !== true) {
    if (featured.inheritFigure !== false) fail();
    parseReportingMapping(featured.mapping);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) fail();
  return structuredClone(value) as unknown as DataHubReporting;
}

/** The origin identity also deduplicates an imported Boardwalk copy of a Spotlight story. */
export function reportingStoryUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f\u007f%]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "njpbs.org" && host !== "njspotlightnews.org") return null;
    if (host === "njpbs.org" ? !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)
      : !/^\/\d{4}\/\d{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)) return null;
    url.hostname = host === "njpbs.org" ? host : `www.${host}`;
    return url.href;
  } catch { return null; }
}
export interface ReportingStory extends ReportingIdentity {
  href: string; canonicalHref?: string; title: string; publishedAt: string;
  byline?: string; tags: (string | number)[]; categories: (string | number)[];
}
export interface SelectedReportingStory extends ReportingStory { note?: string; pinnedBy?: ReportingIdentity }
/** Candidates have already passed their source's public-visibility projection. */
export function selectReportingStories(mapping: ReportingMapping, candidates: readonly ReportingStory[], now: number): SelectedReportingStory[] {
  parseReportingMapping(mapping);
  const matches = (story: ReportingStory) => {
    const terms = mapping[story.source];
    return (["tags", "categories"] as const).some(kind => terms[kind].some(term =>
      story[kind].includes(typeof term === "string" ? term : term.id)));
  };
  const canonical = (story: ReportingStory) => reportingStoryUrl(story.canonicalHref) ?? reportingStoryUrl(story.href)!;
  const hiddenUrls = new Set(mapping.hidden.flatMap(hidden => {
    const href = reportingStoryUrl(hidden.canonicalHref) ?? candidates.find(story => reportingIdentityKey(story) === reportingIdentityKey(hidden))?.canonicalHref ??
      candidates.find(story => reportingIdentityKey(story) === reportingIdentityKey(hidden))?.href;
    return href ? [reportingStoryUrl(href)] : [];
  }));
  const available = candidates.filter(story => reportingStoryUrl(story.href) && story.title.trim() && story.title.length <= 300 &&
    Number.isFinite(Date.parse(story.publishedAt)) && Date.parse(story.publishedAt) <= now &&
    !hiddenUrls.has(canonical(story)) && !mapping.hidden.some(hidden => reportingIdentityKey(hidden) === reportingIdentityKey(story)));
  const pins = mapping.pins.flatMap(pin => {
    const pinUrl = reportingStoryUrl(pin.canonicalHref) ?? candidates.find(story => reportingIdentityKey(story) === reportingIdentityKey(pin))?.canonicalHref ??
      candidates.find(story => reportingIdentityKey(story) === reportingIdentityKey(pin))?.href;
    const story = available.find(story => reportingIdentityKey(story) === reportingIdentityKey(pin) || pinUrl && canonical(story) === reportingStoryUrl(pinUrl));
    return story ? [{ ...story, pinnedBy: pin, ...(pin.note ? { note: pin.note } : {}) }] : [];
  });
  const automatic = available.filter(matches).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || reportingIdentityKey(a).localeCompare(reportingIdentityKey(b)));
  const eligible: SelectedReportingStory[] = [...pins, ...automatic];
  const result: SelectedReportingStory[] = [];
  for (const story of eligible) {
    const key = canonical(story);
    if (result.some(item => canonical(item) === key)) continue;
    // Prefer the eligible Boardwalk copy while retaining the pin's position/note.
    const local = eligible.find(item => item.source === "posts" && canonical(item) === key);
    result.push({ ...(local ?? story), ...(story.note ? { note: story.note } : {}), ...(story.pinnedBy ? { pinnedBy: story.pinnedBy } : {}) });
    if (result.length === 3) break;
  }
  return result;
}
