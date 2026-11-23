import { renderTownElectionTrends, type TrendCounts, type TrendSources } from "./town-election-trends.ts";

/** Enhance the complete HTML tables; no data requests or third-party scripts. */
export function installTownLookupControls(root: ParentNode): void {
  for (const lookup of root.querySelectorAll<HTMLElement>(".town-lookup")) {
    if (lookup.dataset.townLookupReady) continue;
    const search = lookup.querySelector<HTMLFormElement>(".town-lookup__search");
    const input = search?.querySelector<HTMLInputElement>("input");
    const submit = search?.querySelector<HTMLButtonElement>('button[type="submit"]');
    const list = search?.querySelector<HTMLDataListElement>("datalist");
    const status = lookup.querySelector<HTMLElement>(".town-lookup__status");
    const selected = lookup.querySelector<HTMLElement>(".town-lookup__selected");
    const results = lookup.querySelector<HTMLElement>(".town-lookup__results");
    const trends = lookup.querySelector<HTMLElement>(".town-trends__content");
    const all = lookup.querySelector<HTMLTableElement>(".town-lookup__all table");
    const map = lookup.querySelector<SVGElement>("svg");
    const path = map?.querySelector<SVGPathElement>(".town-lookup__highlight");
    const marker = map?.querySelector<SVGCircleElement>("circle");
    const caption = lookup.querySelector<HTMLElement>("figcaption");
    if (!search || !input || !submit || !list || !status || !selected || !results || !all || !map || !path || !marker || !caption) continue;
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
      trends?.replaceChildren();
      status!.textContent = "Choose a municipality and county, then select Show results.";
    }
    const showResults = (event: Event) => {
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
      const id = town.row.dataset.townId;
      const counts = town.row.dataset.townTrends;
      if (trends && id && counts && lookup.dataset.trendSources) {
        const sources = JSON.parse(lookup.dataset.trendSources) as Record<string, TrendSources>;
        trends.innerHTML = renderTownElectionTrends(town.label, id, JSON.parse(counts) as TrendCounts, sources[id.slice(0, 2)]);
      }
      path.setAttribute("d", town.row.dataset.townPath ?? "");
      const [x, y] = (town.row.dataset.townMarker ?? "").split(" ");
      marker.setAttribute("cx", x);
      marker.setAttribute("cy", y);
      map.setAttribute("aria-label", `${town.label}, highlighted in New Jersey`);
      caption.textContent = town.label;
      selected.hidden = false;
      status.textContent = `Showing past results for ${town.label}.`;
    };
    // The staff preview sandbox blocks native form submission. The button also
    // handles implicit keyboard activation while leaving the sandbox in place.
    submit.addEventListener("click", showResults);
    search.addEventListener("submit", showResults);
    input.addEventListener("input", clearSelection);
    lookup.dataset.townLookupReady = "true";
    search.hidden = false;
    status.hidden = false;
    clearSelection();
  }
}
