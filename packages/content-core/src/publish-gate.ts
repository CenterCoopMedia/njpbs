import type { EditorialBase } from "./content-model.ts";
import { parsePublishInstant } from "./publish-instant.ts";

type Gateable = Pick<EditorialBase, "status" | "publishAt" | "deleted" | "publiclyVisible"> & {
  published?: { publishedAt?: unknown } | unknown;
};

/** The shared admission gate for a live immutable snapshot. */
export function isPublishable(record: Gateable, now: Date): boolean {
  const visible = record.publiclyVisible === true ||
    (record.publiclyVisible === undefined && record.status === "published");
  if (!visible || record.deleted) return false;
  const snapshotTime =
    record.status !== "published" &&
    typeof record.published === "object" &&
    record.published !== null &&
    "publishedAt" in record.published
      ? record.published.publishedAt
      : record.publishAt;
  if (typeof snapshotTime !== "string") return false;
  const publishAt = parsePublishInstant(snapshotTime);
  return publishAt !== null && publishAt <= now.getTime();
}

export function selectPublishable<T extends EditorialBase>(records: readonly T[], now: Date): T[] {
  return records.filter(record => isPublishable(record, now));
}
