export { postCoverageLabelId } from "./coverage-label-id.ts";
import { COVERAGE_LABELS_SETTINGS_ID, isCoverageLabelId, projectPublishedCmsSettings, validateCoverageLabels,
  type CoverageLabel, type CmsSettingsPublishedSnapshot } from "./cms-settings.ts";

export interface CoverageLabelsBuildData {
  settingId: typeof COVERAGE_LABELS_SETTINGS_ID;
  labels: readonly CoverageLabel[];
  sourceVersion: number;
  publishedAt: string;
}

/** Only a detached published snapshot can contribute public labels. */
export function projectCoverageLabels(document: unknown): { data: CoverageLabelsBuildData; publishedSnapshot: CmsSettingsPublishedSnapshot } | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  try {
    const published = projectPublishedCmsSettings({ documentId: COVERAGE_LABELS_SETTINGS_ID, document });
    if (!published) return null;
    return { data: { settingId: COVERAGE_LABELS_SETTINGS_ID, labels: published.values.labels as unknown as readonly CoverageLabel[],
      sourceVersion: published.sourceVersion, publishedAt: published.publishedAt }, publishedSnapshot: published };
  } catch { return null; }
}

export function isCoverageLabelsBuildData(value: unknown): value is CoverageLabelsBuildData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).every(key => ["settingId", "labels", "sourceVersion", "publishedAt"].includes(key)) &&
    data.settingId === COVERAGE_LABELS_SETTINGS_ID && !validateCoverageLabels(data.labels) &&
    Number.isSafeInteger(data.sourceVersion) && Number(data.sourceVersion) > 0 &&
    typeof data.publishedAt === "string" && Number.isFinite(Date.parse(data.publishedAt)) &&
    new Date(data.publishedAt).toISOString() === data.publishedAt;
}

/** Retirement stops new choices; it does not erase an existing series identity. */
export function resolveCoverageLabel(id: unknown, registry?: unknown): CoverageLabel | undefined {
  if (!isCoverageLabelId(id) || !isCoverageLabelsBuildData(registry)) return undefined;
  return registry.labels.find(label => label.id === id);
}
