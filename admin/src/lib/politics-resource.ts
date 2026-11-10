export interface ResourceLink {
  label: string;
  url?: string;
  sectionId?: string;
  recordId?: string;
}
export interface ResourceColumn {
  key: string;
  label: string;
  format?: "percent" | "currency" | "number" | "date";
}
export interface ResourceRecord {
  id: string;
  personId?: string;
  personIds?: string[];
  sourceRow?: number;
  values: Record<string, string | number | boolean | null>;
  links: Record<string, ResourceLink>;
}
export interface ResourceSection {
  id: string;
  title: string;
  description?: string;
  columns: ResourceColumn[];
  records: ResourceRecord[];
}
export interface ResourcePerson {
  id: string;
  name: string;
  sortName: string;
  party: string;
  role: string;
  summary: string;
  records: { sectionId: string; recordId: string }[];
}
export interface PoliticsResource {
  schemaVersion: 1;
  meta: {
    title: string;
    asOf: string;
    researchAsOf: string;
    lastTargetedUpdate: string;
    sourceWorkbook: string;
    notes: string[];
  };
  people: ResourcePerson[];
  sections: ResourceSection[];
}

const INVALID = "The politics resource could not be read. Please try again.";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 30000): string {
  if (typeof value !== "string" || value.length > limit) throw new Error(INVALID);
  return value;
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(INVALID);
  return value;
}
function id(value: unknown): string {
  const result = text(value, 180);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new Error(INVALID);
  return result;
}
export function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href : undefined;
  } catch { return undefined; }
}

/** Check the private payload before rendering it; never import the research in a client bundle. */
export function parsePoliticsResource(value: unknown): PoliticsResource {
  const root = object(value);
  if (root.schemaVersion !== 1) throw new Error(INVALID);
  const meta = object(root.meta);
  const sections = list(root.sections, 30).map((value): ResourceSection => {
    const section = object(value);
    const columns = list(section.columns, 100).map((value): ResourceColumn => {
      const column = object(value);
      const format = column.format;
      if (format !== undefined && !["percent", "currency", "number", "date"].includes(String(format))) throw new Error(INVALID);
      return { key: id(column.key), label: text(column.label, 200), format: format as ResourceColumn["format"] };
    });
    const records = list(section.records, 2000).map((value): ResourceRecord => {
      const record = object(value);
      const values = object(record.values);
      for (const value of Object.values(values)) {
        if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) throw new Error(INVALID);
        if (typeof value === "string" && value.length > 30000) throw new Error(INVALID);
      }
      const links = Object.fromEntries(Object.entries(object(record.links ?? {})).map(([key, value]) => {
        const link = object(value);
        return [key, {
          label: text(link.label, 500),
          url: safeSourceUrl(typeof link.url === "string" ? link.url : undefined),
          sectionId: link.sectionId === undefined ? undefined : id(link.sectionId),
          recordId: link.recordId === undefined ? undefined : id(link.recordId),
        }];
      }));
      return { id: id(record.id), values: values as ResourceRecord["values"], links,
        personId: record.personId === undefined ? undefined : id(record.personId),
        personIds: record.personIds === undefined ? undefined : list(record.personIds, 250).map(id),
        sourceRow: typeof record.sourceRow === "number" ? record.sourceRow : undefined };
    });
    if (new Set(records.map(r => r.id)).size !== records.length) throw new Error(INVALID);
    return { id: id(section.id), title: text(section.title, 200), description: section.description === undefined ? undefined : text(section.description, 2000), columns, records };
  });
  const people = list(root.people, 1000).map((value): ResourcePerson => {
    const person = object(value);
    return { id: id(person.id), name: text(person.name, 200), sortName: text(person.sortName, 200), party: person.party === null ? "" : text(person.party, 100), role: text(person.role, 1000), summary: text(person.summary),
      records: list(person.records, 200).map(value => { const record = object(value); return { sectionId: id(record.sectionId), recordId: id(record.recordId) }; }) };
  });
  if (!people.length || !sections.length || new Set(people.map(p => p.id)).size !== people.length || new Set(sections.map(s => s.id)).size !== sections.length) throw new Error(INVALID);
  return { schemaVersion: 1, meta: { title: text(meta.title, 200), asOf: text(meta.asOf, 30), researchAsOf: text(meta.researchAsOf, 30), lastTargetedUpdate: text(meta.lastTargetedUpdate, 30), sourceWorkbook: text(meta.sourceWorkbook, 200), notes: list(meta.notes, 30).map(value => text(value)) }, people, sections };
}

export function displayValue(value: ResourceRecord["values"][string], format?: ResourceColumn["format"]): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "number") {
    if (format === "percent") return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(value);
    if (format === "currency") return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  return String(value);
}
export function normalSearch(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function matchesSearch(haystack: string, query: string): boolean {
  return normalSearch(query).split(/\s+/).filter(Boolean).every(term => haystack.includes(term));
}
export function partyCode(value: string): "D" | "R" | "other" {
  if (/^(D|Democrat|Democratic)$/i.test(value.trim())) return "D";
  if (/^(R|Republican)$/i.test(value.trim())) return "R";
  return "other";
}
export function partyCounts(section: ResourceSection, chamber?: string): { party: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const record of section.records) {
    if (chamber && String(record.values.chamber) !== chamber) continue;
    const party = partyCode(String(record.values.party ?? ""));
    counts.set(party, (counts.get(party) ?? 0) + 1);
  }
  return ["D", "R", "other"].filter(party => counts.has(party)).map(party => ({ party, count: counts.get(party)! }));
}
