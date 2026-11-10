import { resolveApprovedLibraryVersions } from "./approved-library-records.ts";
import type { Loader } from "astro/loaders";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { readPublicArtifactBundle, resolvePublicArtifactBundlePath } from "./public-artifact-bundle.ts";
import { projectCmsProgram, readCmsProgramsFromDatabase, resolveFirestoreConnection } from "./cms-programs-loader.ts";
import { projectCmsEvent, readEvents, type CmsEventBuildData } from "./cms-events-loader.ts";
import { exportRecordCards, approvedLibraryCardAssetIds } from "./record-card-resolution.ts";

type Asset = { id: string; url: string; mimeType: string; width?: number; height?: number };
export async function readRecordCardAssetsFromDatabase(
  database: { collection(name: string): { doc(id: string): { get(): Promise<{ exists: boolean; id: string; data(): Record<string, unknown> | undefined }> } } },
  records: readonly (Record<string, unknown> & { id: string })[],
  now = new Date(),
): Promise<Asset[]> {
  const ids = [...new Set(records.flatMap(record => approvedLibraryCardAssetIds(record, now)))];
  const assets = await Promise.all(ids.map(id => database.collection("media_assets_public").doc(id).get()));
  return assets.flatMap(asset => {
    const data = asset.data();
    return asset.exists && typeof data?.url === "string" && typeof data.mimeType === "string"
      ? [{ id: asset.id, url: data.url, mimeType: data.mimeType,
          ...(Number.isInteger(data.width) ? { width: Number(data.width) } : {}),
          ...(Number.isInteger(data.height) ? { height: Number(data.height) } : {}) }] : [];
  });
}

/** Direct builds use the same history and media selection as reserved builds. */
export async function readRecordCardSourcesFromDatabase(
  database: Parameters<typeof resolveApprovedLibraryVersions>[0] &
    Parameters<typeof readCmsProgramsFromDatabase>[0] & Parameters<typeof readRecordCardAssetsFromDatabase>[0],
  now = new Date(),
) {
  const stored = await readCmsProgramsFromDatabase(database);
  const records = await resolveApprovedLibraryVersions(database, stored);
  return { records, assets: await readRecordCardAssetsFromDatabase(database, records, now) };
}

async function readRecordCardSources(
  conn: NonNullable<ReturnType<typeof resolveFirestoreConnection>>,
  now = new Date(),
) {
  if (conn.mode === "credentials") realpathSync(conn.credentialsPath);
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } = requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "cms-record-card-assets";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
  const app = existing || initializeApp(conn.mode === "credentials"
    ? { projectId: conn.projectId, credential: applicationDefault() }
    : { projectId: conn.projectId }, appName);
  try {
    return await readRecordCardSourcesFromDatabase(getFirestore(app), now);
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}

export function cmsRecordCardsLoader(
  previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource(),
): Loader {
  const artifactPath = resolvePublicArtifactBundlePath();
  return {
    name: previewContent?.request
      ? `cms-record-cards-preview-${previewContent.request.sha256}`
      : artifactPath ? "cms-record-cards-artifact-v1" : "cms-record-cards-firestore-v1",
    load: async ({ store, parseData }) => {
      store.clear();
      let cards;
      if (previewContent?.request || artifactPath) {
        const source = previewContent?.request
          ? await previewContent.load()
          : await readPublicArtifactBundle(artifactPath!);
        cards = source.recordCards ?? [];
      } else {
        const conn = resolveFirestoreConnection();
        const strict = ["1", "true"].includes((process.env.CMS_LOADER_STRICT ?? "").toLowerCase());
        if (!conn) {
          if (strict) throw new Error("Record card loader: Firestore is not configured in strict mode.");
          return;
        }
        try {
          const now = new Date();
          const { records, assets } = await readRecordCardSources(conn, now);
          const programs = records.flatMap(record => {
            const program = projectCmsProgram(record, { now });
            return program ? [program] : [];
          });
          const eventRead = await readEvents();
          const events = eventRead.docs.flatMap((doc): CmsEventBuildData[] => {
            try {
              const event = projectCmsEvent(doc, { now, assets: eventRead.assets });
              return event ? [event] : [];
            } catch (error) {
              if (strict) throw error;
              return [];
            }
          });
          cards = exportRecordCards(records, programs, now, assets, events);
        } catch (error) {
          if (strict) throw error;
          return;
        }
      }
      for (const card of cards) {
        const id = `${card.kind}:${card.id}`;
        store.set({ id, data: await parseData({ id, data: { ...card } }) });
      }
    },
  };
}
