import { whatsNewIdPlugin } from "./build/whats-new-id";
import { adminAssetHeadersPlugin } from "./build/asset-headers";
import { adminAssetLimitsPlugin } from "./build/asset-limits";
import { homeHeroCatalogPlugin } from "./build/home-hero-catalog";
import { njDecidesAssetsPlugin } from "./build/nj-decides-assets";
import { boardwalkGuideContentPlugin } from "./build/boardwalk-guide-content";
import { politicsResourceContentPlugin } from "./build/politics-resource-content";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { execFileSync } from "node:child_process";
import firebaseConfig from "../firebase.json";
import { resolveAdminBuildRevision } from "../scripts/lib/admin-build-revision.mjs";
import { resolveFirebaseEmulatorConfig } from "../scripts/firebase-emulator-config.mjs";
import {
  parseAdminStatusManifest,
  type AdminStatusManifest,
} from "./src/lib/admin-status";

function unavailableAdminStatusManifest(): AdminStatusManifest {
  const generatedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    status: "unavailable",
    environment: "Local",
    generatedAt,
    refreshAfter: generatedAt,
    build: null,
    milestone: null,
    milestones: null,
  };
}

function readAdminStatusManifest(): AdminStatusManifest {
  const encoded = process.env.ADMIN_STATUS_MANIFEST_BASE64;
  if (!encoded) return unavailableAdminStatusManifest();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("ADMIN_STATUS_MANIFEST_BASE64 is not valid base64.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("ADMIN_STATUS_MANIFEST_BASE64 does not contain valid JSON.");
  }
  return parseAdminStatusManifest(value, process.env.CANONICAL_GITHUB_REPOSITORY ?? "");
}

function adminStatusManifestPlugin(): Plugin {
  const responseBody = (includeMilestones = false) => {
    const manifest = readAdminStatusManifest();
    // Only the staff-protected asset can contain private repository milestones.
    return `${JSON.stringify(includeMilestones ? manifest : {
      ...manifest, milestone: null, milestones: null,
    })}\n`;
  };
  return {
    name: "admin-status-manifest",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://admin.local").pathname;
        const includeMilestones = pathname === "/guide-content/admin-status.json";
        if (pathname !== "/admin-status.json" && !includeMilestones) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        // Vite development has no Pages staff admission, so it cannot serve the catalog.
        response.end(includeMilestones
          ? `${JSON.stringify(unavailableAdminStatusManifest())}\n`
          : responseBody());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "admin-status.json",
        source: responseBody(),
      });
      this.emitFile({
        type: "asset",
        fileName: "guide-content/admin-status.json",
        source: responseBody(true),
      });
    },
  };
}

