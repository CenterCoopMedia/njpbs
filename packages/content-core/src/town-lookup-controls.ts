/** Enhance the complete HTML tables; no data requests or third-party scripts. */
export function installTownLookupControls(root: ParentNode): void {
  for (const lookup of root.querySelectorAll<HTMLElement>(".town-lookup")) {
    if (lookup.dataset.townLookupReady) continue;
    const search = lookup.querySelector<HTMLFormElement>(".town-lookup__search");
    const input = search?.querySelector<HTMLInputElement>("input");
    const list = search?.querySelector<HTMLDataListElement>("datalist");
    const status = lookup.querySelector<HTMLElement>(".town-lookup__status");
    const selected = lookup.querySelector<HTMLElement>(".town-lookup__selected");
    const results = lookup.querySelector<HTMLElement>(".town-lookup__results");
    const all = lookup.querySelector<HTMLTableElement>(".town-lookup__all table");
    const map = lookup.querySelector<SVGElement>("svg");
    const path = map?.querySelector<SVGPathElement>(".town-lookup__highlight");
    const marker = map?.querySelector<SVGCircleElement>("circle");
    const caption = lookup.querySelector<HTMLElement>("figcaption");
    if (!search || !input || !list || !status || !selected || !results || !all || !map || !path || !marker || !caption) continue;
    const rows = Array.from(all.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    const headings = Array.from(all.querySelectorAll<HTMLTableCellElement>("thead th")).slice(1);
    const normalize = (text: string) => text.trim().toLocaleLowerCase("en-US");
    const labels = rows.map(row => ({ row, label: row.dataset.townLabel ?? "" }));
    list.replaceChildren(...labels.map(({ label }) => {
      const option = document.createElement("option");
      option.value = label;
      return option;
    }));
    function clearSelection(): void {
      selected!.hidden = true;
      results!.replaceChildren();
      status!.textContent = "Choose a municipality and county, then select Show results.";
    }
    search.addEventListener("submit", event => {
      event.preventDefault();
      const query = normalize(input.value);
      // Match the complete county-qualified identity; a partial or duplicate name
      // never selects the first municipality with that name.
      const town = labels.find(({ label }) => normalize(label) === query);
      if (!town) {
        clearSelection();
        status.textContent = "No exact match. Choose the full municipality and county from the suggestions, then select Show results.";
        return;
      }
      const table = document.createElement("table");
      const title = table.createCaption();
      title.textContent = town.label;
      const header = table.createTHead().insertRow();
      for (const text of ["Election and source", "Vote shares or turnout"]) {
        const th = document.createElement("th");
        th.scope = "col";
        th.textContent = text;
        header.append(th);
      }
      const body = table.createTBody();
      Array.from(town.row.querySelectorAll<HTMLTableCellElement>("[data-town-figure]")).forEach((cell, index) => {
        const tr = body.insertRow();
        const th = document.createElement("th");
        th.scope = "row";
        th.append(...Array.from(headings[index].childNodes).map(node => node.cloneNode(true)));
        tr.append(th, cell.cloneNode(true));
      });
      results.replaceChildren(table);
      path.setAttribute("d", town.row.dataset.townPath ?? "");
      const [x, y] = (town.row.dataset.townMarker ?? "").split(" ");
      marker.setAttribute("cx", x);
      marker.setAttribute("cy", y);
      map.setAttribute("aria-label", `${town.label}, highlighted in New Jersey`);
      caption.textContent = town.label;
      selected.hidden = false;
      status.textContent = `Showing past results for ${town.label}.`;
    });
    input.addEventListener("input", clearSelection);
    lookup.dataset.townLookupReady = "true";
    search.hidden = false;
    status.hidden = false;
    clearSelection();
  }
}
