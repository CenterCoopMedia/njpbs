import { readFile, writeFile } from "node:fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import { createRequire } from "node:module";
import path from "node:path";
import type { PublicationTarget } from "../../functions/lib/publication-target";

const requireModule = createRequire(import.meta.url);
const { assertPublicationTarget, publicationTarget } = requireModule("../../functions/lib/publication-target.js") as
  typeof import("../../functions/lib/publication-target");
const { publicWorkerCmsApiService } = requireModule("../../functions/lib/public-worker-candidate.js") as
  { publicWorkerCmsApiService(target: PublicationTarget): string };
const production = publicationTarget("production");
const productionValues = new Set([production.projectId, production.workerName, production.origin, production.publisherWorker,
  production.publicationBucket, production.previewBucket, production.backgroundBucket, publicWorkerCmsApiService(production)]);
type WorkerConfig = Record<string, unknown>;

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}

/** A dev Worker config may not carry any production Worker, project, bucket,
 * API service, route or origin, including through a copied production var. */
export function assertDevelopmentPublicWorkerConfig(config: WorkerConfig, target: PublicationTarget): WorkerConfig {
  const expected = assertPublicationTarget(target);
  if (expected.environment !== "development" || expected.workerName === production.workerName ||
      config?.name !== expected.workerName || !Array.isArray(config.routes) || config.routes.length > 0 ||
      config.workers_dev !== false || config.preview_urls !== false ||
      strings(config).some(value => productionValues.has(value) || value.includes(production.workerName) ||
        value.startsWith(`${production.origin}/`))) {
    throw new Error("Refusing a development Worker configuration that names production");
  }
  return config;
}

// Dev runs the production Worker program from the production config. Only
// the Worker name, data bindings and routes change; nothing else is dev-only.
export async function developmentPublicWorkerConfig({ root, target, assetsDirectory }: {
  root: string; target: PublicationTarget; assetsDirectory: string;
}): Promise<WorkerConfig> {
  const expected = assertPublicationTarget(target);
  if (expected.environment !== "development") throw new Error("Refusing a development Worker configuration that names production");
  const errors: ParseError[] = [];
  const config = parse(await readFile(path.join(root, "workers/wrangler.jsonc"), "utf8"), errors, { allowTrailingComma: true }) as WorkerConfig & {
    main: string; assets?: Record<string, unknown>; vars?: Record<string, unknown> };
  if (errors.length || !config || typeof config !== "object") throw new Error("The production Worker configuration is unreadable");
  return assertDevelopmentPublicWorkerConfig({ ...config, name: expected.workerName, main: path.join(root, "workers", config.main),
    routes: [], workers_dev: false, preview_urls: false,
    assets: { ...config.assets, directory: assetsDirectory },
    r2_buckets: [{ binding: "DURABLE_POST_WITHDRAWALS", bucket_name: expected.publicationBucket }],
    services: [{ binding: "CMS_API", service: publicWorkerCmsApiService(expected), entrypoint: "PublicContentEntrypoint" }],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: { ...config.vars, PUBLICATION_ENVIRONMENT: "development" } }, expected);
}

export async function writeDevelopmentPublicWorkerConfig(input: {
  root: string; target: PublicationTarget; assetsDirectory: string; file: string;
}): Promise<string> {
  await writeFile(input.file, `${JSON.stringify(await developmentPublicWorkerConfig(input))}\n`, { mode: 0o600 });
  return input.file;
}
