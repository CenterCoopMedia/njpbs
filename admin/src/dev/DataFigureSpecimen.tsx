/** Opt-in local evidence entry. Synthetic records, no staff session or live API. */
import { createRoot } from "react-dom/client";
import { useMemo, useRef, useState } from "react";
import type {
  DataFigureData,
  DataFigureVersion,
  DatasetPublicProjection,
} from "../../../packages/content-core/src/data-figure";
import type {
  DatasetRecord,
  DatasetRelease,
} from "../../../packages/content-core/src/datasets";
import { InlineDataFigure } from "../components/InlineDataFigure";
import { Button } from "../components/ui/Primitives";
import type { AdminBlock } from "../lib/block-factory";
import type { DatasetApi, DatasetSummary } from "../lib/datasets";
import "../styles.css";
import "../cms-workspace.css";

type FigureInput = { id: string; version: DataFigureVersion };
type FigureResponseMode = "ready" | "error" | "loading";

const stateRelease: DatasetPublicProjection["release"] = {
  label: "New Jersey employment rate",
  unit: "percent",
  value: 4.2,
  period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
  geography: { level: "state", code: "NJ", label: "New Jersey" },
  adjustment: "seasonally_adjusted",
  points: [
    { period: "2026-05-31", value: 3.9 },
    { period: "2026-06-30", value: 4 },
    { period: "2026-07-31", value: 4.1 },
    { period: "2026-08-31", value: null, missingReason: "Agency did not publish an August observation." },
    { period: "2026-09-30", value: 4.2 },
  ],
  chartText: "The synthetic employment rate rose from 3.9% in May to 4.2% in September. The agency did not publish an August observation.",
  methodNote: "Synthetic monthly values for editor and renderer evidence. Missing observations are not interpolated.",
  comparators: [{
    label: "Synthetic national comparison",
    unit: "percent",
    value: 4,
    period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
    geography: { level: "nation", code: "US", label: "United States" },
    adjustment: "seasonally_adjusted",
    source: { publisher: "Example national agency", title: "Synthetic national release", url: "https://example.test/national" },
    comparisonNote: "The national value uses a different geography and is shown only as reviewed context.",
  }],
  source: {
    publisher: "Example labor agency",
    title: "Synthetic monthly employment release",
    url: "https://example.test/employment",
    seriesId: "SYN-NJ-EMP",
  },
  releasedOn: "2026-10-15",
  verifiedOn: "2026-10-16",
  changeKind: "new_release",
  changeNote: "",
  reuse: { display: "allowed", exports: "denied", note: "Credit Example labor agency." },
};

const countyRelease: DatasetPublicProjection["release"] = {
  ...structuredClone(stateRelease),
  label: "Essex County housing cost burden",
  value: 36.8,
  period: { start: "2025-01-01", end: "2025-12-31", label: "2025 annual estimate" },
  geography: { level: "county", code: "34013", label: "Essex County, New Jersey" },
  adjustment: "not_applicable",
  points: [
    { period: "2022-12-31", value: 34.5 },
    { period: "2023-12-31", value: 35.1 },
    { period: "2024-12-31", value: 35.9 },
    { period: "2025-12-31", value: 36.8 },
  ],
  chartText: "The synthetic share of cost-burdened Essex County households rose from 34.5% in 2022 to 36.8% in 2025.",
  methodNote: "Synthetic annual household estimates for editor evidence.",
  comparators: [],
  source: {
    publisher: "Example housing agency",
    title: "Synthetic county housing release",
    url: "https://example.test/housing",
  },
  releasedOn: "2026-09-30",
  verifiedOn: "2026-10-02",
  reuse: { display: "allowed", exports: "allowed", note: "Credit Example housing agency." },
};

const annualWageRelease: DatasetPublicProjection["release"] = {
  ...structuredClone(stateRelease),
  label: "New Jersey minimum hourly wage",
  unit: "usd_hour",
  value: 15.92,
  period: { start: "2026-01-01", end: "2026-12-31", label: "2026 annual rate" },
  adjustment: "not_applicable",
  points: [11, 12, 13, 14.13, 15.13, 15.49, 15.92].map((value, index) => ({ period: `${2020 + index}-01-01`, value })),
  chartText: "The synthetic annual wage rises from $11 per hour in 2020 to $15.92 per hour in 2026.",
  methodNote: "Synthetic annual values for chart presentation evidence.",
  comparators: [],
};
if (new URLSearchParams(location.search).get("zero") === "1") {
  annualWageRelease.value = 0;
  annualWageRelease.points = annualWageRelease.points.map(point => ({ ...point, value: 0 }));
  annualWageRelease.chartText = "Every synthetic annual observation is zero.";
}
const wageId = "5304fee0598a1cf13c76c8c173e148e5";

