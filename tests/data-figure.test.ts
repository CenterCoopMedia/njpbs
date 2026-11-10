import { describe, expect, it } from "vitest";
import {
  isDataFigureData,
  type DataFigureData,
  type DatasetPublicProjection,
} from "../packages/content-core/src/data-figure";
import { formatDatasetValue, renderDataFigure } from "../packages/content-core/src/data-figure-render";

const data: DataFigureData = {
  datasetId: "synthetic-rate",
  version: { mode: "pinned", releaseId: "september-2026" },
  display: "expanded",
};

function projection(): DatasetPublicProjection {
  return {
    datasetId: "synthetic-rate",
    releaseId: "september-2026",
    revision: 2,
    digest: "a".repeat(64),
    approvedAt: "2026-10-20T14:00:00.000Z",
    release: {
      label: "Synthetic employment rate",
      unit: "percent",
      value: 4.2,
      period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
      geography: { level: "state", code: "NJ", label: "New Jersey" },
      adjustment: "seasonally_adjusted",
      points: [
        { period: "2026-06-30", value: 4 },
        { period: "2026-07-31", value: 4.1 },
        { period: "2026-08-31", value: null, missingReason: "Not reported" },
        { period: "2026-09-30", value: 4.2 },
        { period: "2026-10-31", value: 4.3 },
      ],
      chartText: "The synthetic rate is 4.2%. August is not reported. These values are for testing.",
      methodNote: "Synthetic monthly observations. No interpolation across missing data.",
      comparators: [],
      source: {
        publisher: "Example agency",
        title: "Synthetic monthly release",
        url: "https://example.test/data",
        seriesId: "example-rate",
      },
      releasedOn: "2026-10-15",
      verifiedOn: "2026-10-16",
      changeKind: "new_release",
      changeNote: "",
      reuse: { display: "allowed", exports: "denied", note: "Example agency" },
    },
  };
}

describe("data figure block contract", () => {
  it("strictly rejects unknown fields, invalid ids, and incomplete publish data", () => {
    expect(isDataFigureData(data, true)).toBe(true);
    expect(isDataFigureData({ ...data, extra: true }, true)).toBe(false);
    expect(isDataFigureData({ ...data, datasetId: "bad/id" }, true)).toBe(false);
    expect(isDataFigureData({ ...data, display: "chart" }, true)).toBe(false);
    expect(isDataFigureData({ datasetId: "", version: { mode: "pinned", releaseId: "" }, display: "compact" })).toBe(true);
    expect(isDataFigureData({ datasetId: "", version: { mode: "pinned", releaseId: "" }, display: "compact" }, true)).toBe(false);
    expect(isDataFigureData({ ...data, version: { mode: "latestApproved", releaseId: "forged" } }, true)).toBe(false);
  });
});

