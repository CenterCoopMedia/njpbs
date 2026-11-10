import {
  recordFieldsFor,
  type RecordKind,
} from "../../../packages/content-core/src/editor-admin";
import type { LibraryRecordKind } from "./content-vocab";

export interface ContentRecordSummary {
  id: string;
  // A summary is read out of storage, so its kind can be one the editor may no
  // longer create: a record saved before the Article retirement (#1039) still
  // lists. Anything that routes to an editor must narrow this to RecordKind.
  kind: LibraryRecordKind;
  status: string;
  title: string;
  contentLinkDomain?: string;
  version?: number;
  contentVersion?: number;
  publishedSourceVersion?: number;
  publishedContentVersion?: number;
  /** Immutable published snapshot that is still admitted on the public site. */
  liveSourceVersion?: number;
  recordPublication?: { queueId: string; sourceVersion: number; withdrawal: boolean; status: "success"; missingConsumers: string[] };
  /** A public build was requested but has not confirmed its deployed snapshot. */
  publicUpdatePending?: boolean;
  /** Queue that owns the pending publication. Null means the CMS must retry it. */
  publicBuildQueueId?: string | null;
  /** Immutable snapshot version owned by the pending publication request. */
  pendingSourceVersion?: number;
  createdAt?: string;
  publishAt?: string;
  startsAt?: string;
  updatedAt?: string;
  updatedBy?: string;
  assignee?: string;
  thumbnailUrl?: string;
}

function dateString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  // Callable HTTP responses JSON-serialize Firestore Timestamp instances to their backing
  // seconds/nanoseconds shape. Validate both components before reconstructing the same instant;
  // arbitrary maps must not become dates merely because they occupy a date-keyed field.
  if (typeof value === "object" && value !== null) {
    const serialized = value as {
      _seconds?: unknown;
      _nanoseconds?: unknown;
    };
    if (
      Number.isSafeInteger(serialized._seconds) &&
      Number.isInteger(serialized._nanoseconds) &&
      (serialized._nanoseconds as number) >= 0 &&
      (serialized._nanoseconds as number) < 1_000_000_000
    ) {
      const milliseconds =
        (serialized._seconds as number) * 1_000 +
        (serialized._nanoseconds as number) / 1_000_000;
      const date = new Date(milliseconds);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})[T ]/i;

function postCalendarDate(value: unknown): string | undefined {
  if (typeof value === "string") {
    // Canonical and malformed calendar-only values stay untouched. The save boundary
    // accepts the former and reports the intended validation error for the latter.
    if (CALENDAR_DATE_PATTERN.test(value)) return undefined;
    const datePrefix = value.match(ISO_INSTANT_DATE_PREFIX)?.[1];
    if (datePrefix === undefined) return undefined;
    const literalDate = new Date(`${datePrefix}T00:00:00.000Z`);
    if (
      !Number.isFinite(literalDate.getTime()) ||
      literalDate.toISOString().slice(0, 10) !== datePrefix
    ) {
      return undefined;
    }
    if (!Number.isFinite(new Date(value).getTime())) return undefined;
    return datePrefix;
  }
  const date = dateString(value);
  if (date === undefined) return undefined;
  const instant = new Date(date);
  return Number.isFinite(instant.getTime())
    ? instant.toISOString().slice(0, 10)
    : undefined;
}

// Firestore returns Timestamp objects for stored instants, while the editor and save function
// share a JSON-shaped string contract. Normalize Timestamp-backed instants before the form owns
// them, so saving an unrelated field cannot echo a Timestamp into a boundary that correctly
// rejects non-strings (#671). Keep the full instant for event fields; the datetime control
// projects station-local wall time without mutating form state. A post's editorial date is the
// calendar-only exception. Include inherited publishAt even though no descriptor exposes it any
// more -- the one that did belonged to the retired Article form (#1039), and a stored record can
// still carry the value -- so every record kind remains JSON-safe.
//
// Both dated kinds are collected. Reading only `date` would leave an event's startsAt and endsAt
// as Timestamps once they moved to the `datetime` control (#509), which is the exact shape #671
// exists to keep out of the save boundary.
export function normalizeEditorRecordDates(
  kind: RecordKind,
  record: Record<string, unknown>,
): Record<string, unknown> {
  let normalized = record;
  const dateKeys = new Set<string>(["publishAt"]);
  for (const field of recordFieldsFor(kind)) {
    if ((field.kind !== "date" && field.kind !== "datetime") || field.path) continue;
    dateKeys.add(field.key);
  }
  for (const key of dateKeys) {
    const value = record[key];
    if (value === undefined) continue;
    const date =
      kind === "post" && key === "date"
        ? postCalendarDate(value)
        : typeof value === "string"
          ? undefined
          : dateString(value);
    if (date === undefined) continue;
    if (normalized === record) normalized = { ...record };
    normalized[key] = date;
  }
  return normalized;
}
