/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CANONICAL_GITHUB_REPOSITORY?: string;
  readonly VITE_CMS_READER_BRIDGE_ENABLED?: string;
  readonly VITE_CMS_READER_BRIDGE_MANIFEST?: string;
  readonly VITE_LIVE_PRODUCTION_ENABLED?: string;
  readonly VITE_AUTHOR_PAGES_LIVE?: string;
  readonly VITE_CMS_HOME_LAYOUTS_ENABLED?: string;
  readonly VITE_PUBLIC_SITE_ORIGIN?: string;
  readonly VITE_CMS_DEPLOYMENT_ENVIRONMENT?: string;
  readonly VITE_CMS_PREVIEW_ENABLED?: string;
  readonly VITE_CMS_STUDIO_CONFIGURATION?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_EXPECTED_DEV_APP_ID?: string;
  readonly VITE_FUNCTIONS_BASE_URL?: string;
  readonly VITE_USE_EMULATORS?: string;
  readonly VITE_VERIFICATION_EMAIL_SENDER?: string;
  readonly VITE_VIDEO_REPLACEMENT_ENABLED?: string;
  // Injected by vite.config.ts from the shared FIRESTORE_EMULATOR_PORT resolver.
  readonly VITE_FIRESTORE_EMULATOR_PORT?: string;
  // Public reCAPTCHA Enterprise site key for Firebase App Check.
  readonly VITE_FIREBASE_APPCHECK_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:home-hero-catalog" {
  const catalog: unknown;
  export default catalog;
}

declare module "virtual:whats-new-id" {
  const latestId: string;
  export default latestId;
}
