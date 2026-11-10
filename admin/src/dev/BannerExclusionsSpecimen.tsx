/** Local-only fixture: real banner controls, synthetic published destinations, no CMS writes. */
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { PublicHomepageBannerSettings, type PublicHomepageBannerSettingsTransport, type PublicHomepageBannerValues } from "../components/PublicHomepageBannerSettings";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings";
import "../styles.css";
import "../cms-workspace.css";

function Specimen() {
  const transport = useMemo<PublicHomepageBannerSettingsTransport>(() => {
    let version = 1;
    let values: PublicHomepageBannerValues = { enabled: true, njDecides: true, message: "Find voting information for New Jersey.",
      ...(new URLSearchParams(location.search).has("long") ? { excludedPaths: ["/" + "a".repeat(510) + "/"] } : {}),
      ...(new URLSearchParams(location.search).has("cap") ? { excludedPaths: Array.from({ length: 49 }, (_, index) => `/page-${index}/`) } : {}) };
    const settings = () => ({ schemaVersion: 3, version, values: structuredClone(values) });
    return {
      load: async () => ({ success: true, found: true, id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, settings: settings() }),
      save: async request => {
        values = structuredClone(request.values as PublicHomepageBannerValues); version++;
        return { success: true, changed: true, id: PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, settings: settings() };
      },
      publish: async () => { throw new Error("This local specimen does not publish."); },
      contentSources: {
        loadPages: async () => [
          { id: "page-guide", title: "Election guide", path: "/draft-guide/", published: true, livePath: "/voting-guide/" },
          { id: "page-draft", title: "Unpublished guide", path: "/unpublished/", published: false },
        ],
        loadLibrarySelection: async () => ({ records: [{ id: "story", kind: "post", title: "Election story", status: "published", liveSourceVersion: 2 }],
          page: 1, pageCount: 1, total: 1, allCount: 1, mineCount: 0, assignedCount: 0,
          statusCounts: { draft: 0, scheduled: 0, in_review: 0, approved: 0, published: 1, archived: 0 } }),
        loadRecord: async () => ({ status: "ready", record: { type: "post", status: "published", publicSourceVersion: 2,
          published: { sourceVersion: 2, metadata: { title: "Election story", slug: "election-story" } } } }),
      },
    };
  }, []);
  return <main className="admin-settings"><PublicHomepageBannerSettings {...transport} /></main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("banner-exclusions-root")!).render(<Specimen />);
