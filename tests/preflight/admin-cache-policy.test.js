import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HEADERS = fileURLToPath(
  new URL("../../admin/public/_headers", import.meta.url),
);
const REDIRECTS = fileURLToPath(
  new URL("../../admin/public/_redirects", import.meta.url),
);
const INDEX = fileURLToPath(
  new URL("../../admin/index.html", import.meta.url),
);

function parseHeaderBlocks(source) {
  const blocks = new Map();
  let currentPattern = null;

  for (const rawLine of String(source).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!/^\s/.test(rawLine)) {
      currentPattern = trimmed;
      if (!blocks.has(currentPattern)) blocks.set(currentPattern, []);
      continue;
    }

    if (!currentPattern || trimmed.startsWith("!")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    blocks.get(currentPattern).push({
      name: trimmed.slice(0, separator).trim().toLowerCase(),
      value: trimmed.slice(separator + 1).trim().toLowerCase(),
    });
  }

  return blocks;
}

function cacheDirectives(blocks, pattern) {
  return new Set(
    (blocks.get(pattern) ?? [])
      .filter((header) => header.name === "cache-control")
      .flatMap((header) => header.value.split(","))
      .map((directive) => directive.trim())
      .filter(Boolean),
  );
}

// Pages combines all matching header rules. A retained route splat also covers
// its explicit child redirects, without duplicate rules consuming the 100-rule cap.
function effectiveCacheDirectives(blocks, pathname) {
  const matching = [...blocks.keys()].filter(pattern => {
    if (pattern === pathname) return true;
    if (pattern.endsWith("/*") && pathname.startsWith(pattern.slice(0, -1))) return true;
    return pattern.endsWith("*") && pathname.startsWith(pattern.slice(0, -1));
  });
  return new Set(matching.flatMap(pattern => [...cacheDirectives(blocks, pattern)]));
}

function redirectPatterns(source) {
  return String(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]);
}

function linkAttributes(tag) {
  const attributes = new Map();
  const body = tag.replace(/^<\s*link\b/i, "").replace(/\/?>\s*$/i, "");
  const pattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  for (const match of body.matchAll(pattern)) {
    attributes.set(
      match[1].toLowerCase(),
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }

  return attributes;
}

describe("Admin static delivery cache policy", () => {
  const headersSource = readFileSync(HEADERS, "utf8");
  const redirectsSource = readFileSync(REDIRECTS, "utf8");
  const blocks = parseHeaderBlocks(headersSource);

  it("keeps the shell, status receipt, and every SPA rewrite out of caches", () => {
    const noStorePatterns = new Set([
      "/",
      "/index.html",
      "/404.html",
      "/admin-status.json",
      ...redirectPatterns(redirectsSource),
    ]);

    for (const pattern of noStorePatterns) {
      const directives = effectiveCacheDirectives(blocks, pattern);
      expect(directives, pattern).toContain("private");
      expect(directives, pattern).toContain("no-store");
      expect(directives, pattern).not.toContain("public");
      expect(directives, pattern).not.toContain("immutable");
    }
  });

  it("keeps Cache-Control off the global rule so asset policies are not combined with no-store", () => {
    expect(cacheDirectives(blocks, "/*").size).toBe(0);
  });

  it("keeps immutable asset rules out of the source headers", () => {
    expect(blocks.has("/assets/*")).toBe(false);
    expect(headersSource).not.toMatch(/^\/assets\/\*$/m);
    expect([...blocks.keys()].filter(pattern => cacheDirectives(blocks, pattern).has("immutable"))).toEqual([]);
    // The build adds one /assets/* rule after checking emitted fingerprints.
    // The build and middleware tests verify that missing files, errors and HTML
    // responses do not keep immutable caching.
  });

  it("uses bounded revalidation for stable-name brand assets", () => {
    for (const pattern of ["/brand/*.svg"]) {
      const directives = cacheDirectives(blocks, pattern);
      expect(directives, pattern).toContain("public");
      expect(directives, pattern).toContain("max-age=604800");
      expect(directives, pattern).toContain("stale-while-revalidate=86400");
      expect(directives, pattern).not.toContain("immutable");
    }

    const favicon = cacheDirectives(blocks, "/favicon.png");
    expect(favicon).toContain("public");
    expect(favicon).toContain("max-age=86400");
    expect(favicon).toContain("stale-while-revalidate=604800");
  });


});