const projections: Record<string, Record<string, DatasetPublicProjection>> = {
  [wageId]: { "wage-2026": {
    datasetId: wageId, releaseId: "wage-2026", revision: 1,
    digest: "c".repeat(64), approvedAt: "2026-10-16T14:30:00.000Z", release: annualWageRelease,
  } },
  "nj-employment": {
    "employment-2026-09": {
      datasetId: "nj-employment",
      releaseId: "employment-2026-09",
      revision: 3,
      digest: "a".repeat(64),
      approvedAt: "2026-10-16T14:30:00.000Z",
      release: stateRelease,
    },
  },
  "essex-housing": {
    "housing-2025": {
      datasetId: "essex-housing",
      releaseId: "housing-2025",
      revision: 2,
      digest: "b".repeat(64),
      approvedAt: "2026-10-02T16:00:00.000Z",
      release: countyRelease,
    },
  },
};

function privateRelease(release: DatasetPublicProjection["release"]): DatasetRelease {
  return {
    ...structuredClone(release),
    nextReviewOn: "2026-11-15",
    reuse: {
      ...release.reuse,
      evidence: "Synthetic fixture permission record. This value is private staff input.",
    },
  };
}

function record(input: Pick<DatasetRecord, "id" | "title" | "state" | "archived" | "approvedReleaseId"> & {
  releaseId: string;
  release: DatasetPublicProjection["release"];
  canEdit?: boolean;
}): DatasetRecord {
  return {
    id: input.id,
    title: input.title,
    ownerUid: "fixture-editor",
    ownerName: "Example editor",
    version: 7,
    archived: input.archived,
    state: input.state,
    workingRelease: privateRelease(input.release),
    workingReleaseId: input.releaseId,
    approvedReleaseId: input.approvedReleaseId,
    updatedAt: "2026-10-20T16:00:00.000Z",
    updatedBy: "fixture-editor",
    canEdit: input.canEdit ?? true,
    canApprove: true,
  };
}

const records: DatasetRecord[] = [
  record({ id: wageId, title: annualWageRelease.label, state: "approved", archived: false,
    approvedReleaseId: "wage-2026", releaseId: "wage-2026", release: annualWageRelease }),
  record({
    id: "nj-employment",
    title: "New Jersey employment rate",
    state: "draft",
    archived: false,
    approvedReleaseId: "employment-2026-09",
    releaseId: "employment-2026-09",
    release: stateRelease,
  }),
  record({
    id: "essex-housing",
    title: "Essex County housing cost burden",
    state: "approved",
    archived: false,
    approvedReleaseId: "housing-2025",
    releaseId: "housing-2025",
    release: countyRelease,
  }),
  record({
    id: "draft-only",
    title: "Draft-only transit measure",
    state: "draft",
    archived: false,
    approvedReleaseId: null,
    releaseId: "transit-draft",
    release: stateRelease,
  }),
  record({
    id: "review-only",
    title: "Housing measure in review",
    state: "review",
    archived: false,
    approvedReleaseId: null,
    releaseId: "housing-review",
    release: countyRelease,
  }),
  record({
    id: "archived-measure",
    title: "Archived synthetic measure",
    state: "approved",
    archived: true,
    approvedReleaseId: "employment-2026-09",
    releaseId: "employment-2026-09",
    release: stateRelease,
  }),
];

function summary(value: DatasetRecord): DatasetSummary {
  const { workingRelease: _release, workingReleaseId: _releaseId, updatedBy: _updatedBy, ...item } = value;
  return item;
}

function projectionFor({ id, version }: FigureInput): DatasetPublicProjection {
  const dataset = records.find(item => item.id === id);
  const releaseId = version.mode === "pinned" ? version.releaseId : dataset?.approvedReleaseId;
  const projection = releaseId ? projections[id]?.[releaseId] : undefined;
  if (!projection) throw new Error("The synthetic approved release was not found.");
  return structuredClone(projection);
}

async function delayFigureResponse() {
  const value = Number(new URLSearchParams(location.search).get("figureDelay") ?? 0);
  if (!Number.isSafeInteger(value) || value < 1) return;
  await new Promise(resolve => setTimeout(resolve, Math.min(value, 1_000)));
}

