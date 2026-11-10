import type { EditorField } from "../../../packages/content-core/src/editor-admin";

// Explanations supplement the visible field instructions. Paths distinguish Search and Social
// overrides from the record title; this copy never changes validation or saved field values.
const HELP: Record<string, string> = {
  "pageTheme": "NJ Decides 2026 shows the election logo band at the top of this Page. Default keeps the regular Page header.",
  "seo.title": "This changes the title suggested to search engines, without changing the visible page heading. Leave it blank to reuse the page or post title.",
  "seo.description": "This is the short description suggested for search results. Search engines may choose a different excerpt. Leave it blank to use the normal content description.",
  "seo.noindex": "This asks search engines to leave the page out of their results. Posts also stay off author pages, even when pinned. It does not make a page private or prevent someone from opening its URL.",
  "social.title": "This title is suggested for link previews in social posts and messaging apps. It does not replace the heading on the page.",
  "social.description": "This description is suggested for shared-link cards. Services may cache an older preview after you publish a change.",
  "social.imageAssetId": "The image suggested when someone shares this link. Choose artwork that remains clear when cropped to a small horizontal card.",
  "alt": "Describe the information this image adds in this context. Keep it concise; avoid repeating a nearby caption or starting with ‘image of’.",
  "altDecorative": "A decorative image adds no information beyond nearby text. Screen readers skip it. Photos that identify a person, place, or subject usually need alt text.",
  "tags": "Tags connect related posts. Reuse an existing spelling so the same topic is not split across several tags.",
  "excerpt": "An excerpt is a short fallback for cards and previews. For Posts, Summary takes priority; the excerpt does not appear beneath the main heading.",
};

export function fieldInfo(field: EditorField): string | undefined {
  return HELP[[...(field.path ?? []), field.key].join(".")];
}