describe("data figure renderer", () => {
  it.each(["number", "jobs", "people", "usd", "usd_month", "usd_hour", "usd_billion", "cents_kwh"] as const)("includes zero and formats %s range labels like table values", (unit) => {
    const item = projection();
    item.release.unit = unit;
    item.release.points = [{ period: "2020-01-01", value: 11 }, { period: "2026-01-01", value: 15.92 }];
    const markup = renderDataFigure("wages", data, item);
    expect(markup).toContain(`Scale bottom: </span>${formatDatasetValue(0, unit)}`);
    expect(markup).toContain(`Scale top: </span>${formatDatasetValue(15.92, unit)}`);
    expect(markup).toContain(`<td>${formatDatasetValue(11, unit)}</td>`);
    expect(markup).not.toContain('d="M 56 276'); // A positive observation stays above zero.
  });

  it("preserves negative counts and shows the zero end of their range", () => {
    const item = projection();
    item.release.unit = "jobs";
    item.release.points = [{ period: "2026-01-01", value: -20 }, { period: "2026-02-01", value: -10 }];
    const markup = renderDataFigure("job-loss", data, item);
    expect(markup).toContain("Scale bottom: </span>-20 jobs");
    expect(markup).toContain("Scale top: </span>0 jobs");
    expect(markup).not.toMatch(/Infinity|NaN/);
  });

  it("keeps zero amounts on the baseline and distinguishes missing observations", async () => {
    const item = projection();
    item.release.unit = "people";
    item.release.value = 0;
    item.release.points = [{ period: "2026-01-01", value: 0 }, { period: "2026-02-01", value: 0 }];
    const compiled = await import("../functions/lib/dataset-figures.js");
    for (const render of [renderDataFigure, compiled.renderDataFigure]) {
      const markup = render("empty-count", data, item);
      expect(markup).toContain('class="cms-data-figure__series" d="M 56 276 L 976 276"');
      expect(markup).toContain("Scale baseline: </span>0 people");
      expect(markup).toContain("cms-data-figure__value-axis--baseline");
      expect(markup).not.toContain("1 people");
      expect(markup).not.toMatch(/Infinity|NaN/);
    }
    item.release.points = [{ period: "2026-01-01", value: null, missingReason: "Not reported" }];
    const missing = renderDataFigure("missing-count", data, item);
    expect(missing).toContain('class="cms-data-figure__point-label">Missing</span>');
    expect(missing).not.toContain('class="cms-data-figure__point"');
    expect(missing).not.toMatch(/Infinity|NaN/);
  });

  it("retains the month for same-month snapshots compared across years", () => {
    const item = projection();
    item.release.period = { start: "2026-07-01", end: "2026-07-31", label: "July 2026" };
    item.release.points = [{ period: "2025-07-31", value: 4 }, { period: "2026-07-31", value: 4.2 }];
    const markup = renderDataFigure("july-comparison", data, item);
    expect(markup).toContain('class="cms-data-figure__axis-start">Jul 2025</span>');
    expect(markup).toContain('class="cms-data-figure__axis-end">Jul 2026</span>');
  });

  it("uses year labels for annual observations in source and compiled renderers", async () => {
    const item = projection();
    item.release.unit = "usd_hour";
    item.release.period = { start: "2026-01-01", end: "2026-12-31", label: "2026 annual rate" };
    item.release.points = [{ period: "2020-01-01", value: 11 }, { period: "2026-01-01", value: 15.92 }];
    const compiled = await import("../functions/lib/dataset-figures.js");
    for (const render of [renderDataFigure, compiled.renderDataFigure]) {
      const markup = render("annual-wage", data, item);
      expect(markup).toContain('class="cms-data-figure__axis-start">2020</span>');
      expect(markup).toContain('class="cms-data-figure__axis-end">2026</span>');
      expect(markup).toContain("Scale bottom: </span>$0 per hour");
    }
    item.release.points = [{ period: "2026-01-01", value: 11 }, { period: "2026-02-01", value: 15.92 }];
    expect(renderDataFigure("monthly-wage", data, item)).toContain('class="cms-data-figure__axis-end">Feb 2026</span>');
  });

  it("keeps approved decimal precision in the headline and source values", async () => {
    const precise = projection();
    precise.release.value = 0.30000000000000004;
    precise.release.points[0].value = 0.0000123456789;
    precise.release.points[1].value = 1e-10;
    const compiled = await import("../functions/lib/dataset-figures.js");
    for (const render of [renderDataFigure, compiled.renderDataFigure]) {
      const html = render("precise-values", data, precise);
      expect(html).toContain("0.30000000000000004%");
      expect(html).toContain("<td>0.0000123456789%</td>");
      expect(html).toContain("<td>1E-10%</td>");
    }
  });

  it("escapes projected text and refuses an unsafe source URL", () => {
    const escaped = projection();
    escaped.release.label = '<script>alert("label")</script>';
    escaped.release.chartText = "<img src=x onerror=alert(1)>";
    const markup = renderDataFigure("figure-a", data, escaped);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");

    const unsafe = projection();
    unsafe.release.source.url = "javascript:alert(1)";
    const refused = renderDataFigure("figure-a", data, unsafe);
    expect(refused).toContain("unavailable");
    expect(refused).not.toContain("javascript:");
    expect(refused).not.toContain("Synthetic employment rate");

    const privateEvidence = projection() as DatasetPublicProjection & {
      release: DatasetPublicProjection["release"] & { reuse: { evidence: string } };
    };
    privateEvidence.release.reuse.evidence = "private workflow evidence";
    expect(renderDataFigure("figure-a", data, privateEvidence)).toContain("unavailable");
  });

  it("splits a line at missing data and does not invent a one-point trend", () => {
    const withGap = renderDataFigure("figure-gap", data, projection());
    expect(withGap.match(/class="cms-data-figure__series"/g)).toHaveLength(2);
    expect(withGap).toContain("Not reported");

    const single = projection();
    single.release.points = [{ period: "2026-09-30", value: 4.2 }];
    const onePoint = renderDataFigure("figure-point", data, single);
    expect(onePoint).not.toContain('class="cms-data-figure__series"');
    expect(onePoint).toContain('class="cms-data-figure__point"');
    expect(onePoint).toContain('class="cms-data-figure__point-label"');
    expect(onePoint).toContain("4.2%");

    const missing = projection();
    missing.release.points = [{ period: "2026-09-30", value: null, missingReason: "Not reported" }];
    expect(renderDataFigure("figure-missing", data, missing)).not.toMatch(/Infinity|NaN/);
  });

  it("scopes SVG and disclosure ids to each repeated block use", () => {
    const first = renderDataFigure("figure-first", data, projection());
    const second = renderDataFigure("figure-second", data, projection());
    expect(first).toContain('id="data-figure-figure-first-chart-title"');
    expect(first).toContain('id="data-figure-figure-first-details"');
    expect(second).toContain('id="data-figure-figure-second-chart-title"');
    expect(second).toContain('id="data-figure-figure-second-details"');
    expect(first).not.toContain("data-figure-figure-second");
    expect(second).not.toContain("data-figure-figure-first");
  });

  it("binds accessible chart, table, source, and metadata to the admitted projection", () => {
    const markup = renderDataFigure("figure-bound", data, projection(), 3);
    expect(markup).toContain("<h3>Synthetic employment rate</h3>");
    expect(markup).toContain('role="img" aria-labelledby="data-figure-figure-bound-chart-title data-figure-figure-bound-chart-description"');
    expect(markup).toContain("The synthetic rate is 4.2%");
    expect(markup).toContain("Scale top: </span>4.3%");
    expect(markup).toContain("Scale bottom: </span>4%");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<caption>Source values for Synthetic employment rate</caption>");
    expect(markup).toContain('<th scope="col">Period</th>');
    expect(markup).toContain('<th scope="row">August 31, 2026</th>');
    expect(markup).toContain('href="https://example.test/data"');
    expect(markup).toContain("Released October 15, 2026");
    expect(markup).toContain("Verified October 16, 2026");
    expect(markup).toContain("Credit:</strong> Example agency");

    const mismatched = projection();
    mismatched.datasetId = "another-dataset";
    expect(renderDataFigure("figure-bound", data, mismatched)).toContain("unavailable");

    const compact = renderDataFigure("figure-compact", { ...data, display: "compact" }, projection());
    expect(compact.indexOf("View chart, source values and method")).toBeLessThan(compact.indexOf("<svg"));
    expect(compact.match(/<table>/g)).toHaveLength(1);
    expect(compact).toContain("The synthetic rate is 4.2%");
  });
});

