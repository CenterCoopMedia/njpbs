// The public author-page loader: Firestore `cmsAuthorProfilesPublic` -> /authors/{slug}/.
//
// The snapshot this reads is already the detached, field-by-field public
// projection the author-profile core builds; nothing private can be in it by
// construction. So this loader's job is narrower than the page or post loader's:
// admit the snapshots that are structurally usable as a public page, refuse the
// ones that are not, and refuse a build in which two authors claim one route.
//
// Withdrawal needs no code here and that is the design. Unpublishing a profile
// deletes the snapshot document inside the same transaction that flips the
// working profile private, so the next build simply does not read it, emits no
// `/authors/{slug}/`, and the artifact receipt records one fewer author. The
// slug stays reserved, so republishing restores the same URL.

import { withAuthorPortraitDisplay } from "./author-portrait-display.ts";
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import type { Loader } from "astro/loaders";
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";
import {
  assertAuthorRouteUniqueness,
  projectAuthorSnapshot,
  type CmsAuthorBuildData,
} from "./cms-authors-projection.ts";
export {
  assertAuthorRouteUniqueness,
  projectAuthorPhoto,
  projectAuthorSnapshot,
  type AuthorPhotoBuildData,
  type CmsAuthorBuildData,
} from "./cms-authors-projection.ts";

type Env = Record<string, string | undefined>;

interface FirestoreDocumentSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown>;
}

interface FirestoreDatabase {
  collection: (name: string) => { get: () => Promise<{ docs: FirestoreDocumentSnapshot[] }> };
}

function resolveFirestoreConnection(env: Env = process.env):
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

export async function readAuthorSnapshotsFromDatabase(
  database: FirestoreDatabase,
): Promise<{ authorId: string; data: Record<string, unknown> }[]> {
  const documents = (await database.collection("cmsAuthorProfilesPublic").get()).docs;
  return documents
    .filter((document) => document.exists)
    .map((document) => ({ authorId: document.id, data: document.data() }));
}

async function readAuthorSnapshots(
  conn: NonNullable<ReturnType<typeof resolveFirestoreConnection>>,
): Promise<{ authorId: string; data: Record<string, unknown> }[]> {
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } =
    requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "cms-authors-loader";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
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
    return await readAuthorSnapshotsFromDatabase(
      getFirestore(app) as unknown as FirestoreDatabase,
    );
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}

export { withAuthorPortraitDisplay } from "./author-portrait-display.ts";

export function cmsAuthorsLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-authors-preview-${previewInput.sha256}`
      : artifactBundlePath ? "cms-authors-artifact-v3" : "cms-authors-firestore",
    load: async ({ store, logger, parseData }) => {
      if (previewInput || artifactBundlePath) {
        const bundle = previewContent
          ? await previewContent.load()
          : await readPublicArtifactBundle(artifactBundlePath!);
        store.clear();
        for (const author of bundle.authors) {
          const stored = withAuthorPortraitDisplay(author);
          store.set({
            id: stored.authorId,
            data: await parseData({ id: stored.authorId, data: { ...stored } }),
          });
        }
        logger.info(`cmsAuthorsPublic loader: loaded ${bundle.authors.length} author page(s) from the exact public artifact bundle.`);
        return;
      }
      const strict = isStrictLoaderMode();
      const conn = resolveFirestoreConnection();
      if (!conn) {
        if (strict) {
          throw new Error(
            "cmsAuthorsPublic loader: Firestore is not configured in strict mode.",
          );
        }
        store.clear();
        logger.info("cmsAuthorsPublic loader: Firestore not configured; skipping.");
        return;
      }

      let rows: { authorId: string; data: Record<string, unknown> }[];
      try {
        rows = await readAuthorSnapshots(conn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (strict) {
          throw new Error(
            `cmsAuthorsPublic loader: Firestore read failed in strict mode: ${message}`,
          );
        }
        store.clear();
        logger.warn(`cmsAuthorsPublic loader: Firestore unreachable, skipping (${message}).`);
        return;
      }

      const projected: CmsAuthorBuildData[] = [];
      let skipped = 0;
      for (const row of rows) {
        const author = projectAuthorSnapshot(row.authorId, row.data);
        if (author) projected.push(author);
        else skipped += 1;
      }
      if (strict && skipped > 0) {
        throw new Error(
          `cmsAuthorsPublic loader: ${skipped} public author snapshot(s) are unusable.`,
        );
      }
      assertAuthorRouteUniqueness(projected);

      store.clear();
      for (const author of projected) {
        store.set({
          id: author.authorId,
          data: await parseData({ id: author.authorId, data: { ...author } }),
        });
      }
      logger.info(
        `cmsAuthorsPublic loader: loaded ${projected.length} author page(s)${
          skipped ? `, skipped ${skipped} unusable` : ""
        }.`,
      );
    },
  };
}
