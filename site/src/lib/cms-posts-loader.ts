// Firestore/content-layer I/O stays outside the pure Worker-safe projector.
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import type { Loader } from "astro/loaders";
import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout.ts";
import { parseBlocks } from "../../../packages/content-core/src/content-model.ts";
import { isPublishable } from "./publish-gate.ts";
import { readPublicArtifactBundle, resolvePublicArtifactBundlePath } from "./public-artifact-bundle.ts";
import { projectCmsPost, assertPostRouteUniqueness, postAssetIds, type CmsPostDoc, type CmsPostBuildData } from "./cms-posts-projection.ts";
export { projectCmsPost, resolveImage, assertPostRouteUniqueness, postAssetIds, publishedCredits, publicCredits } from "./cms-posts-projection.ts";
export type { CmsPostDoc, CmsPostBuildData, CmsPublicImage, PublicCredit } from "./cms-posts-projection.ts";
type Env = Record<string, string | undefined>;

interface FirestoreDocumentSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown>;
}

interface FirestoreCollection {
  get: () => Promise<{ docs: FirestoreDocumentSnapshot[] }>;
  doc: (id: string) => { get: () => Promise<FirestoreDocumentSnapshot> };
}

interface FirestoreDatabase {
  collection: (name: string) => FirestoreCollection;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveFirestoreConnection(env: Env = process.env):
  | { mode: "emulator"; projectId: string }
  | { mode: "credentials"; projectId: string; credentialsPath: string }
  | null {
  const projectId =
    env.FIREBASE_PROJECT_ID || env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || "";
  if (env.FIRESTORE_EMULATOR_HOST) {
    return { mode: "emulator", projectId: projectId || "demo-njpbs" };
  }
  if (env.GOOGLE_APPLICATION_CREDENTIALS && projectId) {
    return {
      mode: "credentials",
      projectId,
      credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS,
    };
  }
  return null;
}

function isStrictLoaderMode(env: Env = process.env): boolean {
  const value = env.CMS_LOADER_STRICT?.toLowerCase();
  return value === "1" || value === "true";
}

export async function readCmsPostsFromDatabase(
  database: FirestoreDatabase,
  now: Date,
): Promise<{ posts: CmsPostDoc[]; assets: Record<string, unknown>[] }> {
  const documents = (await database.collection("cmsPosts").get()).docs;
  const posts: CmsPostDoc[] = documents
    .filter((document) => document.exists)
    // Firestore path identity is authoritative, exactly as it is for pages: a
    // stale or hostile stored `id` field cannot alias one document onto
    // another's route.
    .map((document) => ({ ...document.data(), id: document.id }));

  const ids = new Set<string>();
  for (const post of posts) {
    if (!isPlainObject(post.published)) continue;
    if (
      !isPublishable(
        {
          status: post.status as never,
          publishAt: post.publishAt as never,
          publiclyVisible: post.publiclyVisible as never,
          published: post.published,
          deleted: post.deleted as never,
        },
        now,
      )
    ) {
      continue;
    }
    const parsed = parseBlocks(post.published.blocks);
    const blocks = parsed.ok ? visibleLayoutBlocks(parsed.blocks) : [];
    for (const id of postAssetIds(post.published.metadata, blocks)) ids.add(id);
  }
  const assetCollection = database.collection("media_assets_public");
  const snapshots = await Promise.all(
    [...ids].sort().map((id) => assetCollection.doc(id).get()),
  );
  return {
    posts,
    assets: snapshots
      .filter((snapshot) => snapshot.exists)
      .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() })),
  };
}

async function readCmsPosts(
  conn: NonNullable<ReturnType<typeof resolveFirestoreConnection>>,
  now: Date,
): Promise<{ posts: CmsPostDoc[]; assets: Record<string, unknown>[] }> {
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } =
    requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "cms-posts-loader";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
  // Validate the credentials path before Firestore is constructed, for the same
  // reason the page loader does: Google Auth otherwise discovers a missing file
  // inside gRPC setup, where the rejected promise escapes fail-closed handling.
  if (conn.mode === "credentials") realpathSync(conn.credentialsPath);
  const app =
    existing ||
    initializeApp(
      conn.mode === "credentials"
        ? { projectId: conn.projectId, credential: applicationDefault() }
        : { projectId: conn.projectId },
      appName,
    );
  try {
    return await readCmsPostsFromDatabase(
      getFirestore(app) as unknown as FirestoreDatabase,
      now,
    );
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}

export function cmsPostsLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-posts-preview-${previewInput.sha256}`
      : artifactBundlePath ? "cms-posts-artifact-v3" : "cms-posts-firestore",
    load: async ({ store, logger, parseData }) => {
      if (previewInput || artifactBundlePath) {
        const content = previewContent
          ? await previewContent.load() : await readPublicArtifactBundle(artifactBundlePath!);
        const posts = content.posts;
        store.clear();
        for (const post of posts) {
          store.set({
            id: post.postId,
            data: await parseData({ id: post.postId, data: { ...post } }),
          });
        }
        logger.info(`cmsPosts loader: loaded ${posts.length} post(s) from ${
          previewContent ? "the exact private preview input" : "the exact public artifact bundle"
        }.`);
        return;
      }
      const strict = isStrictLoaderMode();
      const conn = resolveFirestoreConnection();
      if (!conn) {
        if (strict) {
          throw new Error("cmsPosts loader: Firestore is not configured in strict mode.");
        }
        store.clear();
        logger.info("cmsPosts loader: Firestore not configured; skipping (0 posts).");
        return;
      }

      // One instant governs admission and every projection, so a post sitting on
      // its publish boundary cannot be admitted for its assets and refused for
      // its page, or the reverse.
      const now = new Date();
      let posts: CmsPostDoc[];
      let assets: Record<string, unknown>[];
      try {
        ({ posts, assets } = await readCmsPosts(conn, now));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (strict) {
          throw new Error(`cmsPosts loader: Firestore read failed in strict mode: ${message}`);
        }
        store.clear();
        logger.warn(`cmsPosts loader: Firestore unreachable, skipping (${message}).`);
        return;
      }

      const assetMap = new Map(
        assets.map((asset) => [String(asset.id), asset as Record<string, unknown>]),
      );
      const projected: CmsPostBuildData[] = [];
      let skipped = 0;
      for (const doc of posts) {
        try {
          const data = projectCmsPost(doc, { now, assets: assetMap });
          if (data) projected.push(data);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (strict) {
            throw new Error(`cmsPosts loader: invalid document ${doc.id}: ${message}`);
          }
          skipped += 1;
          logger.warn(`cmsPosts loader: skipped malformed document ${doc.id} (${message}).`);
        }
      }
      // Route collisions fail every build, strict or not. A non-strict build that
      // quietly dropped one of two colliding posts would still emit a public page
      // at a route the CMS believes belongs to the other.
      assertPostRouteUniqueness(projected);

      store.clear();
      for (const post of projected) {
        store.set({ id: post.postId, data: await parseData({ id: post.postId, data: { ...post } }) });
      }
      logger.info(
        `cmsPosts loader: loaded ${projected.length} post(s)${
          skipped ? `, skipped ${skipped} malformed` : ""
        }.`,
      );
    },
  };
}
