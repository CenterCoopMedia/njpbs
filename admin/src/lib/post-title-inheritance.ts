const POST_TITLE_OVERRIDE_GROUPS = ["seo", "social"] as const;

export function hasExplicitPostTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function effectivePostTitle(
  override: unknown,
  header: unknown,
): string {
  if (hasExplicitPostTitle(override)) return override;
  return typeof header === "string" ? header : "";
}

/**
 * Remove legacy blank Post title overrides without disturbing their metadata
 * groups or sibling fields. Keeping an empty group is intentional: an existing
 * record can send `{ seo: {} }` or `{ social: {} }` as an authoritative clear.
 */
export function normalizeBlankPostTitleOverrides(
  record: Record<string, unknown>,
): Record<string, unknown> {
  let normalized = record;

  for (const groupKey of POST_TITLE_OVERRIDE_GROUPS) {
    const group = record[groupKey];
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      continue;
    }
    const title = (group as Record<string, unknown>).title;
    if (typeof title !== "string" || hasExplicitPostTitle(title)) continue;

    const nextGroup = { ...(group as Record<string, unknown>) };
    delete nextGroup.title;
    if (normalized === record) normalized = { ...record };
    normalized[groupKey] = nextGroup;
  }

  return normalized;
}
