import type { CardGridBlock } from "../../../packages/content-core/src/content-model";
import { homeDetailText } from "../../../packages/content-core/src/home-composition-contract";
import type { AdminBlock } from "../lib/block-factory";
import { TextInput, Textarea } from "./ui/Primitives";

export function HomeDonorEditor({ block, readOnly, onChange }: {
  block: AdminBlock; readOnly: boolean; onChange: (data: Record<string, unknown>) => void;
}) {
  const card = (block as unknown as CardGridBlock).data.cards[0];
  const update = (change: Partial<typeof card>) => { if (!readOnly) onChange({ ...block.data, cards: [{ ...card, ...change }] }); };
  return <fieldset disabled={readOnly}><legend>Donor-advised giving</legend>
    <label>Heading<TextInput value={card.title} maxLength={120} onChange={event => update({ title: event.target.value })} /></label>
    <label>Summary<Textarea value={homeDetailText(card.body) ?? ""} maxLength={2000} onChange={event => update({ body: {
      type: "doc", content: [{ type: "paragraph", content: event.target.value ? [{ type: "text", text: event.target.value.replace(/[\r\n\t]+/g, " ") }] : [] }],
    } })} /></label>
    <p>The summary is one paragraph. Line breaks and tabs become spaces.</p>
    <label>Button text<TextInput value={card.label ?? ""} maxLength={120} onChange={event => update({ label: event.target.value })} /></label>
    <p>This button opens the existing Support page.</p>
  </fieldset>;
}
