import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import * as pagefind from "pagefind";
import { decodePagefindFragment } from "../src/lib/pagefind-index";
import { dataHubPageEnabled } from "../src/lib/build-target";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

function countMain(node: DefaultTreeAdapterMap["node"]): number {
  return ("tagName" in node && node.tagName === "main" ? 1 : 0)
    + ("childNodes" in node ? node.childNodes.reduce((sum, child) => sum + countMain(child), 0) : 0);
}

// Portable-figure templates in script text contain their own robots strings.
function countRobots(node: DefaultTreeAdapterMap["node"]): number {
  const isRobots = "tagName" in node && node.tagName === "meta"
    && node.attrs.some(attr => attr.name === "name" && attr.value === "robots");
  return (isRobots ? 1 : 0)
    + ("childNodes" in node ? node.childNodes.reduce((sum, child) => sum + countRobots(child), 0) : 0);
}

describe("Data Hub HTML route emission", () => {
  it("emits the public route only with its launch flag outside rollback", async () => {
    const route = `${dist}data-hub/index.html`;
    if (!dataHubPageEnabled(process.env)) {
      expect(existsSync(`${dist}data-hub`)).toBe(false);
      return;
    }

    expect(existsSync(route)).toBe(true);
    const html = readFileSync(route, "utf8");
    // Approved public indexing: #3793, issuecomment-6319252336.
    expect(countRobots(parse(html))).toBe(0);
    const headers = readFileSync(`${dist}_headers`, "utf8");
    expect(headers).not.toMatch(/^\/data-hub(?:\/\*)?$/m);
    expect(readFileSync(`${dist}sitemap-0.xml`, "utf8"))
      .toContain("<loc>https://njpbs.org/data-hub/</loc>");
    expect(html).toContain('class="data-hub"');
    expect(html).not.toContain('Editorial design preview — not published on NJ PBS');
    expect(html).toContain('Published on NJ PBS. Downloads preserve this dated source snapshot.');
    expect(html).not.toContain('data-pagefind-body');
    expect(countMain(parse(html))).toBe(1);
    expect(html).not.toMatch(/staff-mode-toggle|editor-dialog|figure-cms-panel/);

    // Pagefind excludes unmarked pages when the public index has body markers.
    const { index } = await pagefind.createIndex();
    if (!index) throw new Error("Pagefind index was not created");
    try {
      await index.addHTMLFile({ url: "/data-hub/", content: html });
      await index.addHTMLFile({ url: "/about/", content:
        '<html lang="en"><body><main data-pagefind-body>Public station information</main></body></html>' });
      const result = await index.getFiles();
      expect(result.errors).toEqual([]);
      expect(result.files?.filter(file => file.path.includes("fragment/"))
        .map(file => decodePagefindFragment(file.content).url)).toEqual(["/about/"]);
    } finally {
      await index.deleteIndex();
      await pagefind.close();
    }
  });
});
