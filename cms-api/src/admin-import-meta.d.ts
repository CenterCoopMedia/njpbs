// Types for the Vite env read in admin/src/lib/home-layouts.ts, which cms-api bundles with the
// editor modules. Workers have no import.meta.env. The content API refuses Home before any
// code path that calls homeLayoutsEnabled, so the Worker never reads it.
interface ImportMetaEnv {
  readonly VITE_CMS_HOME_LAYOUTS_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
