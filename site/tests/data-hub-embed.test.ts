// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { dataHubEmbedPages, type FigureEmbedPage } from "../src/lib/data-hub-embed-pages";
import { serveDataHubEmbed } from "../../packages/content-core/src/data-hub-embed";
import { classify } from "../src/lib/legacy-redirects";
import snapshot from "../src/data/data-hub-revisions/2026-11-09.json";

const hub = readFileSync(new URL("../src/data/njpbs-data-hub-v16.html", import.meta.url), "utf8");
let pages: FigureEmbedPage[];
const pathFor = (page: FigureEmbedPage) => `/data/figures/${page.id}/embed/${page.snapshot ? page.snapshot + "/" : ""}`;
const request = async (path: string, method = "GET") => serveDataHubEmbed(new Request(`https://njpbs.org${path}`, { method }), async asset => {
  if (new URL(asset.url).pathname === "/data-hub/") return new Response(hub, { headers: { "content-type": "text/html" } });
  const page = pages.find(page => pathFor(page) === new URL(asset.url).pathname);
  // The Assets boundary includes ordinary shell/cookie/frame headers. None may leak into embeds.
  return new Response(page?.html ?? "Site 404 with analytics", { status: page ? 200 : 404, headers: {
    "content-type": "text/html; charset=utf-8", "set-cookie": "njpbs-consent=fixture", "x-frame-options": "SAMEORIGIN",
  } });
});

beforeAll(async () => { pages = await dataHubEmbedPages({ DATA_HUB_PUBLIC: "1" }); });

describe("public Data Hub figure embeds (#5093)", () => {
  it("emits no routes when the Data Hub is excluded", async () => {
    expect(await dataHubEmbedPages({})).toEqual([]);
    expect(await dataHubEmbedPages({ DATA_HUB_PUBLIC: "1", PUBLIC_ONLY: "1" })).toEqual([]);
  });

  it("serves both views of every published figure with and without a pinned date", async () => {
    expect(snapshot.metrics).toHaveLength(18);
    for (const metric of snapshot.metrics) {
      for (const view of ["chart", "number"]) {
        const response = (await request(`/data/figures/${metric.id}/embed/?view=${view}&revision=2026-11-09`))!;
        expect(response.status, metric.id).toBe(200);
        const html = await response.text();
        expect(html).not.toMatch(/(?:background|color|fill|stroke):\s*[;}]/);
        const window = new Window();
        try {
          window.document.write(html);
          expect(window.document.title).toContain(metric.title);
          expect(window.document.querySelector(`a[href="${metric.sourceUrl}"]`), metric.id).not.toBeNull();
          expect(window.document.querySelector('a[href="https://njpbs.org/data-hub/"]')?.textContent).toContain("NJ PBS");
          expect(window.document.querySelector('time[datetime="2026-11-09"]')).not.toBeNull();
          expect(window.document.querySelectorAll("script,iframe,img,form")).toHaveLength(0);
          if (view === "chart") expect(window.document.querySelector("svg, .bars, table, .v10-benchmark"), metric.id).not.toBeNull();
        } finally { await window.happyDOM.close(); }
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(response.headers.has("x-frame-options")).toBe(false);
        expect(response.headers.has("content-security-policy-report-only")).toBe(false);
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors *");
        expect(html).not.toMatch(/google-analytics|googletagmanager|wisepops|document\.cookie/);
      }
    }
    for (const page of pages.filter(page => page.snapshot === undefined || page.snapshot === "number")) {
      const view = page.snapshot ?? "chart";
      const response = (await request(`/data/figures/${page.id}/embed/?view=${view}`))!;
      expect(response.status, page.id).toBe(200);
      expect(await response.text(), page.id).toBe(page.html);
    }
  });

  it("keeps dated source values independent from later latest documents", async () => {
    const current = pages.find(page => page.id === "unemployment" && page.snapshot === undefined)!;
    const frozen = pages.find(page => page.id === "unemployment" && page.snapshot === "2026-11-25/chart")!;
    expect(current.html).toBe(frozen.html);
    const original = current.html;
    try {
      current.html = "A later approved data release";
      expect(await (await request("/data/figures/unemployment/embed/"))!.text()).toBe(current.html);
      expect(await (await request("/data/figures/unemployment/embed/?revision=2026-11-25"))!.text()).toBe(original);
    } finally { current.html = original; }
  });

  it.each(["missing", "unknown_figure", "unemployment?revision=2099-01-01", "unemployment?revision=PUBLISHED_REVISION_ID", "unemployment?view=invalid"])("returns a script-free 404 for %s", async input => {
    const [id, query] = input.split("?");
    const response = (await request(`/data/figures/${id}/embed/${query ? "?" + query : ""}`))!;
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Figure not found");
    expect(html.match(/href="[^"]*"/g)).toEqual(['href="https://njpbs.org/data-hub/"']);
  });

  it("supports HEAD, refuses writes, and leaves other routes to their owners", async () => {
    const response = (await request("/data/figures/unemployment/embed/", "HEAD"))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect((await request("/data/figures/unemployment/embed/", "POST"))!.status).toBe(405);
    expect(serveDataHubEmbed(new Request("https://njpbs.org/contact/"), async () => { throw new Error("Unrelated route fetched"); })).toBeNull();
    expect(await request("/data-hub/")).toBeNull();
    expect(classify("/data/figures/unemployment/embed/")).toBeNull();
    expect(classify("/data/figures/missing/embed/")).toBeNull();
    expect(classify("/data/figures/unknown_figure/embed/")).toBeNull();
    expect(classify("/old-wordpress-post/embed/")).toEqual({ action: "gone", cacheControl: "no-store" });
  });
});
