// The closed vocabularies the URL layer validates against, kept in one place so the path
// builder (routes.ts) and the query-state codec (content-query.ts) agree on what a valid
// record type or content status is. Both parse URLs as untrusted input, so a
// value that is not in one of these sets is rejected rather than compiled into a route or a
// query. Public page ids live in public-pages.ts because the public site shares that registry.
// Pure data with no React or router dependency.
import {
  RETIRED_RECORD_KINDS,
  type RecordKind,
  type RetiredRecordKind,
} from "../../../packages/content-core/src/editor-admin";
import {
  ASSIGNABLE_CONTENT_STATUSES,
  CONTENT_STATUSES,
  isAssignableContentStatus,
  type ContentStatus,
} from "../../../packages/content-core/src/content-model";

export {
  ASSIGNABLE_CONTENT_STATUSES,
  CONTENT_STATUSES,
  isAssignableContentStatus,
  type ContentStatus,
};

// The structured record collections addressable in a route. Held as a literal tuple so a
// URL segment can be checked against it, and `satisfies` proves every entry is a real
// RecordKind. The type-level guard below fails compilation if a new RecordKind is added to
// the model without being listed here, so the routing layer can never silently drop a type.
export const RECORD_KINDS = [
  "program",
  "event",
  "sponsor",
  "newsletter",
  "post",
] as const satisfies readonly Exclude<RecordKind, RetiredRecordKind>[];

// Compile-time exhaustiveness: if RecordKind gains a member missing from RECORD_KINDS this
// resolves to `never` and the assignment fails, so the omission is caught at build time.
type MissingRecordKind = Exclude<
  RecordKind,
  RetiredRecordKind | (typeof RECORD_KINDS)[number]
>;
const _recordKindsExhaustive: [MissingRecordKind] extends [never] ? true : never = true;
void _recordKindsExhaustive;

export type ActiveRecordKind = (typeof RECORD_KINDS)[number];

export function isRecordKind(value: string): value is ActiveRecordKind {
  return (RECORD_KINDS as readonly string[]).includes(value);
}

// What the library can SHOW, which is wider than what it can create. Article was
// retired in #1039, so it is not routable and not offered anywhere, but a record
// stored before that decision is still read back, listed, and archivable. Dropping
// it from the read vocabulary would not delete it; it would only hide it, which is
// how a stored record becomes unfindable instead of retired. The server mirror in
// functions/lib/content-library.js holds the same order, and the deployment-mirror
// preflight proves both surfaces parse a library query identically.
export const LIBRARY_RECORD_KINDS = [
  ...RECORD_KINDS,
  ...RETIRED_RECORD_KINDS,
] as const satisfies readonly (RecordKind | RetiredRecordKind)[];

export type LibraryRecordKind = (typeof LIBRARY_RECORD_KINDS)[number];

export function isLibraryRecordKind(value: string): value is LibraryRecordKind {
  return (LIBRARY_RECORD_KINDS as readonly string[]).includes(value);
}

export function isContentStatus(value: string): value is ContentStatus {
  return (CONTENT_STATUSES as readonly string[]).includes(value);
}
