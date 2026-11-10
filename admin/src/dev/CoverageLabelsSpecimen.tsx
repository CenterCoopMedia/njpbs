/** Local review fixture. No authentication, production requests or network writes. */
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { CoverageLabelsSettings, DEFAULT_COVERAGE_LABELS, type CoverageLabelsSettingsTransport } from "../components/CoverageLabelsSettings";
import { CoverageLabelsProvider } from "../context/CoverageLabelsContext";
import { RecordForm, type RecordSaveReceipt } from "../components/RecordForm";
import { HomePreviewFrame } from "../components/HomePreviewFrame";
import { SettingsWorkspace } from "../components/SettingsWorkspace";
import { renderHomeEditorialHero } from "../../../packages/content-core/src/home-editorial-render";
import type { CoverageLabelsBuildData } from "../../../packages/content-core/src/coverage-labels";
import type { CmsSettingsDocument, SettingsPublicationReceipt } from "../lib/functions";
import type { CoverageLabelsSettingsValues } from "../../../packages/content-core/src/cms-settings";
import "../styles.css";
import "../cms-workspace.css";

const params = new URLSearchParams(location.search), view = params.get("view") ?? "settings";
const registry: CoverageLabelsBuildData = { settingId: "coverage-labels", sourceVersion: 1, publishedAt: "2026-10-29T12:00:00.000Z",
  labels: [...structuredClone(DEFAULT_COVERAGE_LABELS.labels), { id: "statehouse-watch", name: "Statehouse Watch", textColor: "#ffffff", backgroundColor: "#011375", retired: false }] };
const loadLabels = async () => registry;
function Specimen() {
  const transport = useMemo<CoverageLabelsSettingsTransport>(() => {
    let version = 3, values = { labels: structuredClone(registry.labels) };
    let published: CmsSettingsDocument<CoverageLabelsSettingsValues>["published"];
    let publication: SettingsPublicationReceipt | undefined;
    const settings = (): CmsSettingsDocument<CoverageLabelsSettingsValues> => ({ schemaVersion: 1, version, values, ...(published ? { published } : {}) });
    return {
      load: async () => ({ success: true, id: "coverage-labels", found: true, settings: settings(), ...(publication ? { publication } : {}) }),
      save: async request => { values = structuredClone(request.values); version++; return { success: true, id: "coverage-labels", changed: true, settings: settings() }; },
      publish: async () => {
        const sourceVersion = version;
        published = { schemaVersion: 1, sourceVersion, publishedAt: "2026-10-29T12:00:00.000Z", values: structuredClone(values) }; version++;
        publication = { queueId: "local-labels", originalOperationId: "local-labels", transport: "public-context-no-build-v1", sourceVersion,
          rendererSha: "a".repeat(40), contextRevision: 2, contextDigest: "b".repeat(64), status: "success", missingConsumers: [] };
        return { success: true, id: "coverage-labels", changed: true, settings: settings(), publication };
      },
    };
  }, []);
  if (view.startsWith("home-")) {
    const html = renderHomeEditorialHero([
      { id: "election", title: "New Jersey voters prepare for Election Day", summary: "Follow our reporting across the state.", href: "/posts/election/", coverageLabelId: "nj-decides-2026", spotlightNews: true },
      { id: "statehouse", title: "What to know about the races on your ballot", summary: "The decisions facing voters this November.", href: "/posts/races/", coverageLabelId: "statehouse-watch", spotlightNews: true },
    ], { coverageLabels: registry, supportingCount: 1 });
    const light = view === "home-light";
    return <main style={{ padding: "1rem" }}><h1>Home cards: {light ? "light context specimen" : "public dark context"}</h1>
      <HomePreviewFrame title="Home coverage labels" html={html} styles={light ? ":root { --color-surface-page: #fff; --color-text-on-surface: #172038; --color-text-muted: #48546b; --color-home-lead-scrim: #fff; --color-link: #011375; } body { background: #fff; color: #172038; }" : ""} /></main>;
  }
  if (view === "post" || view === "blog") return <main className="content-studio" style={{ padding: "1rem" }}><CoverageLabelsProvider load={loadLabels}>
    <RecordForm kind="post" canSave allowIncomplete initial={{ title: "New Jersey voters prepare for Election Day", summary: "Follow our reporting across New Jersey.", blocks: [], spotlightNews: true,
      ...(view === "blog" ? { liveBlog: { schemaVersion: 1, coverageState: "ongoing", branding: "nj-decides-2026", updates: [] } } : { coverageLabelId: "nj-decides-2026" }) }}
      onSave={async record => { const document: Record<string, unknown> = { ...record, id: "fixture-post", version: 2 }; if (document.coverageLabelId === null) delete document.coverageLabelId;
        return { kind: "record-save-receipt", document, mintedIds: {} } satisfies RecordSaveReceipt; }} />
  </CoverageLabelsProvider></main>;
  return <MemoryRouter initialEntries={["/admin/settings?section=coverage-labels"]}>
    <main className="admin-settings" style={{ height: "100dvh" }}><SettingsWorkspace sections={[
      { id: "coverage-labels", label: "Coverage labels", group: "Public website", content: <CoverageLabelsSettings {...transport} /> },
      { id: "fixture", label: "Another section", group: "Workspace", content: <p>Local fixture section.</p> },
    ]} /></main>
  </MemoryRouter>;
}
if (import.meta.env.DEV) createRoot(document.getElementById("coverage-labels-root")!).render(<Specimen />);
