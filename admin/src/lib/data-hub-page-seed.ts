import { DATA_HUB_SECTIONS, defaultDataHubBlocks } from "../../../packages/content-core/src/data-hub-composition";
import type { AdminBlock } from "./block-factory";

export function nextDataHubSection(blocks: readonly AdminBlock[]) {
  return Object.keys(DATA_HUB_SECTIONS).find(id => !blocks.some(block =>
    block.type === "data_hub_section" && block.data.sectionId === id));
}

/** Keep retained legacy content after the compiled Page without writing on load. */
export function seedDataHubPageBlocks(retained: readonly AdminBlock[]): AdminBlock[] {
  const ids = new Set(retained.map(block => block.id));
  const compiled = defaultDataHubBlocks().map(block => {
    let id = block.id;
    while (ids.has(id)) id += "-seed";
    ids.add(id);
    return { ...block, id, data: { ...block.data } };
  });
  return [...compiled, ...retained].map((block, order) => ({ ...block, order }));
}
