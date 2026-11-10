// Preview builds may intentionally change the requested route's authored copy
// and CTA set. The caller keeps shell/source/artifact invariants outside these
// route-content gates so a draft cannot revive a retired renderer.
export function checkProductionContent(pageId, env = process.env) {
  const mode = String(env.CMS_CONTENT_MODE ?? "").trim().toLowerCase();
  const previewPageId = String(env.CMS_PREVIEW_PAGE_ID ?? "").trim();
  return mode !== "draft" || previewPageId !== pageId;
}
