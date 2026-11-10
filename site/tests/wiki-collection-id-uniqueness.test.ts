// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@astrojs/markdown-remark";
import { slug as githubSlug } from "github-slugger";

// The `wiki` content collection loads the OKF bundle at the repo root with
// `glob({ pattern: "**/*.md", base: "../wiki" })`. Astro's glob loader derives
// each entry's id from a truthy frontmatter `slug`, or otherwise from its path:
// drop the extension, github-slug every path segment, then strip a trailing
// `/index`. When two files derive the same id the loader keeps only the one it
// reads last and the earlier doc silently vanishes from the build. That
// silent-overwrite is the real risk this guards.
//
// It is not the same thing as the "Duplicate id" warning `astro sync` prints
// against a stale `.astro/data-store.json`: a file that changed since the last
// sync collides with its own persisted entry, so the warning fires for edited
// docs even though their ids are unique. A cold sync (no `.astro`) shows none,
// and CI (fresh `npm ci`) never has a warm store, so that warning is dev-only
// noise, not evidence of a collision. This test is the reliable check instead:
// it proves every wiki doc owns a unique id today and fails loudly the day a
// real collision lands (for example adding both `resources/assets.md` and a
// `resources/assets/index.md`, which both derive `.../resources/assets`).

const wikiRoot = fileURLToPath(new URL("../../wiki", import.meta.url));

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

// Mirror Astro's glob loader `generateIdDefault`: a truthy frontmatter slug wins;
// otherwise derive the id from the relative path by dropping the extension,
// github-slugging each segment, and stripping a trailing `/index`.
function globLoaderId(absPath: string, contents = readFileSync(absPath, "utf8")): string {
  const { frontmatter } = parseFrontmatter(contents, { frontmatter: "empty-with-spaces" });
  if (frontmatter.slug) return frontmatter.slug;

  const relative = path.relative(wikiRoot, absPath);
  const withoutExt = relative.replace(new RegExp(path.extname(relative) + "$"), "");
  return withoutExt
    .split(path.sep)
    .map((segment) => githubSlug(segment))
    .join("/")
    .replace(/\/index$/, "");
}

describe("wiki collection ids", () => {
  const files = markdownFiles(wikiRoot);

  it("finds the wiki bundle", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("matches Astro's id derivation on known wiki docs", () => {
    const cases: Array<[string, string]> = [
      ["systems/media-manager-api/resources/index.md", "systems/media-manager-api/resources"],
      ["systems/media-manager-api/resources/assets.md", "systems/media-manager-api/resources/assets"],
      ["systems/station-manager-api/console.md", "systems/station-manager-api/console"],
    ];
    for (const [rel, expected] of cases) {
      expect(globLoaderId(path.join(wikiRoot, rel), "")).toBe(expected);
    }
  });

  it("uses slug frontmatter before the path-derived id", () => {
    const frontmatterId = globLoaderId(
      path.join(wikiRoot, "example/source.md"),
      "---\nslug: example/target\n---\n",
    );
    const pathId = globLoaderId(path.join(wikiRoot, "example/target.md"), "");
    expect(frontmatterId).toBe(pathId);
  });

  it("derives a unique glob-loader id for every wiki markdown file", () => {
    const byId = new Map<string, string[]>();
    for (const file of files) {
      const id = globLoaderId(file);
      const rel = path.relative(wikiRoot, file);
      byId.set(id, [...(byId.get(id) ?? []), rel]);
    }
    // Report every colliding id with the files that share it, so a failure names
    // exactly which docs would silently overwrite each other.
    const collisions = [...byId.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([id, paths]) => `${id} <- ${paths.join(", ")}`);
    expect(collisions).toEqual([]);
  });
});
