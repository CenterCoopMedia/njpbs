import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureCmsLoader } from "../scripts/measure-cms-loader";
import { PUBLIC_PAGE_IDS } from "../../packages/content-core/src/public-pages";

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessSource = readFileSync(
  path.join(here, "..", "scripts", "measure-cms-loader.ts"),
  "utf8",
);
const contentConfigSource = readFileSync(
  path.join(here, "..", "src", "content.config.ts"),
  "utf8",
);

// The harness cannot import src/content.config.ts: that file depends on the
// `astro:content` virtual module, which only exists inside a build. It therefore
// keeps a hand-copied mirror of the cmsPages schema. A measurement of the
// validation cost is only worth anything if the schema it times is the schema
// the build actually runs, so the mirror is pinned textually rather than trusted.
function balancedEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(" || character === "{") depth += 1;
    if (character === ")" || character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error(`unterminated literal at offset ${start}`);
}

// Reads the whole initializer, chained modifiers included. Stopping at the first
// balanced paren would drop a trailing `.loose()`, which is exactly the kind of
// difference that would let the harness time a stricter or looser schema than the
// build runs while the parity test still passed.
function schemaBody(source: string, marker: string, from = 0): string {
  const markerAt = source.indexOf(marker, from);
  if (markerAt < 0) throw new Error(`marker not found: ${marker}`);
  // Both files wrap `z\n  .object(` at some declarations, so this cannot match a
  // literal `"z.object("`. A plain string search skipped past those to the next
  // unrelated schema in the file and compared the wrong pair.
  const opener = /\bz\s*\.\s*object\s*\(/.exec(source.slice(markerAt));
  if (!opener) throw new Error(`no schema literal after: ${marker}`);
  const start = markerAt + opener.index;
  let end = balancedEnd(source, start);
  for (;;) {
    const chained = /^\s*\.\s*[A-Za-z_$][\w$]*\s*\(/.exec(source.slice(end));
    if (!chained) break;
    end = balancedEnd(source, end + chained[0].length - 1);
  }
  return source.slice(start, end).replace(/\s+/g, "");
}

function cmsPagesSchemaBody(source: string): string {
  const collectionAt = source.indexOf("const cmsPages = defineCollection(");
  if (collectionAt < 0) throw new Error("the cmsPages collection was not found");
  return schemaBody(source, "schema:", collectionAt);
}

describe("CMS loader measurement harness", () => {
  it("mirrors the cmsPages schema the real build validates against", () => {
    expect(schemaBody(harnessSource, "const cmsPagesSchema =")).toBe(
      cmsPagesSchemaBody(contentConfigSource),
    );
  });

  it("mirrors the search and social metadata schemas", () => {
    for (const marker of ["const searchMetadata =", "const socialMetadata ="]) {
      expect(schemaBody(harnessSource, marker)).toBe(
        schemaBody(contentConfigSource, marker),
      );
    }
  });

  it("times every loader phase over the committed canonical compositions", async () => {
    const result = await measureCmsLoader({ runs: 3, inflate: 1 });
    // Pinned to the registry, not merely non-zero: a canonical page that lost its
    // composition seed would otherwise shrink the corpus silently and make the
    // loader look cheaper than it is.
    expect(result.pages).toBe(PUBLIC_PAGE_IDS.length);
    expect(result.blocks).toBeGreaterThan(result.pages);
    for (const phase of Object.values(result.phases)) {
      expect(phase).toBeGreaterThanOrEqual(0);
    }
    expect(result.skippable).toBe(result.phases.validate + result.phases.storeWrite);
    expect(result.digestCost).toBe(result.phases.serialize + result.phases.hash);
    // The net is paired within each run, so it lies inside the observed per-run
    // range. Deriving it by subtracting independent medians would not have to.
    expect(result.netSaving).toBeGreaterThanOrEqual(result.netSavingRange.worst);
    expect(result.netSaving).toBeLessThanOrEqual(result.netSavingRange.best);
    expect(result.runsWhereDigestWins).toBeLessThanOrEqual(result.runs);
  });

  it("keeps chained schema modifiers inside the compared initializer", () => {
    const sample = 'const socialMetadata = z\n  .object({ a: z.string() })\n  .loose();\n';
    expect(schemaBody(sample, "const socialMetadata =")).toBe(
      "z.object({a:z.string()}).loose()",
    );
  });

  it("reports every canonical page as projectable, so no page is silently unmeasured", async () => {
    const withoutInflation = await measureCmsLoader({ runs: 1, inflate: 1 });
    const inflated = await measureCmsLoader({ runs: 1, inflate: 4 });
    expect(inflated.pages).toBe(withoutInflation.pages);
    expect(inflated.blocks).toBe(withoutInflation.blocks);
  });
});
