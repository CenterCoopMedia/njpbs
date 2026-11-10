import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import work from "../../functions/lib/public-release-pair-work.js";

const immutable = (path: string) => /^system\/publicReleaseChanges\/(?:entries|operations|bodies|codeChunks|baselines|baselineDigests|baselineCensuses|censusPages)\//.test(path) ||
  /^system\/publicReleasePairs\/entries\//.test(path) || path === "system/publicReleasePairs";
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
const field = (value: any, path: unknown): any => {
  if (typeof path !== "string" || !/^[A-Za-z0-9_.]+$/.test(path)) refuse();
  return path.split(".").reduce((value, part) => value?.[part], value);
};
function matches(value: unknown, filter: any): boolean {
  if (filter && Array.isArray(filter.filters)) {
    if (filter.operator === "OR") return filter.filters.some((part: unknown) => matches(value, part));
    if (filter.operator === "AND") return filter.filters.every((part: unknown) => matches(value, part));
    refuse();
  }
  const actual = field(value, filter?.field);
  switch (filter?.operator) {
    case "==": return actual !== undefined && JSON.stringify(actual) === JSON.stringify(filter.value);
    case ">": return typeof actual === "number" && typeof filter.value === "number" && actual > filter.value;
    case "in": return Array.isArray(filter.value) && filter.value.some((part: unknown) => JSON.stringify(actual) === JSON.stringify(part));
    case "array-contains": return Array.isArray(actual) && actual.some(part => JSON.stringify(part) === JSON.stringify(filter.value));
    case "array-contains-any": return Array.isArray(actual) && Array.isArray(filter.value) && actual.some(part => filter.value.includes(part));
    default: refuse();
  }
}
/** Runs existing strict read projections over a verified immutable source map.
 * Unsupported queries refuse. Only immutable protocol records may reach the
 * underlying SDK; a missing CMS dependency can never read through to latest.
 * The facade deliberately supplies no mutation API. */
export function createHistoricalPublicReleaseReader(options: {
  firestore: Firestore; documents: Map<string, unknown>; cursor: { baselineDigest: string; sequence: number; lastDigest: string }; renderedAt: string;
}) {
  const time = Timestamp.fromDate(new Date(options.renderedAt));
  const documents = new Map(options.documents);
  documents.set("system/publicReleaseChanges", { schemaVersion: 2, ...options.cursor });
  const data = (path: string): any => {
    const value: any = documents.has(path) ? structuredClone(documents.get(path)) : undefined;
    if (path === "system/publicDeployment/contexts/public" && typeof value?.changedAt === "string") {
      value.changedAt = Timestamp.fromDate(new Date(value.changedAt));
    }
    return value;
  };
  const snapshot = (path: string) => ({ id: path.split("/").at(-1)!, ref: doc(path), exists: documents.has(path),
    data: () => data(path),
    get: (name: string) => field(documents.get(path), name), createTime: time, updateTime: time, readTime: time });
  const get = async (reference: any): Promise<any> => {
    if (reference.type === "document") {
      if (immutable(reference.path) && !documents.has(reference.path)) return options.firestore.doc(reference.path).get();
      return snapshot(reference.path);
    }
    if (reference.type !== "query") refuse();
    let selected = [...documents].filter(([path, value]) => path.slice(0, path.lastIndexOf("/")) === reference.path &&
      reference.filters.every((filter: unknown) => matches(value, filter)));
    selected.sort(([a], [b]) => a < b ? -1 : 1);
    selected = selected.slice(0, reference.bound);
    return { docs: selected.map(([path]) => snapshot(path)), size: selected.length, empty: selected.length === 0 };
  };
  function query(path: string, filters: unknown[] = [], bound = 10_001): any {
    return { type: "query", path, filters, bound,
      where: (...args: any[]) => query(path, [...filters, args.length === 1 ? args[0] : { field: args[0], operator: args[1], value: args[2] }], bound),
      limit: (value: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > 10_001) refuse(); return query(path, filters, value); },
      select: (...fields: string[]) => { fields.forEach(name => field({}, name)); return query(path, filters, bound); },
      doc: (id: string) => doc(`${path}/${id}`), get: () => get(query(path, filters, bound)) };
  }
  function doc(path: string): any {
    if (typeof path !== "string" || !path || path.includes("..") || path.includes("//") || path.split("/").length % 2 !== 0) refuse();
    return { type: "document", path, id: path.split("/").at(-1), collection: (name: string) => query(`${path}/${name}`), get: () => get(doc(path)) };
  }
  const transaction = { get, getAll: async (...refs: any[]) => Promise.all(refs.map(get)) };
  const facade = { projectId: (options.firestore as unknown as { projectId: string }).projectId, doc, collection: query,
    runTransaction: async (read: (transaction: any) => unknown, config: { readOnly?: boolean }) => {
      if (config?.readOnly !== true) refuse(); return read(transaction);
    } };
  return facade as unknown as Firestore;
}
