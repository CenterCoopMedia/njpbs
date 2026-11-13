import { STORY_CTAS_SETTINGS_ID, projectPublishedCmsSettings, type CmsSettingsPublishedSnapshot } from "./cms-settings.ts";
import { validateStoryCtaRules, type StoryCtasSettingsValues } from "./story-cta-rules.ts";

export interface StoryCtasBuildData extends StoryCtasSettingsValues {
  readonly settingId: typeof STORY_CTAS_SETTINGS_ID;
  readonly sourceVersion: number;
  readonly publishedAt: string;
}

/** Invalid or absent optional CTAs cannot prevent a reader from opening a story. */
export function projectStoryCtas(document: unknown): { data: StoryCtasBuildData; publishedSnapshot: CmsSettingsPublishedSnapshot } | null {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  try {
    const published = projectPublishedCmsSettings({ documentId: STORY_CTAS_SETTINGS_ID, document });
    if (!published) return null;
    return { data: { settingId: STORY_CTAS_SETTINGS_ID, rules: published.values.rules as unknown as StoryCtasSettingsValues["rules"],
      sourceVersion: published.sourceVersion, publishedAt: published.publishedAt }, publishedSnapshot: published };
  } catch { return null; }
}

export function isStoryCtasBuildData(value: unknown): value is StoryCtasBuildData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).every(key => ["settingId", "rules", "sourceVersion", "publishedAt"].includes(key)) &&
    data.settingId === STORY_CTAS_SETTINGS_ID && !validateStoryCtaRules(data.rules) &&
    Number.isSafeInteger(data.sourceVersion) && Number(data.sourceVersion) > 0 &&
    typeof data.publishedAt === "string" && Number.isFinite(Date.parse(data.publishedAt)) &&
    new Date(data.publishedAt).toISOString() === data.publishedAt;
}
