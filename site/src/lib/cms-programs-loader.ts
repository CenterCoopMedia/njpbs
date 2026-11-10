// Published Program snapshots become public /programs/ pages.
import { createCmsPreviewContentSource, type CmsPreviewContentSource } from "./cms-preview-content.ts";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import type { Loader } from "astro/loaders";
import { isPublishable } from "./publish-gate.ts";
import {
  PROGRAM_PUBLIC_ROUTE_BASE,
  programPublicPath,
} from "./public-content-routes.ts";
import { projectCmsProgram, type CmsProgramBuildData, type CmsProgramDoc } from "./cms-programs-projection.ts";
export { projectCmsProgram, type CmsProgramBuildData, type CmsProgramDoc };
import {
  readPublicArtifactBundle,
  resolvePublicArtifactBundlePath,
} from "./public-artifact-bundle.ts";

type Env = Record<string, string | undefined>;

/**
 * Refuse a build in which two admitted programs claim the same public route.
 *
 * Reachable in ordinary operation, exactly as it is for posts: two programs
 * renamed to the same thing, or a new program taking a slug an older one still
 * redirects from.
 */
export function assertProgramRouteUniqueness(
  programs: readonly CmsProgramBuildData[],
): void {
  const owners = new Map<string, string>();
  const collisions: string[] = [];
  for (const program of programs) {
    for (const route of [
      program.path,
      ...program.previousSlugs.map(programPublicPath),
    ]) {
      const existing = owners.get(route);
      if (existing !== undefined && existing !== program.programId) {
        collisions.push(`${route} is claimed by ${existing} and ${program.programId}`);
        continue;
      }
      owners.set(route, program.programId);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `${PROGRAM_PUBLIC_ROUTE_BASE} routes collide: ${collisions.sort().join("; ")}`,
    );
  }
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

interface FirestoreDocumentSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown>;
}

interface FirestoreCollection {
  get: () => Promise<{ docs: FirestoreDocumentSnapshot[] }>;
}

interface FirestoreDatabase {
  collection: (name: string) => FirestoreCollection;
}

export async function readCmsProgramsFromDatabase(
  database: FirestoreDatabase,
): Promise<CmsProgramDoc[]> {
  const documents = (await database.collection("cmsPosts").get()).docs;
  return (
    documents
      .filter((document) => document.exists)
      // Firestore path identity is authoritative, exactly as it is for pages and
      // posts: a stale or hostile stored `id` field cannot alias one document
      // onto another's route.
      .map((document) => ({ ...document.data(), id: document.id }))
  );
}

export async function readCmsPrograms(
  conn: NonNullable<ReturnType<typeof resolveFirestoreConnection>>,
): Promise<CmsProgramDoc[]> {
  const requireModule = createRequire(import.meta.url);
  const { initializeApp, getApps, deleteApp, applicationDefault } =
    requireModule("firebase-admin/app");
  const { getFirestore } = requireModule("firebase-admin/firestore");
  const appName = "cms-programs-loader";
  const existing = getApps().find((app: { name: string }) => app.name === appName);
  // Validate the credentials path before Firestore is constructed: Google Auth
  // otherwise discovers a missing file inside gRPC setup, where the rejected
  // promise escapes fail-closed handling.
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
    return await readCmsProgramsFromDatabase(
      getFirestore(app) as unknown as FirestoreDatabase,
    );
  } finally {
    if (!existing) await deleteApp(app).catch(() => {});
  }
}