describe("frozen data figure admission", () => {
  it("keeps dataset revisions outside the seal while every editorial change changes it", async () => {
    const { editorialSnapshotDigest } = await import("../functions/lib/dataset-refresh-identity.js");
    const snapshot = { sourceVersion: 2, metadata: { title: "Published story", slug: "published-story" },
      blocks: [{ id: "figure-a", data }], datasetFigures: { revision: 1 } };
    const seal = editorialSnapshotDigest(snapshot);
    expect(editorialSnapshotDigest({ ...snapshot, datasetFigures: { revision: 2 } })).toBe(seal);
    for (const changed of [
      { ...snapshot, sourceVersion: 3 },
      { ...snapshot, metadata: { ...snapshot.metadata, title: "Changed story" } },
      { ...snapshot, blocks: [{ id: "figure-a", data: { ...data, display: "compact" } }] },
      { ...snapshot, newEditorialField: "New value" },
    ]) expect(editorialSnapshotDigest(changed)).not.toBe(seal);
  });

  it("rejects duplicate, orphaned, private and mismatched bindings", async () => {
    const { isDatasetFigures, createDatasetFigureResolver } = await import("../packages/content-core/src/dataset-figures");
    const release = projection();
    const binding = { blockId: "figure-a", datasetId: data.datasetId, releaseId: release.releaseId,
      revision: release.revision, digest: release.digest };
    const frozen = { figures: [binding], releases: [release] };
    expect(isDatasetFigures(frozen)).toBe(true);
    expect(isDatasetFigures({ figures: [binding, binding], releases: [release] })).toBe(false);
    expect(isDatasetFigures({ figures: [binding], releases: [] })).toBe(false);
    expect(isDatasetFigures({ ...frozen, private: "workflow" })).toBe(false);
    const resolve = createDatasetFigureResolver(frozen);
    expect(resolve("figure-a", data)?.releaseId).toBe("september-2026");
    expect(resolve("different-block", data)).toBeNull();
    expect(resolve("figure-a", { ...data, version: { mode: "pinned", releaseId: "different-release" } })).toBeNull();
  });

  it("refuses a small deduplicated input whose repeated figures exceed the HTML budget", async () => {
    const { validateFrozenDatasetFigures } = await import("../functions/lib/dataset-dependencies.js");
    const release = projection();
    const blocks = Array.from({ length: 200 }, (_, index) => ({ id: `figure-${String(index).padStart(3, "0")}`,
      type: "data_figure", visible: true, order: index, data }));
    const snapshot = { blocks, datasetFigures: { figures: blocks.map(block => ({ blockId: block.id,
      datasetId: data.datasetId, releaseId: release.releaseId, revision: release.revision, digest: release.digest })), releases: [release] } };
    expect(() => validateFrozenDatasetFigures(snapshot)).toThrow("rendered data figures exceed 256 KiB");
  });
});
