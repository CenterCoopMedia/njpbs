export type DesignCatalogName = "assets" | "tokens";

const normalizeCatalogValue = (value: string) =>
  value.normalize("NFKD").toLocaleLowerCase();

export function matchesDesignCatalogSearch(searchValue: string, query: string) {
  const terms = normalizeCatalogValue(query.trim()).split(/\s+/).filter(Boolean);
  const normalizedSearchValue = normalizeCatalogValue(searchValue);
  return terms.every((term) => normalizedSearchValue.includes(term));
}

export function formatDesignCatalogCount(
  visibleCount: number,
  totalCount: number,
  label: string,
  filtered: boolean,
) {
  return filtered
    ? `Showing ${visibleCount} of ${totalCount} ${label}.`
    : `Showing all ${totalCount} ${label}.`;
}

export function setupDesignCatalogFilter(
  catalog: DesignCatalogName,
  root: ParentNode = document,
) {
  const input = root.querySelector<HTMLInputElement>(
    `[data-catalog-filter="${catalog}"]`,
  );
  const count = root.querySelector<HTMLOutputElement>(
    `[data-catalog-count="${catalog}"]`,
  );
  const empty = root.querySelector<HTMLElement>(
    `[data-catalog-empty="${catalog}"]`,
  );
  const items = [
    ...root.querySelectorAll<HTMLElement>(`[data-catalog-item="${catalog}"]`),
  ];
  const groups = [
    ...root.querySelectorAll<HTMLElement>(`[data-catalog-group="${catalog}"]`),
  ];
  const label = catalog === "tokens" ? "tokens" : "image assets";
  if (!input || !count || !empty || items.length === 0) return;

  const updateCatalog = () => {
    const query = input.value.trim();
    let visibleCount = 0;

    items.forEach((item) => {
      const matches = matchesDesignCatalogSearch(
        item.dataset.catalogSearch ?? "",
        query,
      );
      item.hidden = !matches;
      if (matches) visibleCount += 1;
    });

    groups.forEach((group) => {
      group.hidden = !group.querySelector(
        `[data-catalog-item="${catalog}"]:not([hidden])`,
      );
    });

    count.textContent = formatDesignCatalogCount(
      visibleCount,
      items.length,
      label,
      query.length > 0,
    );
    empty.hidden = visibleCount > 0;
  };

  input.addEventListener("input", updateCatalog);
  input.addEventListener("search", updateCatalog);
}
