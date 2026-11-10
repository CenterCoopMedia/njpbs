import { isDataFigureData } from "../../../packages/content-core/src/data-figure.ts";
import {
  createDatasetFigureResolver,
  isDatasetFigures,
  type DatasetFigures,
} from "../../../packages/content-core/src/dataset-figures.ts";
import type { DataFigureBlock, PageBlock } from "../../../packages/content-core/src/content-model.ts";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";

function isSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}

/** Admit one exact, public-only dependency projection for the rendered blocks. */
export function projectDatasetFigures(
  value: unknown,
  blocks: readonly PageBlock[],
  owner: string,
  { required = true }: { required?: boolean } = {},
): DatasetFigures | undefined {
  const dataBlocks = visibleLayoutBlocks(blocks).filter((block): block is DataFigureBlock =>
    block.type === "data_figure" && isDataFigureData(block.data, true));

  if (value === undefined) {
    if (required && dataBlocks.length > 0) {
      throw new Error(`${owner} has no frozen dataset figures`);
    }
    return undefined;
  }
  if (!isDatasetFigures(value)) {
    throw new Error(`${owner} has invalid frozen dataset figures`);
  }

  const figureKeys = value.figures.map(binding => binding.blockId);
  const releaseKeys = value.releases.map(release => `${release.datasetId}/${release.releaseId}`);
  if (!isSorted(figureKeys) || !isSorted(releaseKeys)) {
    throw new Error(`${owner} frozen dataset figures are not normalized`);
  }

  const expected = new Map(dataBlocks.map(block => [block.id, block.data]));
  if (value.figures.length !== expected.size ||
      value.figures.some(binding => expected.get(binding.blockId)?.datasetId !== binding.datasetId)) {
    throw new Error(`${owner} frozen dataset figures do not match its blocks`);
  }
  const resolve = createDatasetFigureResolver(value);
  for (const block of dataBlocks) {
    const binding = value.figures.find(item => item.blockId === block.id);
    if (!binding) throw new Error(`${owner} has an unfrozen data figure`);
    if ("withdrawn" in binding) continue;
    if (block.data.version.mode === "pinned" && binding.releaseId !== block.data.version.releaseId) {
      throw new Error(`${owner} frozen dataset figure version does not match its block`);
    }
    if (!resolve(block.id, block.data)) {
      throw new Error(`${owner} frozen dataset figure cannot be resolved`);
    }
  }
  return structuredClone(value);
}
