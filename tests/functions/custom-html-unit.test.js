import { expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { changesCustomHtml } = require("../../functions/lib/custom-html");
const html = { id: "html-one", type: "html", order: 0, visible: true,
  data: { html: "<p>Results</p>", title: "Results" } };

it("keeps hidden HTML visibility, row moves and safe removal controls gated", () => {
  const hidden = { ...html, visible: false };
  expect(changesCustomHtml([hidden], [html])).toBe(true);
  expect(changesCustomHtml([hidden], [structuredClone(hidden)])).toBe(false);
  expect(changesCustomHtml([html], [{ ...html, data: { ...html.data, title: "Changed" } }])).toBe(true);
  expect(changesCustomHtml([html], [hidden])).toBe(false);
  expect(changesCustomHtml([html], [{ ...html, order: 1, layout: { rowId: "row-one", column: 1 } }])).toBe(false);
  expect(changesCustomHtml([html], [])).toBe(false);
  const divider = { id: "divider-one", type: "divider", visible: false, data: {} };
  expect(changesCustomHtml([divider], [{ ...divider, visible: true }, { ...divider, id: "divider-copy" }])).toBe(false);

  const hiddenRow = { id: "row-hidden", type: "row", order: 0, visible: false, data: { columns: [12] } };
  const child = { ...html, order: 1, layout: { rowId: hiddenRow.id, column: 0 } };
  const visibleRow = { ...hiddenRow, id: "row-visible", order: 1, visible: true };
  expect(changesCustomHtml([hiddenRow, child], [{ ...hiddenRow, visible: true }, child])).toBe(true);
  expect(changesCustomHtml([hiddenRow, child], [hiddenRow, { ...child, layout: undefined }])).toBe(true);
  expect(changesCustomHtml([hiddenRow, child, { ...visibleRow, order: 2 }],
    [hiddenRow, visibleRow, { ...child, order: 2, layout: { rowId: visibleRow.id, column: 0 } }])).toBe(true);
  expect(changesCustomHtml([{ ...hiddenRow, visible: true }, child], [hiddenRow, child])).toBe(false);
  const otherHiddenRow = { ...visibleRow, visible: false };
  expect(changesCustomHtml([hiddenRow, child, { ...otherHiddenRow, order: 2 }],
    [hiddenRow, otherHiddenRow, { ...child, order: 2, layout: { rowId: otherHiddenRow.id, column: 0 } }])).toBe(false);
  const hiddenChild = { ...child, visible: false };
  expect(changesCustomHtml([hiddenRow, hiddenChild], [{ ...hiddenRow, visible: true }, hiddenChild])).toBe(false);
  expect(changesCustomHtml([hiddenRow, hiddenChild], [hiddenRow, child])).toBe(true);
});
