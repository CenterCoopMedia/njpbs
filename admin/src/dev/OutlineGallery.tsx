import { useState } from "react";
import { BlockEditor } from "../components/BlockEditor";
import { Button } from "../components/ui/Primitives";
import { createBlock, type AdminBlock } from "../lib/block-factory";

const fixture = (): AdminBlock[] => [
  { ...createBlock("row", "row-empty"), data: { columns: [6, 6] } },
  { ...createBlock("row", "row-filled"), data: { columns: [4, 4, 4] } },
  ...[0, 1, 2].map(column => ({ ...createBlock("prose", `text-${column}`),
    layout: { rowId: "row-filled", column },
    data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Sample story text" }] }] } },
  })),
].map((block, order) => ({ ...block, order }));

/** Real editor with an in-memory save receipt; never contacts the CMS. */
export function OutlineGallery() {
  const [stored, setStored] = useState(fixture);
  const [opened, setOpened] = useState(stored);
  const [version, setVersion] = useState(0);
  return <main style={{ padding: "var(--space-3)", minWidth: 0 }}>
    <h1>Test post</h1>
    <p className="muted">Post body</p>
    <Button onClick={() => { setOpened(structuredClone(stored)); setVersion(value => value + 1); }}>Reopen saved content</Button>
    <BlockEditor key={version} section="post" emptyDocumentKind="post" initialBlocks={opened} commandsInline allowIncomplete
      onSave={async blocks => {
        const mintedIds = Object.fromEntries(blocks.filter(block => !block.id.startsWith("saved-")).map(block => [block.id, `saved-${block.id}`]));
        const saved = blocks.map(block => ({ ...block, id: mintedIds[block.id] ?? block.id,
          ...(block.layout ? { layout: { ...block.layout, rowId: mintedIds[block.layout.rowId] ?? block.layout.rowId } } : {}),
        }));
        setStored(structuredClone(saved));
        return { blocks: saved, mintedIds };
      }} />
  </main>;
}
