export const POST_SIDEBAR_SECTIONS = ["overview", "contents", "topics"] as const;
export type PostSidebarSectionId = typeof POST_SIDEBAR_SECTIONS[number];

interface PostSidebarSection {
  id: PostSidebarSectionId;
  visible: boolean;
}

export interface PostSidebar {
  enabled: boolean;
  sections?: PostSidebarSection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPostSidebar(value: unknown): value is PostSidebar {
  if (!isRecord(value) || typeof value.enabled !== "boolean" ||
      Object.keys(value).some(key => key !== "enabled" && key !== "sections")) return false;
  if (value.sections === undefined) return true;
  if (!Array.isArray(value.sections) || value.sections.length !== POST_SIDEBAR_SECTIONS.length) return false;

  const seen = new Set<unknown>();
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.visible !== "boolean" ||
        !POST_SIDEBAR_SECTIONS.some(id => id === section.id) || seen.has(section.id) ||
        Object.keys(section).some(key => key !== "id" && key !== "visible")) return false;
    seen.add(section.id);
  }
  return true;
}

export function postSidebarSections(sidebar?: PostSidebar): PostSidebarSection[] {
  return sidebar?.sections ?? POST_SIDEBAR_SECTIONS.map(id => ({ id, visible: true }));
}
