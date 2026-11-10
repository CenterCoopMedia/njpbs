import { afterEach, expect, it, vi } from "vitest";
const vendor = vi.hoisted(() => ({ getContainer: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: vendor.getContainer }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("./pending-work", async original => ({ ...await original<object>(), accessToken: async () => "fixture-only" }));
import worker, { PairPublicationRuntime, type PairEnvironment } from "./pair-worker";
import { releasePair, releaseSelector } from "../tests/helpers/private-public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";

function fields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key,
    value === null ? { nullValue: null } : typeof value === "string" ? { stringValue: value } : typeof value === "number" ? { integerValue: String(value) }
      : typeof value === "boolean" ? { booleanValue: value } : { mapValue: { fields: fields(value as Record<string, unknown>) } }]));
}
afterEach(() => { vi.unstubAllGlobals(); vendor.getContainer.mockReset(); });

it.each([true, false])("the installed minute handler rediscovers original work with no delivered wake (adopted=%s)", async adopted => {
  const pair = releasePair(), base = work.publicReleasePairPath(pair.pairId);
  const resource = "projects/njpbs-site-dev/databases/(default)/documents";
  const records: Record<string, Record<string, unknown>> = {
    [base]: pair, [`${base}/controls/runtime`]: { schemaVersion: 2, pairId: pair.pairId, status: "retained" },
    "system/publicDeployment": releaseSelector(), "system/billing": { disabled: false },
    [`${base}/journals/${pair.publisher.journalNamespace}`]: { schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null },
    "system/publicReleaseAdmissions/controls/adoption": { schemaVersion: 2, enabled: adopted },
  };
  let originalQueries = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://firestore.googleapis.com");
    if (url.pathname.endsWith(":runQuery")) {
      const query = JSON.parse(String(init?.body)).structuredQuery;
      if (query.from[0].collectionId !== "publicationPending") return Response.json([]);
      originalQueries++;
      expect(url.pathname).toContain(base.split("/").map(encodeURIComponent).join("/"));
      return Response.json([{ document: { name: `${resource}/${base}/publicationPending/original`,
        fields: fields({ schemaVersion: 2, operationId: "original", admissionDigest: "a".repeat(64) }) } }]);
    }
    const path = decodeURIComponent(url.pathname.split("/documents/")[1] ?? ""), value = records[path];
    return value ? Response.json({ name: `${resource}/${path}`, fields: fields(value) }) : new Response(null, { status: 404 });
  });
  const runtime = Object.create(PairPublicationRuntime.prototype);
  const env = { PAIR_ID: pair.pairId, PAIR_COMMIT_SHA: pair.commitSha, PAIR_ENVIRONMENT: pair.environment,
    PAIR_JOURNAL_NAMESPACE: pair.publisher.journalNamespace, PAIR_WORKER_VERSION: { id: pair.publisher.workerVersionId },
    PAIR_EXECUTOR_READY: "true", PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: "true", PUBLIC_PAIR_OWNER_WRITE_ENABLED: "true",
    PUBLIC_PAIR_TERMINAL_ENABLED: "true", PUBLIC_PAIR_SWITCH_CODE_ENABLED: "true", FIREBASE_SERVICE_ACCOUNT: "fixture-only",
    PUBLIC_RELEASE_INGRESS_PROOF: { prove: async () => new Response() }, PAIR_PUBLISHER: {} } as unknown as PairEnvironment;
  runtime.env = env;
  runtime.containerFetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("http://container/wake"); expect(init.method).toBe("POST");
    expect(runtime.envVars.CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED).toBe("true");
    expect(runtime.envVars.CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED).toBe("true");
    return Response.json({ status: "ready", executorInstalled: true, busy: false, pairId: pair.pairId,
      commitSha: pair.commitSha, journalNamespace: pair.publisher.journalNamespace });
  });
  vendor.getContainer.mockImplementation((_namespace, pairId) => { expect(pairId).toBe(pair.pairId); return runtime; });
  await worker.scheduled({ cron: "* * * * *" } as ScheduledController, env, {} as ExecutionContext);
  expect(runtime.containerFetch).toHaveBeenCalledTimes(adopted ? 1 : 0);
  expect(originalQueries).toBe(adopted ? 1 : 0);
});