// The commit this build was produced from, when a reviewed status manifest did not supply one.
// A checkout without git, or without history, simply has no revision to report.
function checkedOutRevision(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export default defineConfig(({ mode }) => {
  const emulatorConfig = resolveFirebaseEmulatorConfig(firebaseConfig);
  const firestorePort = emulatorConfig.emulators.firestore.port;
  // Handed to the client as one defined constant rather than an environment lookup: an
  // optional import.meta.env read expands to the whole environment object and would serialize
  // every VITE_* value into the bundle (#1064, admin public environment boundary).
  const sourceRevision = checkedOutRevision()?.trim() ?? null;
  const buildRevision = resolveAdminBuildRevision({
    manifest: readAdminStatusManifest(),
    gitRevision: sourceRevision,
  });

  return {
    server: {
      allowedHosts: (loadEnv(mode, import.meta.dirname, "ADMIN_DEV_ALLOWED_HOSTS").ADMIN_DEV_ALLOWED_HOSTS ?? "")
        .split(",")
        .map(host => host.trim())
        .filter(Boolean),
    },
    // The meaning-search worker is outside the initial dependency scan. Discovering
    // Transformers after an Images search otherwise reloads the active gallery tab.
    optimizeDeps: { include: ["@huggingface/transformers"] },
    plugins: [
      whatsNewIdPlugin(),
      homeHeroCatalogPlugin(),
      njDecidesAssetsPlugin(),
      boardwalkGuideContentPlugin(),
      politicsResourceContentPlugin(),
      react(),
      tailwindcss(),
      adminStatusManifestPlugin(),
      adminAssetHeadersPlugin(),
      adminAssetLimitsPlugin(),
    ],
    define: {
      __CANONICAL_GITHUB_REPOSITORY__: JSON.stringify(
        loadEnv(mode, import.meta.dirname, "VITE_CANONICAL_GITHUB_REPOSITORY").VITE_CANONICAL_GITHUB_REPOSITORY ?? "",
      ),
      __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__: JSON.stringify(
        loadEnv(mode, import.meta.dirname, "VITE_CMS_DEPLOYMENT_ENVIRONMENT").VITE_CMS_DEPLOYMENT_ENVIRONMENT ?? "production",
      ),
      "import.meta.env.VITE_FIRESTORE_EMULATOR_PORT": JSON.stringify(
        String(firestorePort),
      ),
      __ADMIN_BUILD_REVISION__: JSON.stringify(buildRevision),
      __ADMIN_SOURCE_REVISION__: JSON.stringify(
        sourceRevision && /^[0-9a-f]{40}$/.test(sourceRevision) ? sourceRevision : null,
      ),
    },
    build: {
      rolldownOptions: {
        output: {
          // Firebase remains an initial dependency because AuthProvider must restore the session
          // before any route mounts, but it does not need to be fused to the application entry.
          // Keep it cacheable as vendor code; route dynamic imports above then become their own
          // destination chunks. The build contract keeps every emitted chunk below Vite's 500 kB
          // warning instead of hiding regressions by raising that threshold (#614).
          codeSplitting: {
            groups: [
              // Keep the reviewed town snapshot cacheable beside the lazy Page preview.
              // Static imports preserve synchronous rendering without filling BlockEditor.
              {
                name: "town-lookup",
                includeDependenciesRecursively: false,
                test: /packages[\\/]content-core[\\/](?:src[\\/]town-lookup-(?:render|controls)\.ts|data[\\/]nj-town-(?:elections|boundaries)-v1\.json)(?:\?.*)?$/,
                priority: 30,
              },
              // These groups hold lazy modules that are already shared.
              // Route entries that must stay one file are combined in
              // desk-chunk.tsx and profile-chunk.tsx instead, because a dynamic import
              // keeps its own chunk.
              {
                name: "route-shell",
                includeDependenciesRecursively: false,
                test: /(?:^|[\\/])(?:admin[\\/]src[\\/](?:routes[\\/]RequireCapability\.tsx|components[\\/](?:ui[\\/](?:Skeleton|AssetImage)|ContentRowThumbnail|EditorSkeleton|PublishedVersionStatus|MediaFavoriteButton)\.tsx|lib[\\/](?:admin-status|review-queue|editor-back|content-status|content-nav|content-records|media-favorites|use-media-categories|use-media-favorites|use-content-sections)\.ts)|packages[\\/]content-core[\\/]src[\\/](?:cms-settings|author-profiles)\.ts)(?:\?.*)?$/,
                priority: 30,
              },
              {
                name: "editor-private",
                includeDependenciesRecursively: false,
                test: /(?:^|[\\/])(?:admin[\\/]src[\\/](?:lib[\\/](?:public-page-block-ownership|editor-bento-events|editor-locks)\.ts|components[\\/](?:EditorLayoutMode|MediaPickerDialog|RecordList|PagesDirectory|ContentLibrary|MediaUploadForm|ComponentEditorDialog|NewPostChoice)\.tsx)|packages[\\/]content-core[\\/]src[\\/](?:home-composition|home-composition-contract|post-slugs|contact-page-fallback)\.ts)(?:\?.*)?$/,
                priority: 30,
              },
              // Page and Home previews grow with public sections. Keep their renderers in a
              // sibling of the lazy editor so preview changes do not fill BlockEditor's
              // 500 kB budget. Static imports preserve preview timing and behavior.
              {
                name: "home-preview",
                includeDependenciesRecursively: false,
                test: /(?:packages[\\/]content-core[\\/]src[\\/]home-(?:curated-render|editorial-render|rail-render|section-render|(?:donor|newsletter|newscast)-section)\.ts|admin[\\/]src[\\/]components[\\/](?:BlockPreview|ComponentPhonePreview)\.tsx)(?:\?.*)?$/,
                priority: 30,
              },
              // Keep the shared dataset forms and renderer beside the editor.
              // Static imports preserve figure timing within the existing editor.
              {
                name: "dataset-editor",
                includeDependenciesRecursively: false,
                test: /admin[\\/]src[\\/](?:components[\\/](?:InlineDataFigure|Dataset(?:PickerDialog|LibraryDialog|ReleaseFields))\.tsx|lib[\\/]datasets\.ts)(?:\?.*)?$/,
                priority: 30,
              },
              // The shell uses shared validation without loading dataset dialogs.
              {
                name: "dataset-contract",
                includeDependenciesRecursively: false,
                test: /packages[\\/]content-core[\\/]src[\\/](?:datasets|data-figure(?:-render)?|dataset-figures)\.ts(?:\?.*)?$/,
                priority: 30,
              },
              // Secondary tabs and infrequent actions share one lazy facade.
              // Keep that graph out of the Images entry.
              {
                name: "media-secondary",
                includeDependenciesRecursively: false,
                test: /admin[\\/]src[\\/](?:routes[\\/](?:MediaSecondaryRoutes|SourceMediaLibrary|UgcSubmissionsRoute|VoiceoverLibraryRoute|MediaFavoritesLibrary|MediaCollectionsLibrary|MediaCollectionItems)\.tsx|lib[\\/](?:media-collection-pins(?:-store)?|video-production|transcription-credentials|transcription-options|transcript-workspace|video-editor-exports|video-search-results|ugc-submissions|voiceovers|waveform)\.ts|components[\\/](?:(?:MediaRecycleBin|CollectionColorField|VideoProcessingStatus|TranscriptionCredentials|VideoTranscriptVariants|TranscriptEditor|EditorVideoExports|VideoProductionTools|VideoMeaningSearch|VoiceoverPlayer)\.tsx|media[\\/](?:MediaReplaceButton|MediaFullViewer|VideoDetailsInspector|MediaCommentTimeline)\.tsx))$/,
                priority: 30,
              },
              // Keep recent-media-tags and tokenInputModel outside this UI chunk: the session
              // cache imports them during startup, before route-shell registers its listener.
              // Menu and inspector-width also serve the initial editor shell; grouping them
              // here would pull lazy media and rich-text dependencies into first paint.
              // Image previews stay on the Images path. Secondary-surface styles
              // remain in this existing CSS group.
              {
                name: "media-preview",
                includeDependenciesRecursively: false,
                test: /admin[\\/]src[\\/](?:lib[\\/](?:media-(?:permalink|filters|format|origin|display|search|query|paging|selection|tile-actions|grid-keys|hover-facts|collections|tags|tabs|step|quick-look|feedback|comment-time|comment-threads)|source-media(?:-bulk|-upload)?|saved-media-(?:views|view-store)|toolbar-overflow|use-media-(?:display|filter-draft|feedback)|use-(?:saved-media-views|favorite-undo|clear-filter-undo))\.ts|routes[\\/](?:(?:SourceMediaLibrary|UgcSubmissionsRoute|VoiceoverLibraryRoute|MediaCollectionsLibrary)\.css)|components[\\/](?:ui[\\/](?:(?:OverflowToolbar|Checkbox|Popover|SegmentedControl|Chip|HoverCard|Inspector|TokenInput)\.(?:tsx|css))|(?:VideoUploadPanel|MediaCollectionPicker|SourceMediaBulkEditor)\.(?:tsx|css)|(?:MediaRecycleBin|TranscriptEditor|VoiceoverPlayer|TranscriptionCredentials|VideoProductionTools|VideoMeaningSearch|VideoProcessingStatus)\.css|media[\\/](?:(?:MediaReplaceButton|MediaFullViewer|VideoDetailsInspector|MediaCommentTimeline)\.css|(?:MediaDisplayPopover|MediaFilterChips|MediaFilterPopover|MediaSearchField|MediaShortcuts|MediaSortControl|MediaToolbar|MediaPaging|MediaContextMenu|MediaGrid|MediaHoverFacts|MediaTile|MediaRow|SelectionBar|DropOverlay|UploadSheet|UploadTray|CopyMediaLink|MediaBulkInspector|QuickLook|ImageViewer|MediaInspector|MediaPreviewHeaderActions|MediaFeedbackSections|MentionTextarea)\.(?:tsx|css))))$/,
                priority: 20,
              },
              // App and most route surfaces share the small UI primitive module. Keep it out of
              // the entry so the initial authentication graph does not grow when a route gains
              // another primitive import; the browser can fetch this stable module in parallel.
              {
                name: "Primitives",
                test: /admin[\\/]src[\\/]components[\\/]ui[\\/]Primitives\.tsx$/,
                priority: 20,
              },
              // The performance receipt is imported by the entry and by most route surfaces
              // (#1064). Keep it out of the entry for the same reason as the primitives: the
              // initial authentication graph should not grow as instrumentation reaches
              // another call site. It stays on the critical path as a modulepreloaded sibling
              // of the entry, not as a later waterfall request.
              {
                name: "perf-receipts",
                test: /admin[\\/]src[\\/]lib[\\/]perf-receipts\.ts$/,
                priority: 20,
              },
              {
                name: "firebase",
                // Lazy media actions also share the app's initialization module.
                // Keep it with the SDK so first paint still loads one Firebase chunk.
                test: /node_modules[\\/](?:@firebase|firebase)[\\/]|admin[\\/]src[\\/]lib[\\/]firebase\.ts$/,
                priority: 10,
              },
              // React and the router are the other two initial dependencies, and together they
              // were most of the entry chunk: the entry sat 3.5 kB under the 500 kB contract
              // while the application code inside it was a fraction of that, so an ordinary
              // admin change tripped a ceiling it had not caused (#1122). Grouping them as
              // vendor code leaves the entry measuring what it should measure -- the shell,
              // auth screens, and route table this app owns -- and makes the two libraries
              // cacheable across deploys, since their hashes now change only when the
              // dependency does. Both are still static imports of the entry, so the browser
              // preloads them in parallel from index.html and first paint is unchanged.
              // react-router is matched first; the `react` test requires a path separator
              // right after the package name, so the two patterns cannot both claim a module.
              {
                name: "react-router",
                test: /node_modules[\\/]react-router[\\/]/,
                priority: 11,
              },
              {
                name: "react",
                test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                priority: 10,
              },
              // ProseMirror underlies the TipTap rich-text editor the content route pulls in.
              // Split that family into its own cacheable chunk so the ContentLayout destination
              // stays below Vite's 500 kB warning as the editor grows. Only ProseMirror is
              // grouped: the full rich-text vendor exceeds the cap and must not be one chunk.
              {
                name: "prosemirror",
                test: /node_modules[\\/](?:prosemirror-[a-z-]+|orderedmap|rope-sequence|w3c-keyname)[\\/]/,
                priority: 10,
              },
              // TipTap itself, plus the link autodetection it depends on. The rich-text editor
              // only ever loads with the content destination, but fusing it into that
              // destination's chunk made the content chunk the next thing to reach the cap.
              // As its own chunk it loads alongside the editor from the same route entry
              // (no extra round trip on the editor's critical path) and stops competing with
              // editor application code for the same 500 kB.
              {
                name: "tiptap",
                test: /node_modules[\\/](?:@tiptap[\\/][a-z-]+|linkifyjs)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
  };
});
