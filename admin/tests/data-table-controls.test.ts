import { expect, it } from "vitest";
import { installDataTableControls } from "../../packages/content-core/src/data-table-controls";
import { renderDataTable } from "../../packages/content-core/src/data-table-render";
const data = { title: "County totals", csv: "County,Total\nMercer,10\nEssex,2", source: "Sample data", sourceHref: "" };

function ascendingRows(csv: string): string[] {
  const root = document.createElement("div");
  root.innerHTML = renderDataTable({ ...data, csv });
  const dispose = installDataTableControls(root);
  root.querySelectorAll<HTMLButtonElement>("[data-table-sort]")[1].click();
  const rows = Array.from(root.querySelectorAll("tbody tr"), (row) => row.textContent ?? "");
  dispose();
  return rows;
}

it("keeps search and numeric sorting local to each table", () => {
    const root = document.createElement("div");
    root.innerHTML = renderDataTable(data) + renderDataTable({ ...data, title: "Second table" });
    const dispose = installDataTableControls(root);
    const tables = root.querySelectorAll(".cms-data-table");
    const first = tables[0];
    const search = first.querySelector("input")!;
    search.value = "MERCER";
    search.dispatchEvent(new Event("input"));
    expect(first.querySelector('[role="status"]')?.textContent).toBe("1 of 2 rows");
    expect(tables[1].querySelector('[role="status"]')?.textContent).toBe("2 of 2 rows");
    const sort = first.querySelectorAll<HTMLButtonElement>("[data-table-sort]")[1];
    sort.click();
    expect(first.querySelector("tbody tr")?.textContent).toBe("Essex2");
    expect(first.querySelector("tbody tr")?.hasAttribute("hidden")).toBe(true);
    expect(first.querySelector('th[aria-sort="ascending"]')?.textContent).toContain("Total");
    sort.click();
    expect(first.querySelector("tbody tr")?.textContent).toBe("Mercer10");
    expect(tables[1].querySelector("tbody tr")?.textContent).toBe("Mercer10");
    dispose();
});

it.each([
  ["grouped numbers", 'Name,Value\nLower,900\nHigher,"1,000"', ["Lower900", "Higher1,000"]],
  ["dollars", 'Name,Value\nLower,$900.50\nHigher,"$1,000.25"', ["Lower$900.50", "Higher$1,000.25"]],
  ["pounds", 'Name,Value\nLower,£900.50\nHigher,"£1,000.25"', ["Lower£900.50", "Higher£1,000.25"]],
  ["euros", 'Name,Value\nLower,€900.50\nHigher,"€1,000.25"', ["Lower€900.50", "Higher€1,000.25"]],
  ["percentages", "Name,Value\nLower,9.5%\nHigher,10%", ["Lower9.5%", "Higher10%"]],
  ["signed decimals", "Name,Value\nLower,-1.5\nHigher,+0.5", ["Lower-1.5", "Higher+0.5"]],
])("sorts %s by normalized numeric value", (_label, csv, expected) => {
  expect(ascendingRows(csv)).toEqual(expected);
});

it("leaves malformed English grouping on the text sort path", () => {
  expect(ascendingRows('Name,Value\nText first,"10,00"\nText second,900')).toEqual([
    "Text first10,00",
    "Text second900",
  ]);
});

it("does not compare different currencies as one numeric unit", () => {
  expect(ascendingRows("Name,Value\nDollar,$10\nEuro,€2")).toEqual([
    "Dollar$10",
    "Euro€2",
  ]);
});
