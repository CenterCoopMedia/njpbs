import { describe, expect, it } from "vitest";
import { normalizeGeneratedIds } from "../src/lib/visual-id-normalization";

function fixture(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("normalizeGeneratedIds", () => {
  it("keeps aria and form references pointing at the same element", () => {
    const host = fixture(`
      <div aria-labelledby=":r0:" aria-describedby=":r1: static-note">
        <h2 id=":r0:">Filters</h2>
        <p id=":r1:">Narrow the list.</p>
        <label for=":r4:">Title</label>
        <input id=":r4:" />
      </div>
    `);
    normalizeGeneratedIds(host);
    const labelled = host.querySelector("div")?.getAttribute("aria-labelledby");
    expect(labelled).toBe(host.querySelector("h2")?.id);
    expect(host.querySelector("div")?.getAttribute("aria-describedby")).toBe(
      `${host.querySelector("p")?.id} static-note`,
    );
    expect(host.querySelector("label")?.getAttribute("for")).toBe(
      host.querySelector("input")?.id,
    );
  });

  it("does not touch ids the admin authored", () => {
    const host = fixture(`
      <h1 id="page-title">Home</h1>
      <div id="block-hero" aria-labelledby="page-title"></div>
    `);
    const result = normalizeGeneratedIds(host);
    expect(result.replaced).toBe(0);
    expect(host.querySelector("h1")?.id).toBe("page-title");
    expect(host.querySelector("div")?.getAttribute("aria-labelledby")).toBe(
      "page-title",
    );
  });

  it("produces the same mapping whatever counter the render started from", () => {
    const first = fixture(`<div id=":r0:"><span id=":r1:"></span></div>`);
    const second = fixture(`<div id=":r12:"><span id=":r13:"></span></div>`);
    normalizeGeneratedIds(first);
    normalizeGeneratedIds(second);
    expect(first.innerHTML).toBe(second.innerHTML);
  });

});
