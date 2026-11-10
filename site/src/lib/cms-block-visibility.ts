import type { RenderedContentGroup } from "../../../packages/content-core/src/content-row-render";
import { resolveRecordCard, type RecordCardPayload } from "./record-card-resolution";

/** Use the same public-card and sponsor admission for leaf markup and layout. */
export function cmsBlockLeafPresentation(group: RenderedContentGroup, cards: readonly RecordCardPayload[]) {
  const card = group.block.type === "record_card" ? resolveRecordCard(group.block, cards) : null;
  return { card, visible: (group.block.type !== "record_card" || card !== null) &&
    (group.block.type !== "sponsor_strip" || group.html !== "") };
}

export function cmsBlockGroupVisible(group: RenderedContentGroup, cards: readonly RecordCardPayload[]): boolean {
  return group.columns
    ? group.columns.some(column => column.some(item => cmsBlockLeafPresentation(item, cards).visible))
    : cmsBlockLeafPresentation(group, cards).visible;
}

/** A sidebar needs rendered content, rather than an empty leaf wrapper. */
export function cmsBlockGroupHasContent(group: RenderedContentGroup, cards: readonly RecordCardPayload[]): boolean {
  if (group.columns) return group.columns.some(column => column.some(item => cmsBlockGroupHasContent(item, cards)));
  const { card, visible } = cmsBlockLeafPresentation(group, cards);
  return visible && (card !== null || group.html.trim() !== "");
}
