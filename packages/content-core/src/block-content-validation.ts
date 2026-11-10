import { CONTENT_SHELF_ITEM_LIMITS, CONTENT_SHELF_PRESENTATIONS, type PageBlock } from "./content-model";
import { electionResultsError } from "./election-results";
import { visibleLayoutBlocks } from "./content-layout";
import { editorFieldsForBlock } from "./editor-admin";
import { missingBlockContent } from "./field-validation";

// Drafts keep format and link checks. Visible public content also needs complete fields.
export function blockContentError(
  blocks: readonly PageBlock[],
  { complete = true }: { complete?: boolean } = {},
): string | null {
  const visible = new Set(visibleLayoutBlocks(blocks).map(block => block.id));
  for (const block of blocks) {
    if (block.type === "election_results") {
      const error = electionResultsError(block.data, complete && visible.has(block.id));
      if (error) return error;
    }
    const fields = editorFieldsForBlock(block.type);
    if (block.type === "content_shelf") {
      // Admission includes future writer values before the editor offers them.
      const presentation = fields.find(field => field.key === "presentation");
      if (presentation) presentation.options = CONTENT_SHELF_PRESENTATIONS.map(value => ({ value, label: value }));
      const itemLimit = fields.find(field => field.key === "itemLimit");
      if (itemLimit) itemLimit.options = CONTENT_SHELF_ITEM_LIMITS.map(value => ({
        value, label: `${value} items`,
      }));
    }
    const errors = missingBlockContent(fields, block.data, {
      allowIncomplete: !complete || !visible.has(block.id) ||
        block.type === "newsletter_signup" && block.section === "home-newsletter" && block.data.newsletterIds.length === 0,
    });
    if (errors.length) return errors[0];
  }
  return null;
}
