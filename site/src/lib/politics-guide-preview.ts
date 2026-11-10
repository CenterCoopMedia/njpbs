import { internalSurfaceRoutesEnabled } from "./build-target";

type Env = Record<string, string | undefined>;
export const POLITICS_PREVIEW_ROOT = "/resources/nj-politics/";
export const POLITICS_PREVIEW_ASSETS = ["guide.js", "guide.css", "nj-politics.json", "nj-election-2026.json"] as const;
export type PoliticsPreviewAsset = typeof POLITICS_PREVIEW_ASSETS[number];

/** Build exclusion only. The existing Dev gateway authorizes every request. */
export function politicsGuidePreviewEnabled(env: Env = {}, frozenPreview = false): boolean {
  return internalSurfaceRoutesEnabled(env)
    && !frozenPreview
    && !["1", "true", "yes", "on"].includes((env.WORKERS_CI ?? "").trim().toLowerCase())
    // config-input: CMS_PREVIEW_INPUT_PATH, CMS_PREVIEW_INPUT_SHA256, PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_BUILD_BATCH_ID
    && !["PUBLIC_BUILD_BATCH_ID", "PUBLIC_ARTIFACT_BUNDLE_PATH", "CMS_PREVIEW_INPUT_PATH", "CMS_PREVIEW_INPUT_SHA256"].some(key => (env[key] ?? "").trim());
}

export function politicsGuidePreviewRoutes(env: Env = {}, frozenPreview = false) {
  return politicsGuidePreviewEnabled(env, frozenPreview) ? [
    { pattern: `${POLITICS_PREVIEW_ROOT}index.html`, entrypoint: "./src/pages/_politics-guide-preview.ts" },
    { pattern: `${POLITICS_PREVIEW_ROOT}_preview/[asset]`, entrypoint: "./src/pages/_politics-guide-preview-asset.ts" },
  ] : [];
}

/** Look inside renamed assets as well as checking reserved output paths. */
export function containsPoliticsGuidePreview(source: string): boolean {
  return /nj-politics-dev-preview|politics-preview-shell|person-shirley-emehelu|candidate-[a-f0-9]{18}|nj-politics-study-workbook-audited\.xlsx|person-example-official|candidate-one/.test(source);
}

export function politicsGuidePreviewHtml(): string {
  return `<!doctype html>
<html lang="en" data-cms-theme="editorial"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>New Jersey politics — staff Dev preview</title><link rel="stylesheet" href="${POLITICS_PREVIEW_ROOT}_preview/guide.css"></head>
<body data-pagefind-ignore><a class="politics-preview-skip" href="#politics-preview-main">Skip to guide</a><header class="politics-preview-shell"><a href="/">NJ PBS development</a><span>Staff preview · Read only</span><a href="https://admin.njpbs.org/">Open CMS</a></header><main id="politics-preview-main" tabindex="-1"><h1 class="sr-only">New Jersey politics staff guide preview</h1><div id="nj-politics-dev-preview"><p role="status">Loading the politics guide…</p></div><noscript>This searchable preview requires JavaScript.</noscript></main><script type="module" src="${POLITICS_PREVIEW_ROOT}_preview/guide.js"></script></body></html>`;
}
