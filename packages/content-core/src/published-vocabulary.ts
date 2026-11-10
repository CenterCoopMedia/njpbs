export interface PublishedVocabulary {
  tags: string[];
  categories: string[];
}

export const editorialTermKey = (value: string): string => value.trim().toLocaleLowerCase("en-US");

function terms(values: unknown, seen: Map<string, string>) {
  if (!Array.isArray(values)) return;
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    const key = editorialTermKey(value);
    if (key && !key.startsWith("format:") && !seen.has(key)) seen.set(key, value);
  }
}

/** Read immutable published metadata, never the working draft or media/access categories. */
export function publishedVocabulary(records: readonly Record<string, unknown>[]): PublishedVocabulary {
  const tags = new Map<string, string>();
  const categories = new Map<string, string>();
  for (const record of records) {
    if (record.type !== "post" || record.deleted === true || record.publiclyVisible === false ||
      (record.publiclyVisible !== true && record.status !== "published") || record.publishBuildPending === true) continue;
    const snapshot = record.published as { sourceVersion?: number; metadata?: Record<string, unknown> } | undefined;
    const sourceVersion = snapshot?.sourceVersion;
    if (typeof sourceVersion !== "number" || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 ||
      (record.publicSourceVersion !== undefined && record.publicSourceVersion !== sourceVersion)) continue;
    terms(snapshot?.metadata?.tags, tags);
    terms(snapshot?.metadata?.categories, categories);
  }
  const sorted = (values: Map<string, string>) => [...values.values()].sort((a, b) => a.localeCompare(b, "en-US"));
  return { tags: sorted(tags), categories: sorted(categories) };
}
