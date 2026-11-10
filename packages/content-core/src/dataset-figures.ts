import { validDatasetId } from "./datasets.ts";
import { isDataFigureData, type DataFigureData, type DatasetPublicProjection } from "./data-figure.ts";
import { isDatasetPublicProjection } from "./data-figure-render.ts";

export type DatasetFigureBinding = {
  blockId: string; datasetId: string; releaseId: string; revision: number; digest: string;
} | { blockId: string; datasetId: string; withdrawn: true };
export interface DatasetFigures { figures: DatasetFigureBinding[]; releases: DatasetPublicProjection[] }
const key = (release: DatasetPublicProjection) => `${release.datasetId}/${release.releaseId}/${release.revision}/${release.digest}`;
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(field => allowed.includes(field));
}
/** The frozen public dependency boundary. No private dataset document crosses it. */
export function isDatasetFigures(value: unknown): value is DatasetFigures {
  if (!object(value) || !fields(value, ["figures", "releases"]) ||
    !Array.isArray(value.figures) || value.figures.length > 200 ||
    !Array.isArray(value.releases) || value.releases.length > 200) return false;
  const releases = new Set<string>();
  for (const release of value.releases) {
    if (!isDatasetPublicProjection(release) || releases.has(key(release))) return false;
    releases.add(key(release));
  }
  const blocks = new Set<string>();
  const used = new Set<string>();
  for (const binding of value.figures) {
    if (!object(binding) || !validDatasetId(binding.blockId) || !validDatasetId(binding.datasetId) || blocks.has(binding.blockId)) return false;
    blocks.add(binding.blockId);
    if (binding.withdrawn === true) {
      if (!fields(binding, ["blockId", "datasetId", "withdrawn"])) return false;
      continue;
    }
    if (!fields(binding, ["blockId", "datasetId", "releaseId", "revision", "digest"]) ||
      !validDatasetId(binding.releaseId) || !Number.isSafeInteger(binding.revision) || Number(binding.revision) < 1 ||
      typeof binding.digest !== "string" || !/^[a-f0-9]{64}$/.test(binding.digest)) return false;
    const identity = `${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`;
    if (!releases.has(identity)) return false;
    used.add(identity);
  }
  return used.size === releases.size;
}
/** Validate once per frozen owner, then resolve repeated figures by immutable id. */
export function createDatasetFigureResolver(figures: unknown): (blockId: string, data: DataFigureData) => DatasetPublicProjection | null {
  if (!isDatasetFigures(figures)) return () => null;
  const bindings = new Map(figures.figures.map(binding => [binding.blockId, binding]));
  const releases = new Map(figures.releases.map(release => [key(release), release]));
  return (blockId, data) => {
    if (!isDataFigureData(data, true)) return null;
    const binding = bindings.get(blockId);
    if (!binding || binding.datasetId !== data.datasetId || "withdrawn" in binding ||
      (data.version.mode === "pinned" && binding.releaseId !== data.version.releaseId)) return null;
    return releases.get(`${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`) ?? null;
  };
}
export function resolveDatasetFigure(figures: unknown, blockId: string, data: DataFigureData): DatasetPublicProjection | null {
  return createDatasetFigureResolver(figures)(blockId, data);
}
export { renderDataFigure } from "./data-figure-render.ts";
