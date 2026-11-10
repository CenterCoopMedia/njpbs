// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataHubPageEnabled } from "../src/lib/build-target";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const HUB_ROUTE = read("../src/pages/data-hub/[...hub].astro");
const HUB_HTML = read("../src/data/njpbs-data-hub-v16.html");
const HOME = read("../src/components/CinematicHomePage.astro");
const TOPICS = read("../src/components/HomepageNewsTopicBar.astro");

// Execute the route's build hook with the real gate, without an Astro build.
const staticPathsSource = HUB_ROUTE.match(/export function getStaticPaths\(\) \{[\s\S]*?\n\}/)![0];
const routePaths = (env: Record<string, string | undefined>) => new Function(
  "dataHubPageEnabled", "process",
  `${staticPathsSource.replace("export ", "")}; return getStaticPaths();`,
)(dataHubPageEnabled, { env });

// Static integration guardrails. Publication/reuse approval and browser QA are
// editorial gates outside this source-level regression test.
describe("the public Data Hub page", () => {
  it("emits only the exact route with opt-in and never in rollback", () => {
    expect(routePaths({})).toEqual([]);
    expect(routePaths({ DATA_HUB_PUBLIC: "false" })).toEqual([]);
    expect(routePaths({ INTERNAL_SURFACES: "1" })).toEqual([]);
    expect(routePaths({ DATA_HUB_PUBLIC: "yes" })).toEqual([{ params: { hub: undefined } }]);
    expect(routePaths({ DATA_HUB_PUBLIC: "on", PUBLIC_ONLY: "true" })).toEqual([]);
  });

  it("is exactly /data-hub/ and uses the explicit publication gate", () => {
    expect(HUB_ROUTE).toContain('hub: undefined');
    expect(HUB_ROUTE).toContain('dataHubPageEnabled(process.env)');
    expect(HUB_ROUTE).toContain('noindex={preview || page?.data.noindex === true}');
    expect(HUB_ROUTE).toContain('isPrivatePreviewRender(context)');
    expect(HUB_ROUTE).toContain('searchable={false}');
    expect(HUB_ROUTE).toContain('<PublicSiteLayout');
  });

  it("keeps homepage promotion off pending the staff-editing decision", () => {
    // Required by the review decision, rather than an inverted feature oracle.
    expect(TOPICS).not.toContain('href="/data-hub/"');
    expect(HOME).toContain('newsTopics.length > 0 && <HomepageNewsTopicBar');
  });

  it("keeps reader data source dated and removes unavailable staff concepts", () => {
    // Approved launch decision: #3793, issuecomment-6319252336.
    expect(HUB_HTML).not.toContain('Editorial design preview — not published on NJ PBS');
    expect(HUB_HTML).toContain('Published on NJ PBS. Downloads preserve this dated source snapshot.');
    expect(HUB_HTML).toContain('id="source-data" type="application/json"');
    expect(HUB_HTML).toContain('"asOf":"2026-10-20"');
    expect(HUB_HTML).not.toMatch(/staff-mode-toggle|editor-dialog|figure-cms-panel|localStorage/);
  });
});
