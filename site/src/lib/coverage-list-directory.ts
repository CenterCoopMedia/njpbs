type CoverageSort = "newest" | "oldest";

interface CoverageEntryElement {
  element: HTMLElement;
  date: string;
  year: string;
  initialIndex: number;
  searchText: string;
}

interface CoverageGroupElement {
  element: HTMLElement;
  list: HTMLElement;
  year: string;
  entries: CoverageEntryElement[];
}

function normalizedSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(DIACRITIC_PATTERN, "")
    .toLocaleLowerCase()
    .trim();
}

const DIACRITIC_PATTERN = new RegExp(String.raw`\p{Diacritic}`, "gu");

function compareDatedValues(
  left: { date: string; initialIndex: number },
  right: { date: string; initialIndex: number },
  sort: CoverageSort,
): number {
  if (!left.date && !right.date) return left.initialIndex - right.initialIndex;
  if (!left.date) return 1;
  if (!right.date) return -1;
  const byDate = left.date.localeCompare(right.date);
  if (byDate !== 0) return sort === "newest" ? -byDate : byDate;
  return left.initialIndex - right.initialIndex;
}

function coverageGroups(root: HTMLElement): CoverageGroupElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-coverage-group]")].map((element) => {
    const list = element.querySelector<HTMLElement>(".coverage-list__grid");
    if (!list) throw new Error("Coverage list group is missing its card list.");
    const year = element.dataset.coverageYear ?? "";
    const entries = [...element.querySelectorAll<HTMLElement>("[data-coverage-entry]")].map(
      (entry, fallbackIndex) => ({
        element: entry,
        date: entry.dataset.coverageEntryDate ?? "",
        year,
        initialIndex: Number(entry.dataset.coverageEntryIndex ?? fallbackIndex),
        searchText: normalizedSearchText(entry.dataset.coverageSearch ?? ""),
      }),
    );
    return {
      element,
      list,
      year,
      entries,
    };
  });
}

function compareCoverageGroups(
  left: CoverageGroupElement,
  right: CoverageGroupElement,
  sort: CoverageSort,
): number {
  if (!left.year && !right.year) return 0;
  if (!left.year) return 1;
  if (!right.year) return -1;
  const byYear = left.year.localeCompare(right.year);
  return sort === "newest" ? -byYear : byYear;
}

export function setupCoverageListDirectory(root: HTMLElement): () => void {
  const controls = root.querySelector<HTMLElement>("[data-coverage-controls]");
  const groupsContainer = root.querySelector<HTMLElement>("[data-coverage-groups]");
  const search = root.querySelector<HTMLInputElement>("[data-coverage-search-input]");
  const sort = root.querySelector<HTMLSelectElement>("[data-coverage-sort]");
  const status = root.querySelector<HTMLElement>("[data-coverage-status]");
  const empty = root.querySelector<HTMLElement>("[data-coverage-empty]");
  if (!controls || !groupsContainer || !search || !status || !empty) {
    return () => {};
  }

  const groups = coverageGroups(root);
  const entries = groups.flatMap((group) => group.entries);
  const groupByYear = new Map<string, CoverageGroupElement>();
  const duplicateGroups: CoverageGroupElement[] = [];
  for (const group of groups) {
    if (groupByYear.has(group.year)) duplicateGroups.push(group);
    else groupByYear.set(group.year, group);
  }
  const directoryGroups = [...groupByYear.values()];
  const noun = root.dataset.coverageNoun || "articles";
  const update = () => {
    const query = normalizedSearchText(search.value);
    const selectedSort: CoverageSort = sort?.value === "oldest" ? "oldest" : "newest";
    let visibleCount = 0;

    const sortedGroups = [...directoryGroups].sort((left, right) =>
      compareCoverageGroups(left, right, selectedSort));
    for (const group of sortedGroups) {
      const sortedEntries = entries
        .filter((entry) => entry.year === group.year)
        .sort((left, right) => compareDatedValues(left, right, selectedSort));
      for (const entry of sortedEntries) {
        const visible = !query || entry.searchText.includes(query);
        entry.element.hidden = !visible;
        if (visible) visibleCount += 1;
        group.list.append(entry.element);
      }
      group.element.hidden = sortedEntries.every((entry) => entry.element.hidden);
      groupsContainer.append(group.element);
    }
    for (const group of duplicateGroups) group.element.hidden = true;

    const resultNoun = entries.length === 1 && noun.endsWith("s") ? noun.slice(0, -1) : noun;
    status.textContent = query
      ? `${visibleCount} of ${entries.length} ${resultNoun}`
      : `${entries.length} ${resultNoun}`;
    empty.hidden = visibleCount !== 0;
  };

  controls.hidden = false;
  search.addEventListener("input", update);
  sort?.addEventListener("change", update);
  update();

  return () => {
    search.removeEventListener("input", update);
    sort?.removeEventListener("change", update);
  };
}
