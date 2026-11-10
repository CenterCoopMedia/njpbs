import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const siteRoot = process.cwd();
const repositoryRoot = join(siteRoot, "..");

const rulesForSelectors = (source: string, targetSelectors: Set<string>) =>
  (source.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+\{[^{}]*\}/g) ?? []).filter((rule) => {
    const selectorList = rule.slice(0, rule.indexOf("{"));
    return selectorList
      .split(",")
      .some((selector) => targetSelectors.has(selector.trim()));
  });

function siteStyleSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return siteStyleSources(path);
    return /\.(?:astro|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("full page title width", () => {
  it("does not cap any Site h1 at a fixed narrow width", () => {
    const narrowTitles = siteStyleSources(join(siteRoot, "src")).flatMap((path) => {
      const h1Rules = readFileSync(path, "utf8").match(/[^{}]*\bh1\b[^{}]*\{[^{}]*\}/g) ?? [];
      return h1Rules
        .filter((rule) => /(?:max-width|max-inline-size|width|inline-size)\s*:\s*[^;}]*(?:[\d.]+(?:rem|ch))\b/.test(rule))
        .map((rule) => `${relative(siteRoot, path)}: ${rule.trim()}`);
    });

    expect(narrowTitles).toEqual([]);
  });

  it("does not reserve an empty side column beside default page summaries or body text", () => {
    const owners = [
      ["components/PublicArticle.astro", [".public-article__head-inner > span"]],
      ["components/ProgramPage.astro", [".program__body", ".program__watch"]],
      ["components/PostPage.astro", [".post-head__summary", ".post-body"]],
      ["components/StaffDirectory.astro", [".staff-directory__lead"]],
      ["components/AuthorPage.astro", [".author-identity__bio"]],
      ["components/SpecialReportPost.astro", [".special-report__summary", ".special-report__body"]],
      ["components/MultimediaFeaturePost.astro", [".multimedia-feature__summary", ".multimedia-feature__body"]],
      ["components/InteractiveDataPost.astro", [".interactive-data__summary", ".interactive-data__body"]],
      ["components/HomeHero.astro", [".home-hero__summary"]],
      ["components/PostIndex.astro", [".post-index__intro"]],
      ["styles/service-page.css", [".public-page__hero p", ".public-page__copy"]],
      ["styles/public-site.css", [".page-hero__lead"]],
      ["styles/admin-docs.css", [".admin-docs-article-header", ".admin-docs-prose"]],
      ["pages/coverage/[...coverage].astro", [".coverage-notes p"]],
    ] as const;

    for (const [file, selectors] of owners) {
      const source = readFileSync(join(siteRoot, "src", file), "utf8");
      for (const selector of selectors) {
        const rules = rulesForSelectors(source, new Set([selector]));
        expect(rules.length, `${file}: ${selector}`).toBeGreaterThan(0);
        expect(rules.join("\n"), `${file}: ${selector}`).not.toMatch(
          /(?:max-width|max-inline-size|width|inline-size)\s*:\s*[^;}]*(?:[\d.]+(?:rem|ch))\b/,
        );
      }
    }
  });

  it("lets the Boardwalk guide title use the article width", () => {
    const source = readFileSync(
      join(repositoryRoot, "admin", "src", "routes", "BoardwalkGuideRoute.css"),
      "utf8",
    );
    const titleHeaderRules = rulesForSelectors(source, new Set([
      ".admin-guide-article > header",
      ".admin-guide-article > header h2",
    ]));

    expect(titleHeaderRules.join("\n")).not.toMatch(/(?:max-width|max-inline-size)\s*:/);
  });

  it("gives program titles and body the shared page frame", () => {
    const source = readFileSync(
      join(siteRoot, "src", "components", "ProgramPage.astro"),
      "utf8",
    );
    const frame = source.match(/\.program\s*\{[^}]+\}/)?.[0] ?? "";
    const body = rulesForSelectors(source, new Set([
      ".program__body",
      ".program__watch",
    ])).join("\n");

    expect(frame).toMatch(/max-width:\s*var\(--wrap\)/);
    expect(frame).toMatch(/padding:[^;]*var\(--gutter\)/);
    expect(body).not.toMatch(/max-width:\s*[\d.]+(?:rem|ch)/);
  });

  it("gives text Post titles and body the shared frame", () => {
    const source = readFileSync(
      join(siteRoot, "src", "components", "PostPage.astro"),
      "utf8",
    );
    const masthead = rulesForSelectors(source, new Set([
      ".post--text .post-masthead__inner",
    ])).join("\n");
    const content = rulesForSelectors(source, new Set([
      ".post--text .post-content",
    ])).join("\n");

    expect(masthead).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(masthead).toMatch(/justify-content:\s*start/);
    expect(content).toBe("");
    expect(source).toMatch(/\.post-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