export function cmsProgramsLoader(previewContent: CmsPreviewContentSource | null = createCmsPreviewContentSource()): Loader {
  const artifactBundlePath = resolvePublicArtifactBundlePath();
  const previewInput = previewContent?.request;
  return {
    name: previewInput ? `cms-programs-preview-${previewInput.sha256}`
      : artifactBundlePath ? "cms-programs-artifact-v3" : "cms-programs-firestore",
    load: async ({ store, logger, parseData }) => {
      if (previewInput || artifactBundlePath) {
        const bundle = previewContent
          ? await previewContent.load()
          : await readPublicArtifactBundle(artifactBundlePath!);
        store.clear();
        for (const program of bundle.programs) {
          store.set({
            id: program.programId,
            data: await parseData({ id: program.programId, data: { ...program } }),
          });
        }
        logger.info(`cmsPrograms loader: loaded ${bundle.programs.length} program(s) from the exact public artifact bundle.`);
        return;
      }
      const strict = isStrictLoaderMode();
      const conn = resolveFirestoreConnection();
      if (!conn) {
        if (strict) {
          throw new Error(
            "cmsPrograms loader: Firestore is not configured in strict mode.",
          );
        }
        store.clear();
        logger.info("cmsPrograms loader: Firestore not configured; skipping (0 programs).");
        return;
      }

      // One instant governs admission and every projection, so a program sitting
      // on its publish boundary cannot be admitted in one place and refused in
      // another.
      const now = new Date();
      let programs: CmsProgramDoc[];
      let assetMap = new Map<string, Record<string, unknown>>();
      try {
        programs = await readCmsPrograms(conn);
        const ids = [...new Set(programs.flatMap((doc) => {
          if (!isPublishable({ status: doc.status as never, publishAt: doc.publishAt as never, publiclyVisible: doc.publiclyVisible as never, published: doc.published, deleted: doc.deleted as never }, now)) return [];
          const published = doc.published as { metadata?: { keyArtAssetId?: unknown; type?: unknown } } | undefined;
          const id = published?.metadata?.type === "program" ? published.metadata.keyArtAssetId : null;
          return typeof id === "string" && id && !id.includes("/") ? [id] : [];
        }))];
        if (ids.length) {
          const requireModule = createRequire(import.meta.url);
          const { initializeApp, getApps, deleteApp, applicationDefault } = requireModule("firebase-admin/app");
          const { getFirestore } = requireModule("firebase-admin/firestore");
          const appName = "cms-programs-assets";
          const existing = getApps().find((app: { name: string }) => app.name === appName);
          const app = existing || initializeApp(
            conn.mode === "credentials"
              ? { projectId: conn.projectId, credential: applicationDefault() }
              : { projectId: conn.projectId },
            appName,
          );
          try {
            const collection = getFirestore(app).collection("media_assets_public");
            const snapshots = await Promise.all(ids.map((id) => collection.doc(id).get()));
            assetMap = new Map(
              snapshots.filter((snapshot) => snapshot.exists)
                .map((snapshot) => [snapshot.id, snapshot.data()]),
            );
          } finally {
            if (!existing) await deleteApp(app).catch(() => {});
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (strict) {
          throw new Error(
            `cmsPrograms loader: Firestore read failed in strict mode: ${message}`,
          );
        }
        store.clear();
        logger.warn(`cmsPrograms loader: Firestore unreachable, skipping (${message}).`);
        return;
      }

      const projected: CmsProgramBuildData[] = [];
      let skipped = 0;
      for (const doc of programs) {
        try {
          const data = projectCmsProgram(doc, { now, assets: assetMap });
          if (data) projected.push(data);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (strict) {
            throw new Error(`cmsPrograms loader: invalid document ${doc.id}: ${message}`);
          }
          skipped += 1;
          logger.warn(
            `cmsPrograms loader: skipped malformed document ${doc.id} (${message}).`,
          );
        }
      }
      // Route collisions fail every build, strict or not. A non-strict build that
      // quietly dropped one of two colliding programs would still emit a public
      // page at a route the CMS believes belongs to the other.
      assertProgramRouteUniqueness(projected);

      store.clear();
      for (const program of projected) {
        store.set({
          id: program.programId,
          data: await parseData({ id: program.programId, data: { ...program } }),
        });
      }
      logger.info(
        `cmsPrograms loader: loaded ${projected.length} program(s)${
          skipped ? `, skipped ${skipped} malformed` : ""
        }.`,
      );
    },
  };
}
