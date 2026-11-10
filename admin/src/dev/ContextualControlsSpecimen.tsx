import { useState } from "react";
import { FieldRenderer } from "../components/FieldRenderer";
import { DocumentListEditor } from "../components/DocumentListEditor";
import { createBlock } from "../lib/block-factory";
import type { EditorField } from "../../../packages/content-core/src/editor-admin";

const tagsField: EditorField = { key: "tags", label: "Tags", help: "Useful compact labels.", kind: "list", required: false };
const linksField: EditorField = { key: "links", label: "Links", help: "Links in order.", kind: "list", required: false,
  itemFields: [{ key: "label", label: "Label", help: "Link label.", kind: "text", required: true }] };
const bylineField: EditorField = { key: "credits", label: "Byline", help: "Credit the people who made this.", kind: "storyCredits", required: false };

/** The actual four list owners, isolated from live accounts and media requests. */
export function ContextualControlsSpecimen() {
  const [tags, setTags] = useState<unknown>(["News", "A useful label long enough to wrap on a narrow screen"]);
  const [links, setLinks] = useState<unknown>([{ label: "First link" }, { label: "Second link" }]);
  const [credits, setCredits] = useState<unknown>([{ kind: "custom", name: "NJ PBS staff" }]);
  const [notice, setNotice] = useState(() => ({ ...createBlock("document_list", "fixture-notices"), data: { documents: [
    { itemId: "fixture-notice", assetId: "fixture-pdf", title: "Meeting notice", publisher: "njpba" },
  ] } }));
  return <section aria-label="Contextual list controls" className="panel" style={{ display: "grid", gap: "1rem", padding: "1rem" }}>
    <FieldRenderer field={tagsField} fieldId="context-tags" value={tags} onChange={setTags} />
    <FieldRenderer field={linksField} fieldId="context-links" value={links} onChange={setLinks} />
    <FieldRenderer field={bylineField} fieldId="context-byline" value={credits} onChange={setCredits} bylineAuthors={[]} />
    <DocumentListEditor block={notice} onChange={data => setNotice({ ...notice, data: data as typeof notice.data })} />
  </section>;
}
