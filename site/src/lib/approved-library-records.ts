import { createRequire } from "node:module";

export type LibraryRecord = Record<string, unknown> & { id: string };
export interface HistoryQuery {
  get(): Promise<{ docs: { data(): Record<string, unknown> }[] }>;
  where(field: string, op: "==", value: string): HistoryQuery;
}
export interface HistoryDatabase { collection(name: string): HistoryQuery }

// Share the same admission rule with nonblocking editor save warnings.
export const { resolveApprovedLibraryVersions } = createRequire(import.meta.url)(
  "../../../functions/lib/approved-library-records.js",
) as {
  resolveApprovedLibraryVersions<T extends LibraryRecord>(
    database: HistoryDatabase, records: readonly T[],
    readQuery?: (query: HistoryQuery) => Promise<{ docs: { data(): Record<string, unknown> }[] }>,
  ): Promise<(T & { approvedLibraryVersion: LibraryRecord | null })[]>;
};
