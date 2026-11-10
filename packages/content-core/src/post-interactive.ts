import { isDataFigureData } from "./data-figure";
import { dataTableError } from "./data-table";
import { visibleLayoutBlocks } from "./content-layout";
import {
  safeHref,
  type PageBlock,
} from "./content-model";

export interface InteractivePostInventory {
  modules: number;
  unlabeledModules: number;
  unsafeModules: number;
}

/** Count visible launchable modules and whether each has an editorial label. */
export function interactivePostInventory(
  blocks: readonly PageBlock[],
): InteractivePostInventory {
  let modules = 0;
  let unlabeledModules = 0;
  let unsafeModules = 0;

  for (const block of visibleLayoutBlocks(blocks)) {
    if (block.visible === false) continue;
    if (block.type === "data_figure") {
      if (isDataFigureData(block.data, true)) modules += 1;
      else unsafeModules += 1;
      continue;
    }
    if (block.type === "data_table") {
      if (dataTableError(block.data)) unsafeModules += 1;
      else modules += 1;
      continue;
    }
    // A custom HTML frame is the interactive module itself; its frame title names it.
    if (block.type === "html") {
      modules += 1;
      if (!block.data.title?.trim()) unlabeledModules += 1;
      continue;
    }
    if (block.type !== "embed") continue;
    if (safeHref(block.data.url) === null) {
      unsafeModules += 1;
      continue;
    }
    modules += 1;
    if (!block.data.caption?.trim()) unlabeledModules += 1;
  }

  return { modules, unlabeledModules, unsafeModules };
}

export function assertInteractiveInventory(
  inventory: InteractivePostInventory,
): void {
  if (inventory.unsafeModules > 0) {
    throw new Error(
      "Every Interactive/Data Lab module needs a complete data figure or table, or an approved, nonblank link.",
    );
  }
  if (inventory.modules < 1) {
    throw new Error(
      "An Interactive/Data Lab Post must include at least one complete data figure or table, custom HTML block, or approved media or interactive link.",
    );
  }
  if (inventory.unlabeledModules > 0) {
    throw new Error(
      "Every Interactive/Data Lab link needs a concise caption, and every custom HTML block a frame title, that names the experience.",
    );
  }
}

export function interactiveInventoryText(
  inventory: InteractivePostInventory,
  sectionCount: number,
): string {
  const moduleLabel = inventory.modules === 1 ? "module" : "modules";
  const parts = [`${inventory.modules} interactive ${moduleLabel}`];
  if (sectionCount > 0) {
    const sectionLabel =
      sectionCount === 1 ? "reporting section" : "reporting sections";
    parts.push(`${sectionCount} ${sectionLabel}`);
  }
  return parts.join(" · ");
}