function Specimen() {
  const annualWage = new URLSearchParams(location.search).get("fixture") === "wage";
  const [block, setBlock] = useState<AdminBlock>({
    id: "data-figure-evidence",
    type: "data_figure",
    order: 0,
    visible: true,
    data: {
      datasetId: annualWage ? wageId : "nj-employment",
      version: { mode: "pinned", releaseId: annualWage ? "wage-2026" : "employment-2026-09" },
      display: "expanded",
    } satisfies DataFigureData,
  });
  const [readOnly, setReadOnly] = useState(false);
  const [mount, setMount] = useState(0);
  const [responseLabel, setResponseLabel] = useState<FigureResponseMode>("ready");
  const responseMode = useRef<FigureResponseMode>("ready");
  const resolvePending = useRef<null | (() => void)>(null);
  const [lastRequest, setLastRequest] = useState("No figure request yet.");

  const api = useMemo<DatasetApi>(() => ({
    refresh: async () => ({ refresh: null }),
    retry: async () => ({ refresh: null }),
    figure: async input => {
      setLastRequest(`${input.id}: ${input.version.mode}${input.version.mode === "pinned" ? ` (${input.version.releaseId})` : ""}`);
      await delayFigureResponse();
      if (responseMode.current === "error") throw new Error("Synthetic approved values are temporarily unavailable.");
      if (responseMode.current === "loading") {
        await new Promise<void>(resolve => { resolvePending.current = resolve; });
      }
      return projectionFor(input);
    },
    list: async () => ({ datasets: records.map(summary), nextCursor: null }),
    get: async id => {
      const dataset = records.find(item => item.id === id);
      if (!dataset) throw new Error("The synthetic dataset was not found.");
      return { dataset: structuredClone(dataset), useCount: 0 };
    },
    releases: async id => ({
      releases: Object.values(projections[id] ?? {}).map(item => ({
        id: item.releaseId,
        label: item.release.label,
        releasedOn: item.release.releasedOn,
        approvedRevision: item.revision,
      })),
      hasMore: false,
    }),
    release: async (id, releaseId) => {
      const projection = projections[id]?.[releaseId];
      if (!projection) throw new Error("The synthetic release was not found.");
      return { release: privateRelease(projection.release) };
    },
    owners: async () => ({ owners: [{ uid: "fixture-editor", name: "Example editor" }], nextCursor: null }),
    assign: async input => {
      const dataset = records.find(item => item.id === input.id);
      if (!dataset) throw new Error("The synthetic dataset was not found.");
      return { dataset: { ...structuredClone(dataset), ownerUid: input.ownerUid } };
    },
    save: async input => {
      const dataset = records.find(item => item.id === input.id) ?? records[0];
      return { dataset: { ...structuredClone(dataset), title: input.title, workingRelease: input.release } };
    },
    transition: async input => {
      const dataset = records.find(item => item.id === input.id);
      if (!dataset) throw new Error("The synthetic dataset was not found.");
      return { dataset: structuredClone(dataset) };
    },
  }), []);

  function setMode(mode: FigureResponseMode, remount = true) {
    responseMode.current = mode;
    setResponseLabel(mode);
    if (remount) setMount(value => value + 1);
  }

  function finishLoading() {
    setMode("ready", false);
    resolvePending.current?.();
    resolvePending.current = null;
  }

  return <main className="content-studio editor-canvas" style={{ maxWidth: "72rem", margin: "0 auto" }}>
    <header>
      <h1>Data figure editor fixture</h1>
      <p>Synthetic approved projections exercise the real inline editor and public renderer. No service request is made.</p>
    </header>
    <details>
      <summary>Fixture states</summary>
      <div className="button-row" aria-label="Fixture response controls">
        <Button onClick={() => setMode("ready")}>Show ready state</Button>
        <Button onClick={() => setMode("error")}>Show error state</Button>
        <Button onClick={() => setMode("loading")}>Show loading state</Button>
        <Button disabled={responseLabel !== "loading"} onClick={finishLoading}>Resolve loading response</Button>
        <Button disabled={responseLabel !== "error"} onClick={() => setMode("ready", false)}>Make retry succeed</Button>
        <Button aria-pressed={readOnly} onClick={() => setReadOnly(value => !value)}>{readOnly ? "Leave read-only mode" : "Show read-only mode"}</Button>
      </div>
      <p>Response: <strong>{responseLabel}</strong>. Last request: <output aria-label="Last figure request">{lastRequest}</output></p>
      <p>Stored block data: <output aria-label="Stored block data">{JSON.stringify(block.data)}</output></p>
    </details>
    <section aria-labelledby="figure-editor-heading">
      <h2 id="figure-editor-heading">Inline editor</h2>
      <InlineDataFigure
        key={mount}
        api={api}
        block={block}
        principal={{ id: "fixture-editor", grants: [{ role: "super_admin" }] }}
        readOnly={readOnly}
        onChange={(data) => setBlock(current => ({ ...current, data }))}
      />
    </section>
  </main>;
}

createRoot(document.getElementById("data-figure-root")!).render(<Specimen />);
