interface SortableNumber { value: number; unit: string }

function sortableNumber(text: string): SortableNumber | null {
  const match = /^([+-]?)([$£€]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%)?$/.exec(text);
  if (!match) return null;
  const [, sign, currency, integer, fraction = "", percent] = match;
  if (currency && percent) return null;
  const value = Number(`${sign}${integer.replaceAll(",", "")}${fraction}`);
  return Number.isFinite(value) ? { value, unit: currency || percent || "" } : null;
}

/** The full table is present before enhancement. Search and sort never change saved data. */
export function installDataTableControls(root: ParentNode): () => void {
  const cleanup: (() => void)[] = [];
  for (const table of root.querySelectorAll<HTMLElement>(".cms-data-table")) {
    const body = table.querySelector("tbody");
    const input = table.querySelector<HTMLInputElement>('input[type="search"]');
    const status = table.querySelector<HTMLElement>('[role="status"]');
    if (!body || !input || !status) continue;
    const rows = Array.from(body.rows);
    const buttons = Array.from(table.querySelectorAll<HTMLButtonElement>("[data-table-sort]"));
    const filter = () => {
      const query = input.value.trim().toLocaleLowerCase();
      for (const row of rows) row.hidden = !Array.from(row.cells).some((cell) => cell.textContent?.toLocaleLowerCase().includes(query));
      status.textContent = `${rows.filter((row) => !row.hidden).length} of ${rows.length} rows`;
    };
    const sort = (event: Event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>("[data-table-sort]");
      if (!button) return;
      const column = buttons.indexOf(button);
      if (column < 0) return;
      const heading = button.closest("th")!;
      const ascending = heading.getAttribute("aria-sort") !== "ascending";
      for (const other of buttons) other.closest("th")?.removeAttribute("aria-sort");
      heading.setAttribute("aria-sort", ascending ? "ascending" : "descending");
      const cellText = (row: HTMLTableRowElement) => row.cells[column].textContent?.trim() ?? "";
      const numbers = new Map(
        rows.map((row) => [row, sortableNumber(cellText(row))]),
      );
      const unit = numbers.get(rows[0])?.unit;
      const numeric = unit !== undefined && [...numbers.values()].every((number) => number?.unit === unit);
      const sorted = [...rows].sort((a, b) => {
        const left = cellText(a), right = cellText(b);
        const result = numeric ? numbers.get(a)!.value - numbers.get(b)!.value : left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
        return ascending ? result : -result;
      });
      body.append(...sorted);
      filter();
    };
    input.parentElement!.hidden = false;
    status.hidden = false;
    for (const button of buttons) {
      button.hidden = false;
      const label = button.previousElementSibling as HTMLElement | null;
      if (label) label.hidden = true;
    }
    input.addEventListener("input", filter);
    table.addEventListener("click", sort);
    filter();
    cleanup.push(() => { input.removeEventListener("input", filter); table.removeEventListener("click", sort); });
  }
  return () => cleanup.forEach((dispose) => dispose());
}
