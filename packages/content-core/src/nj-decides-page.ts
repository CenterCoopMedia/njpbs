import type { CmsServicePageProjection } from "./cms-service-page";
import { renderServiceActions } from "./cms-service-render";

/** Preserve every CMS hero action; Live keeps its existing below-player copy. */
export function njDecidesServiceHeading(service: CmsServicePageProjection) {
  const live = service.page.slug === "live";
  return { description: live ? "" : service.summary,
    actionsHtml: live ? "" : renderServiceActions(service, true) };
}
