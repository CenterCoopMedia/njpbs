import { isHubElectricity, hubElectricityProblem } from "../../../packages/content-core/src/data-hub-electricity.ts";
import { createDatasetFigureResolver } from "../../../packages/content-core/src/dataset-figures.ts";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";
import type { PageBlock } from "../../../packages/content-core/src/content-model.ts";
import type { DatasetPublicProjection } from "../../../packages/content-core/src/data-figure.ts";

/** The approved electricity release frozen with the Hub Page. The Page blocks leave out its data figure
 * when the electricity section shows the release; otherwise that block stays as an ordinary chart. */
export function hubElectricityBinding(page: { dataHubCompositionVersion?: 1; datasetFigures?: unknown; blocks: readonly PageBlock[] }):
  { projection: DatasetPublicProjection; blocks: PageBlock[] } | undefined {
  if (page.dataHubCompositionVersion !== 1) return undefined;
  const resolve = createDatasetFigureResolver(page.datasetFigures);
  const visible = visibleLayoutBlocks(page.blocks);
  const section = visible.some(block => block.type === "data_hub_section" && block.data.sectionId === "electricity");
  for (const block of visible) {
    if (block.type !== "data_figure") continue;
    const projection = resolve(block.id, block.data);
    if (!projection || !isHubElectricity(projection.release) || hubElectricityProblem(projection.release)) continue;
    return { projection, blocks: !section ? [...page.blocks] : page.blocks.filter(item => item.id !== block.id).sort((a, b) => a.order - b.order)
      .map((item, order) => ({ ...item, order })) };
  }
  return undefined;
}
