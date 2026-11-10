// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { planSupportPageComposition } from "../../packages/content-core/src/support-page-composition";
import { renderBlock, generatedHeadingLevelAt } from "../../packages/content-core/src/content-render";
import { renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { projectCmsPage } from "../src/lib/cms-loader";
import { parseMigrationArgs, parseFirebaseKey, reviewSupportMigration, runSupportMigration } from "../../scripts/migrate-support-page-layout.mts";

const fixturePath = new URL("./fixtures/public-contracts/support-layout.json", import.meta.url);
const before = JSON.parse(readFileSync(fixturePath, "utf8"));
const samOrder = ["fixture-hero-actions", "fixture-transition-notice", "fixture-transition-actions", "fixture-body-copy", "fixture-daf", "fixture-service-destinations"];
const assets = new Map(["give", "passport", "contact"].map(key => [`launch-${key}`, {
  id: `launch-${key}`, url: `https://njpbs.org/brand/spotlight/${key}.jpg`, mimeType: "image/jpeg", width: 640, height: 360,
}]));

describe("support layout migration", () => {
  it("reorders existing template regions around Sam's prose without changing staff payloads", () => {
    const original = structuredClone(before);
    const plan = planSupportPageComposition(before);
    expect(plan.blocks.map(block => block.id)).toEqual(samOrder);
    expect(plan.insertedIds).toEqual([]);
    for (const block of plan.blocks) {
      const previous = original.blocks.find((item: { id: string }) => item.id === block.id);
      expect(block.data).toEqual(previous.data);
      expect(block.visible).toBe(previous.visible);
      expect(block.section).toBeUndefined();
    }
    expect(before).toEqual(original);
  });
  it("inserts captured public defaults only when none of the named template parts exist", () => {
    const daf = before.blocks.find((block: { id: string }) => block.id === "fixture-daf");
    const plan = planSupportPageComposition({ blocks: [{ ...daf, order: 0 }] });
    expect(plan.blocks.map(block => block.id)).toEqual([
      "support-layout-v1-hero-actions", "support-layout-v1-transition-notice", "support-layout-v1-transition-actions",
      "support-layout-v1-checks", "fixture-daf", "support-layout-v1-service-destinations",
    ]);
    expect(plan.blocks[3].data).toMatchObject({ content: { content: expect.arrayContaining([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Prefer to mail a check?" }] },
    ]) } });
    for (const [inserted, captured] of [[0, 0], [1, 1], [2, 2], [3, 3]]) {
      expect(plan.blocks[inserted].data).toEqual(before.blocks[captured].data);
    }
    expect(plan.blocks[5].data).toMatchObject({ cards: before.blocks[4].data.cards.map(({ itemId, ...card }: Record<string, unknown>) => card) });
    expect(plan.blocks[4].data).toEqual(daf.data);
    expect(parseBlocks(plan.blocks).ok).toBe(true);
  });
  it("retains hidden parts and is idempotent after migration, including an empty page", () => {
    const hidden = { ...before, blocks: before.blocks.map((block: { id: string }) => ({ ...block, visible: block.id !== "fixture-body-copy" })) };
    const plan = planSupportPageComposition(hidden);
    expect(plan.blocks.find(block => block.id === "fixture-body-copy")?.visible).toBe(false);
    expect(planSupportPageComposition({ blocks: plan.blocks, serviceCompositionVersion: 1 })).toMatchObject({ changed: false, blocks: plan.blocks });
    expect(planSupportPageComposition({ blocks: [], serviceCompositionVersion: 1 })).toMatchObject({ changed: false, blocks: [] });
  });
  it("refuses partial, duplicate, ambiguous and malformed content instead of replacing edits", () => {
    expect(() => planSupportPageComposition({ blocks: before.blocks.filter((block: { id: string }) => block.id !== "fixture-body-copy") })).toThrow(/Partial/);
    expect(() => planSupportPageComposition({ blocks: [...before.blocks, { ...before.blocks[1], id: "duplicate", order: 6 }] })).toThrow(/Ambiguous/);
    expect(() => planSupportPageComposition({ blocks: [{ ...before.blocks[3], section: undefined }] })).toThrow(/already exist/);
    expect(() => planSupportPageComposition({ blocks: [{ type: "unsupported" }] })).toThrow(/invalid/);
  });
  it("serializer and public groups follow CMS order, including reordered cards and FAQ", () => {
    const plan = planSupportPageComposition(before);
    const page = projectCmsPage({ ...before, status: "draft", serviceCompositionVersion: 1, blocks: plan.blocks }, {
      mode: "draft", pageId: "support", now: new Date("2026-10-06T12:00:00Z"), assets,
    })!;
    expect(page.blocks.map(block => block.id)).toEqual(samOrder);
    const groups = renderContentGroups(page.blocks, (block, index) => ({ html: renderBlock(block, { generatedHeadingLevel: generatedHeadingLevelAt(page.blocks, index) }) }));
    expect(groups.map(group => group.block.id)).toEqual(samOrder);
    const html = groups.map(group => group.html).join("");
    expect(html.indexOf("Giving and Passport during the transition")).toBeLessThan(html.indexOf("Prefer to mail a check?"));
    expect(html.indexOf("Prefer to mail a check?")).toBeLessThan(html.indexOf("Give to NJ PBS through your donor advised fund"));
    expect(html.indexOf("Give to NJ PBS through your donor advised fund")).toBeLessThan(html.indexOf('class="card-grid"'));
  });
  it("opens the external donation and Passport actions in a new tab and keeps internal links in place", () => {
    const plan = planSupportPageComposition(before);
    const page = projectCmsPage({ ...before, status: "draft", serviceCompositionVersion: 1, blocks: plan.blocks }, {
      mode: "draft", pageId: "support", now: new Date("2026-10-06T12:00:00Z"), assets,
    })!;
    // CmsBlocks passes externalLinksNewTab for a composed service page, as the PublicSubpage frame did.
    const html = renderContentGroups(page.blocks, (block, index) => ({
      html: renderBlock(block, { generatedHeadingLevel: generatedHeadingLevelAt(page.blocks, index), externalLinksNewTab: true }),
    })).map(group => group.html).join("");
    const anchors = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>.*?<\/a>/g)];
    const donation = anchors.filter(([, href]) => href.startsWith("https://www.pbs.org/"));
    expect(donation.length).toBeGreaterThan(0);
    for (const [anchor] of donation) {
      expect(anchor).toContain('target="_blank" rel="noopener"');
      expect(anchor).toContain('<span class="sr-only"> (opens in new tab)</span>');
    }
    const internal = anchors.filter(([, href]) => href.startsWith("/") || href.startsWith("mailto:"));
    expect(internal.map(([, href]) => href)).toEqual(expect.arrayContaining(["/passport/", "/contact/"]));
    for (const [anchor] of internal) expect(anchor).not.toContain("_blank");
  });
  it("keeps a separately authored FAQ in staff order when cards move above it", () => {
    const faq = { id: "staff-faq", type: "faq_item" as const, order: 1, visible: true,
      data: { question: "Staff question", answer: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Staff answer" }] }] } } };
    const cards = planSupportPageComposition(before).blocks.find(block => block.type === "card_grid")!;
    const page = projectCmsPage({ ...before, status: "draft", serviceCompositionVersion: 1,
      blocks: [faq, { ...cards, order: 0 }] }, { mode: "draft", pageId: "support", now: new Date("2026-10-06T12:00:00Z"), assets })!;
    expect(page.blocks.map(block => block.id)).toEqual(["fixture-service-destinations", "staff-faq"]);
    const groups = renderContentGroups(page.blocks, block => ({ html: renderBlock(block) }));
    expect(groups.map(group => group.block.id)).toEqual(["fixture-service-destinations", "staff-faq"]);
    expect(groups[1].html).toContain("Staff question");
  });
  it("dry-runs the operator entrypoint against the captured fixture", async () => {
    const result = await runSupportMigration(["--fixture", fixturePath.pathname]);
    expect(result).toMatchObject({ mode: "dry-run", target: "cmsPages/support", changed: true, fromVersion: 7, toVersion: 8, insertedIds: [] });
    expect(result.blockOrder.map((block: { id: string }) => block.id)).toEqual(samOrder);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it("refuses unsafe arguments, key sources and lifecycle states", () => {
    expect(parseMigrationArgs([])).toEqual({ apply: false, fixture: undefined, expectedPlan: undefined });
    expect(() => parseMigrationArgs(["--apply"])).toThrow(/reviewed dry-run/);
    expect(() => parseMigrationArgs(["--publish"])).toThrow(/Unknown/);
    expect(() => parseMigrationArgs(["--fixture", fixturePath.pathname, "--apply"])).toThrow(/read-only/);
    expect(() => parseFirebaseKey('{"project_id":"another-project"}')).toThrow(/njpbs-site/);
    for (const status of ["in_review", "approved", "scheduled", "archived"]) {
      expect(() => reviewSupportMigration({ ...before, status })).toThrow(/no publication/);
    }
    expect(() => reviewSupportMigration({ ...before, publishBuildPending: true })).toThrow(/no publication/);
    expect(reviewSupportMigration({ ...before, title: "Staff edit" }).fingerprint).not.toBe(reviewSupportMigration(before).fingerprint);
  });
});
