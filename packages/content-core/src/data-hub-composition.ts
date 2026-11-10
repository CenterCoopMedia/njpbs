import { DATA_HUB_FIGURES } from "./data-hub-reporting.ts";
import type { DataHubFigure } from "./data-hub-reporting.ts";
import type { DataHubSectionBlock, PageBlock } from "./content-model.ts";

/** Compiled reader references contain no values, markup, source notes or dates. */
export const DATA_HUB_SECTIONS = {
  introduction: "Page introduction",
  featured: "Featured finding",
  latest: "Latest findings",
  finder: "Find figures",
  overview: "New Jersey in context",
  collection: "Explore the figures",
  ...DATA_HUB_FIGURES,
  methodology: "Reading the numbers",
} as const;
export type DataHubSectionId = keyof typeof DATA_HUB_SECTIONS;
export interface DataHubSectionData {
  sectionId: DataHubSectionId;
  /** Empty text inherits the reviewed compiled copy. */
  heading: string;
  introduction: string;
}

export function isDataHubSectionData(value: unknown): value is DataHubSectionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Reflect.ownKeys(data).every(key => typeof key === "string" && ["sectionId", "heading", "introduction"].includes(key)) &&
    typeof data.sectionId === "string" && Object.hasOwn(DATA_HUB_SECTIONS, data.sectionId) &&
    typeof data.heading === "string" && data.heading.length <= 300 &&
    typeof data.introduction === "string" && data.introduction.length <= 4000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.introduction);
}

export function dataHubFigureSection(id: DataHubSectionId): id is DataHubFigure {
  return Object.hasOwn(DATA_HUB_FIGURES, id);
}

/** One compiled section has one identity, including while hidden in the draft. */
export function dataHubCompositionError(blocks: readonly PageBlock[], pageId?: string): string | null {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "data_hub_section") continue;
    if (pageId !== undefined && pageId !== "data-hub") return "Data Hub sections belong only on the Data Hub Page.";
    if (seen.has(block.data.sectionId)) return "Each compiled Data Hub section can appear only once.";
    seen.add(block.data.sectionId);
  }
  return null;
}

/** Editor-only migration. It never changes a persisted or published snapshot. */
export function defaultDataHubBlocks(): DataHubSectionBlock[] {
  // Characterized from the compiled reader: figures follow its subject groups.
  const order: DataHubSectionId[] = ["introduction", "featured", "latest", "finder", "overview", "collection",
    "unemployment", "industryjobs", "minimumwage", "medianincome", "propertytax", "electricity", "medianrent", "housingpermits", "inflationmetro",
    "precipitation", "temperature", "voterregistration", "statebudget", "familycare", "uninsured", "snap", "schoolabsence", "graduation", "methodology"];
  return order.map((sectionId, order) => ({
    id: `tmp-seed-data-hub-${sectionId}`, type: "data_hub_section", order, visible: true,
    data: { sectionId: sectionId as DataHubSectionId, heading: "", introduction: "" },
  }));
}

/** Immutable ids may be canonicalized on save; only editorial content matters. */
export function isDefaultDataHubComposition(blocks: readonly PageBlock[]): boolean {
  const defaults = defaultDataHubBlocks();
  return blocks.length === defaults.length && blocks.every((block, index) =>
    block.type === "data_hub_section" && block.visible && block.layout === undefined &&
    block.section === undefined && block.order === index &&
    block.data.sectionId === defaults[index].data.sectionId &&
    block.data.heading.trim() === "" && block.data.introduction.trim() === "");
}

export function parseDataHubCompositionVersion(value: unknown): 1 | undefined {
  if (value === undefined) return undefined;
  if (value !== 1) throw new Error("The Data Hub composition version is invalid.");
  return value;
}

/** Legacy blocks stay retained but inactive until an explicit composition save. */
export function dataHubPageError(pageId: string, version: unknown, blocks: unknown): string | null {
  if (pageId !== "data-hub") return version === undefined ? null : "Data Hub composition belongs only on the Data Hub Page.";
  if (version !== undefined && version !== 1) return "The Data Hub composition version is invalid.";
  if (version === undefined && blocks === undefined) return null;
  if (!Array.isArray(blocks)) return "Data Hub content requires a blocks array.";
  if (version === undefined && blocks.some(block => block?.type === "data_hub_section")) {
    return "Data Hub sections require an explicit composition version.";
  }
  return null;
}
