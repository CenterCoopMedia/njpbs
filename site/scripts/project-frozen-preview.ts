// Runs inside the offline preview sandbox. No public output compilation occurs.
import { readPublicArtifactBundle, writePublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { loadHomeSourceSnapshot } from "../src/lib/home-sources-loader";
import { homeSourcePreviewSnapshot } from "../src/lib/home-hero-items";
import { homeSelectedPostIds } from "../../packages/content-core/src/home-source-catalog";
import { assertRetainedPreviewImages } from "./retained-public-images";

const env = process.env;
if (env.CMS_OFFLINE_BUILD !== "1") throw new Error("Preview projection requires frozen offline input");
const bundle = await readPublicArtifactBundle("/preview/input.json", env);
await assertRetainedPreviewImages("/background", bundle);
const sources = await loadHomeSourceSnapshot({ ...env, PUBLIC_ARTIFACT_BUNDLE_PATH: "/preview/input.json",
  PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3" });
// The same catalog projection backs the public /_home-sources.json route.
const homeSources = homeSourcePreviewSnapshot(sources, bundle.posts,
  homeSelectedPostIds(bundle.pages.find(page => page.pageId === "home") ?? {}), bundle.authors);
if (!homeSources.editorial) throw new Error("Preview projection requires the frozen Home catalog");
await writePublicArtifactBundle("/preview/dist/public-context.json", { ...bundle, homeSources });
