import { previewDiagnostics } from "./preview-diagnostics.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCmsPreviewSourceCheckout } from "./cms-publication-runtime-guard.ts";
import { assertProductionFirestoreRouting } from "./cms-publication-credentials.ts";
import { assertPreviewSandboxAvailable, parsePreviewOperatorArguments } from "./cms-preview-operator-checks.ts";
import { verifyCompiledRenderer } from "./compiled-renderer-release.mjs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { bindPreviewPairCodeTransport } from "./cms-preview-pair-code-transport.ts";

/** One container runs one listener. The durable journal and frozen input live
 * outside its disposable filesystem; only the active job is restored locally.
 */
export async function runCmsPreviewCloud(mode: string, environment = process.env) {
  // Runtime bundle import is measured separately after admission.
  const nodeStartupMs = Math.round(process.uptime() * 1000);
  const startupId = randomUUID(), processStartedAtMs = Math.round(performance.timeOrigin);
  const rawAccount = environment.CMS_PREVIEW_FIREBASE_ACCOUNT ?? "";
  const rawStorage = environment.CMS_PREVIEW_R2_CREDENTIAL ?? "";
  const pairMode = environment.CMS_PREVIEW_PAIR_MODE;
  const edgeSecret = environment.CMS_EDGE_ORIGIN_SECRET ?? "";
  delete environment.CMS_EDGE_ORIGIN_SECRET;
  const publicationAccess = { clientId: environment.CMS_DEV_ACCESS_CLIENT_ID ?? "",
    clientSecret: environment.CMS_DEV_ACCESS_CLIENT_SECRET ?? "" };
  delete environment.CMS_DEV_ACCESS_CLIENT_ID;
  delete environment.CMS_DEV_ACCESS_CLIENT_SECRET;
  delete environment.CMS_PREVIEW_FIREBASE_ACCOUNT;
  delete environment.CMS_PREVIEW_R2_CREDENTIAL;
  assertProductionFirestoreRouting(environment);
  const { rendererSha, serializerId, preflight } = parsePreviewOperatorArguments([
    mode, environment.CMS_PREVIEW_RENDERER_SHA ?? "", environment.CMS_PREVIEW_SERIALIZER_ID ?? "",
  ]);
  const measure = previewDiagnostics({ rendererSha, serializerId, startupId, processStartedAtMs });
  const startup = () => ({ startupId, processStartedAtMs,
    timingsMs: { ...measure.timings(), "node-startup": nodeStartupMs } });
  await measure("source-check", () => assertCmsPreviewSourceCheckout(rendererSha));
  await measure("package-check", () => verifyCompiledRenderer(fileURLToPath(new URL("../.compiled-renderer", import.meta.url)), rendererSha));
  await measure("sandbox-check", () => assertPreviewSandboxAvailable());
  if (preflight) return;

  let pairRuntime;
  if (pairMode !== undefined) {
    if (pairMode !== "true" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(serializerId) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(environment.CMS_PREVIEW_WORKER_VERSION ?? "") ||
        !edgeSecret || /[\r\n]/.test(edgeSecret)) throw new Error("Private preview pair configuration is invalid");
    // Load the real versioned bridge only after source/package/sandbox admission.
    // A missing implementation refuses; there is no schema-one fallback.
    const factory = createRequire(import.meta.url)("../../functions/lib/current-public-code-v2.js").createPairCurrentCodeTransport;
    if (typeof factory !== "function") throw new Error("Versioned preview bridge is unavailable");
    const createTransport = bindPreviewPairCodeTransport({ createTransport: factory,
      deploymentEnvironment: environment.CMS_DEPLOYMENT_ENVIRONMENT ?? "production", publicationAccess });
    pairRuntime = { workerVersion: environment.CMS_PREVIEW_WORKER_VERSION!, readSecret: () => edgeSecret, createTransport };
  }

  const runtime = await measure("runtime-import", () => import(
    /* @vite-ignore */ new URL("../.compiled-renderer/runtime/cloud.mjs", import.meta.url).href
  ));
  await runtime.serveCmsPreviewCloud({ rawAccount, rawStorage, rendererSha, serializerId, nodeStartupMs, measure, startup,
    deploymentEnvironment: environment.CMS_DEPLOYMENT_ENVIRONMENT ?? "production", publicationAccess, pairRuntime });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCmsPreviewCloud(process.argv[2] ?? "").catch(() => {
    // Provider, storage and credential errors can contain private input.
    process.stderr.write("Cloud preview renderer stopped without a verified result\n");
    process.exitCode = 1;
  });
}
