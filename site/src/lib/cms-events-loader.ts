import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import type { Loader } from "astro/loaders";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { EVENT_PUBLIC_ROUTE_BASE, eventPublicPath } from "./public-content-routes.ts";
import { readPublicArtifactBundle, resolvePublicArtifactBundlePath } from "./public-artifact-bundle.ts";
import { projectCmsEvent, type CmsEventBuildData, type CmsEventDoc } from "./cms-events-projection.ts";
export { projectCmsEvent, type CmsEventBuildData };

type EventDoc = CmsEventDoc;
type PublicAsset = { id: string; url?: unknown; mimeType?: unknown; width?: unknown; height?: unknown };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function assertEventRouteUniqueness(events: readonly CmsEventBuildData[]): void {
  const owners = new Map<string, string>();
  for (const event of events) {
    for (const route of [event.path, ...event.previousSlugs.map(eventPublicPath)]) {
      const owner = owners.get(route);
      if (owner && owner !== event.eventId) throw new Error(`${EVENT_PUBLIC_ROUTE_BASE} route ${route} is claimed by ${owner} and ${event.eventId}`);
      owners.set(route, event.eventId);
    }
  }
}

export async function readEvents(): Promise<{ docs: EventDoc[]; assets: Map<string, PublicAsset> }> {
  const env = process.env;
  const projectId = env.FIREBASE_PROJECT_ID || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
  if (!env.FIRESTORE_EMULATOR_HOST && (!projectId || !env.GOOGLE_APPLICATION_CREDENTIALS)) throw new Error("Firestore is not configured");
  if (!env.FIRESTORE_EMULATOR_HOST) realpathSync(env.GOOGLE_APPLICATION_CREDENTIALS!);
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } = requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const existing = getApps().find((app: { name: string }) => app.name === "cms-events-loader");
  const app = existing || initializeApp(env.FIRESTORE_EMULATOR_HOST ? { projectId: projectId || "demo-njpbs" } : { projectId, credential: applicationDefault() }, "cms-events-loader");
  try {
    const db = getFirestore(app);
    const docs = (await db.collection("cmsPosts").get()).docs.filter((doc: { exists: boolean }) => doc.exists).map((doc: { id: string; data: () => Record<string, unknown> }) => ({ ...doc.data(), id: doc.id }));
    const ids = [...new Set<string>(docs.flatMap((doc: EventDoc) => object(doc.published) && object(doc.published.metadata) && doc.published.metadata.type === "event" && typeof doc.published.metadata.imageAssetId === "string" ? [doc.published.metadata.imageAssetId] : []))];
    const assets = new Map<string, PublicAsset>();
    for (const id of ids) {
      const asset = await db.collection("media_assets_public").doc(id).get();
      if (asset.exists) assets.set(id, { ...asset.data(), id });
    }
    return { docs, assets };
  } finally { if (!existing) await deleteApp(app).catch(() => {}); }
}

export function cmsEventsLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactPath = resolvePublicArtifactBundlePath();
  return {
    name: previewContent?.request ? `cms-events-preview-${previewContent.request.sha256}` : artifactPath ? "cms-events-artifact-v3" : "cms-events-firestore",
    load: async ({ store, logger, parseData }) => {
      if (previewContent || artifactPath) {
        const bundle = previewContent ? await previewContent.load() : await readPublicArtifactBundle(artifactPath!);
        store.clear();
        for (const event of bundle.events ?? []) store.set({ id: event.eventId, data: await parseData({ id: event.eventId, data: { ...event } }) });
        return;
      }
      const strict = ["1", "true"].includes(process.env.CMS_LOADER_STRICT?.toLowerCase() ?? "");
      if (!process.env.FIRESTORE_EMULATOR_HOST && !(process.env.GOOGLE_APPLICATION_CREDENTIALS && (process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT))) {
        if (strict) throw new Error("cmsEvents loader: Firestore is not configured in strict mode");
        store.clear(); logger.info("cmsEvents loader: Firestore not configured; skipping (0 events)."); return;
      }
      let read: Awaited<ReturnType<typeof readEvents>>;
      try { read = await readEvents(); }
      catch (error) {
        if (strict) throw error;
        store.clear(); logger.warn(`cmsEvents loader: ${String(error)}`); return;
      }
      const events: CmsEventBuildData[] = [];
      for (const doc of read.docs) {
        try { const event = projectCmsEvent(doc, { now: new Date(), assets: read.assets }); if (event) events.push(event); }
        catch (error) { if (strict) throw error; logger.warn(`cmsEvents loader: skipped ${doc.id}: ${String(error)}`); }
      }
      assertEventRouteUniqueness(events);
      store.clear();
      for (const event of events) store.set({ id: event.eventId, data: await parseData({ id: event.eventId, data: { ...event } }) });
      logger.info(`cmsEvents loader: loaded ${events.length} event(s).`);
    },
  };
}

export { eventCardData } from "./event-card-data.ts";
