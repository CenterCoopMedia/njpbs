import { escapeHtml } from "./content-model";
import { postChapterBaseId } from "./post-chapters";

/** Collect section links as the body renders, in the same order as their targets. */
export function createReadingSections() {
  const sections: { id: string; label: string }[] = [];
  const usedIds = new Set<string>();

  function addHeading(text: string, level: number, existingId?: string): string | undefined {
    const label = text.replace(/\s+/g, " ").trim();
    if (level !== 2 || !label) return existingId;

    const baseId = `reading-section-${postChapterBaseId(label)}`;
    let id = existingId ?? baseId;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${baseId}-${suffix}`;
    usedIds.add(id);
    sections.push({ id, label });
    return id;
  }

  function renderIndex(): string {
    if (!sections.length) return "";
    const links = sections.map(({ id, label }) =>
      `<li><a href="#${escapeHtml(id)}">${escapeHtml(label)}</a></li>`).join("");
    return `<nav class="reading-sections" aria-label="On this page" data-pagefind-ignore><strong>On this page</strong><ul>${links}</ul></nav>`;
  }

  return { addHeading, renderIndex };
}
