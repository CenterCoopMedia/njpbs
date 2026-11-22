import assert from "node:assert/strict";
import type { PageBlock } from "../../../packages/content-core/src/content-model";

export const givingPageIds = ["give", "passport"] as const;

// Older Page records have named slots. A saved card set can precede those slots.
export const givingPageBlocks = [
  {
    id: "giving-cards", type: "card_grid", order: 0, visible: true, section: "service-destinations",
    data: { cards: [{ title: "Contact the station", href: "/contact/" }] },
  },
  {
    id: "giving-notice", type: "prose", order: 1, visible: true, section: "transition-notice",
    data: { content: { type: "doc", content: [{
      type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Membership details" }],
    }] } },
  },
  {
    id: "giving-actions", type: "cta_row", order: 2, visible: true, section: "hero-actions",
    data: { ctas: [{ label: "Donate through PBS", href: "https://example.org/give", variant: "primary" }] },
  },
] satisfies PageBlock[];

export function assertGivingPageOrder(html: string, order: readonly string[]): void {
  const position = order.map(id => html.indexOf(`data-block-id="${id}"`));
  assert(position.every((index, i) => index >= 0 && (i === 0 || position[i - 1] < index)), "Giving blocks follow the saved order");
  assert.match(html, /href="\/contact\/"[^>]*>Contact the station<\/a>/);
  assert.match(html, /href="https:\/\/example\.org\/give"[^>]*target="_blank"[^>]*rel="noopener"[^>]*>Donate through PBS/);
}
