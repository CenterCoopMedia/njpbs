/** Enhance the complete static tables without a data request. */
export function installCountyComparisonControls(root: ParentNode): () => void {
  const disposers: (() => void)[] = [];
  for (const block of root.querySelectorAll<HTMLElement>(".county-comparison")) {
    const status = block.querySelector<HTMLElement>('[role="status"]');
    for (const table of block.querySelectorAll<HTMLTableElement>("table")) {
      const body = table.tBodies[0];
      if (!body) continue;
      const rows = Array.from(body.querySelectorAll<HTMLTableRowElement>(":scope > tr"));
      const buttons = Array.from(table.querySelectorAll<HTMLButtonElement>("[data-county-sort]"));
      for (const button of buttons) {
        button.hidden = false;
        const label = button.previousElementSibling as HTMLElement | null;
        if (label) label.hidden = true;
        const sort = () => {
          const column = Number(button.dataset.countySort);
          const heading = button.closest("th")!;
          const ascending = heading.getAttribute("aria-sort") !== "ascending";
          table.querySelectorAll("thead th").forEach(th => th.removeAttribute("aria-sort"));
          heading.setAttribute("aria-sort", ascending ? "ascending" : "descending");
          const value = (row: HTMLTableRowElement) => row.cells[column].dataset.countySortValue;
          body.append(...[...rows].sort((a, b) => {
            const comparison = column === 0
              ? a.cells[0].textContent!.localeCompare(b.cells[0].textContent!, "en")
              : Number(value(a)) - Number(value(b));
            return (ascending ? comparison : -comparison) || a.cells[0].textContent!.localeCompare(b.cells[0].textContent!, "en");
          }));
          if (status) status.textContent = `${table.caption?.textContent}: sorted by ${button.textContent?.replace("↕", "").trim()}, ${ascending ? "ascending" : "descending"}. Statewide totals remain last.`;
        };
        button.addEventListener("click", sort);
        disposers.push(() => button.removeEventListener("click", sort));
      }
    }
  }
  return () => disposers.forEach(dispose => dispose());
}
