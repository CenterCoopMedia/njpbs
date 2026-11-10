import { Container, getContainer, type OutboundHandler } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
export { ContainerProxy } from "@cloudflare/containers";
import { pairStorageRpc, PAIR_STORAGE_HOST } from "./pair-storage-rpc";
import { pairTerminalRpc, PAIR_TERMINAL_HOST, type PairCanonicalProofBinding } from "./pair-terminal-rpc";
import { pairOwnerWriteRpc, PAIR_OWNER_WRITE_HOST } from "./pair-owner-write-rpc";
import { privatePairReader, privatePairOwnerWriteReader } from "./pair-work-reader";
import { jsonResponse } from "./pending-work";
import { wakePublicReleasePair, type PairWakeIdentity } from "./release-pair-wake";
import type { PublicReleasePair } from "../packages/content-core/src/public-release";
import protocol from "../functions/lib/public-release-pair.js";
import pairWork from "../functions/lib/public-release-pair-work.js";
import { PAIR_READER_PATH } from "../packages/content-core/src/private-pair-http";

export interface PairEnvironment {
  PAIR_ID: string;
  PAIR_COMMIT_SHA: string;
  PAIR_ENVIRONMENT: string;
  PAIR_JOURNAL_NAMESPACE: string;
  PAIR_EXECUTOR_READY: string;
  PAIR_WORKER_VERSION: { id: string };
  FIREBASE_SERVICE_ACCOUNT: string;
  PAIR_CONTENT: R2Bucket;
  PAIR_PUBLISHER: DurableObjectNamespace<PairPublicationRuntime>;
  PUBLIC_PAIR_TERMINAL_ENABLED?: string;
  PUBLIC_PAIR_OWNER_WRITE_ENABLED?: string;
  PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED?: string;
  PUBLIC_PAIR_SWITCH_CODE_ENABLED?: string;
  PUBLIC_RELEASE_INGRESS_PROOF?: PairCanonicalProofBinding;
}
/** This flag belongs to the sealed version, not a later activation write.
 * A true value only reaches the existing durable pair/work authority gates.
 */
export function pairExecutorReady(env: Pick<PairEnvironment, "PAIR_EXECUTOR_READY">): boolean {
  if (!["true", "false"].includes(env.PAIR_EXECUTOR_READY)) throw new Error("Private pair executor readiness is invalid");
  return env.PAIR_EXECUTOR_READY === "true";
}
export function pairOriginalRecoveryEnabled(env: Pick<PairEnvironment,
  "PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED" | "PUBLIC_PAIR_OWNER_WRITE_ENABLED" | "PUBLIC_PAIR_TERMINAL_ENABLED" | "PUBLIC_RELEASE_INGRESS_PROOF">) {
  return env.PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED === "true" && env.PUBLIC_PAIR_OWNER_WRITE_ENABLED === "true" &&
    env.PUBLIC_PAIR_TERMINAL_ENABLED === "true" && typeof env.PUBLIC_RELEASE_INGRESS_PROOF?.prove === "function";
}
export function pairSwitchCodeEnabled(env: Pick<PairEnvironment,
  "PUBLIC_PAIR_SWITCH_CODE_ENABLED" | "PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED" | "PUBLIC_PAIR_OWNER_WRITE_ENABLED" | "PUBLIC_PAIR_TERMINAL_ENABLED" | "PUBLIC_RELEASE_INGRESS_PROOF">) {
  return env.PUBLIC_PAIR_SWITCH_CODE_ENABLED === "true" && pairOriginalRecoveryEnabled(env);
}
export function pairWakeIdentity(env: PairEnvironment): PairWakeIdentity {
  const [service, incarnation, extra] = env.PAIR_ID.split(":");
  if (extra !== undefined || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(incarnation ?? "") ||
      service !== `njpbs-pair-slot-${incarnation}` || !/^[a-f0-9]{40}$/.test(env.PAIR_COMMIT_SHA) ||
      !["production", "development"].includes(env.PAIR_ENVIRONMENT) || !/^[A-Za-z0-9._:-]{1,128}$/.test(env.PAIR_JOURNAL_NAMESPACE)) {
    throw new Error("Invalid private pair environment");
  }
  return { pairId: env.PAIR_ID, commitSha: env.PAIR_COMMIT_SHA, environment: env.PAIR_ENVIRONMENT, journalNamespace: env.PAIR_JOURNAL_NAMESPACE };
}

export class PairPublicationRuntime extends Container<PairEnvironment> {
  defaultPort = 8080;
  sleepAfter = "3m";
  envVars: Record<string, string> = {};
  static outboundByHost = {
    [PAIR_OWNER_WRITE_HOST]: (async (request, env) => {
      if (env.PUBLIC_PAIR_OWNER_WRITE_ENABLED !== "true") return new Response(null, { status: 403 });
      if (request.headers.get("x-owner-kind") === "switch-code" && !pairSwitchCodeEnabled(env)) return new Response(null, { status: 403 });
      try {
        const reader = await privatePairOwnerWriteReader({ account: env.FIREBASE_SERVICE_ACCOUNT, identity: pairWakeIdentity(env),
          workerVersionId: env.PAIR_WORKER_VERSION.id });
        return await pairOwnerWriteRpc(request, env.PAIR_CONTENT, reader);
      } catch { return new Response(null, { status: 503 }); }
    }) satisfies OutboundHandler<PairEnvironment>,
    [PAIR_TERMINAL_HOST]: (async (request, env) => {
      if (env.PUBLIC_PAIR_TERMINAL_ENABLED !== "true" || !env.PUBLIC_RELEASE_INGRESS_PROOF) return new Response(null, { status: 403 });
      try {
        const reader = await privatePairReader({ account: env.FIREBASE_SERVICE_ACCOUNT, identity: pairWakeIdentity(env),
          workerVersionId: env.PAIR_WORKER_VERSION.id });
        return await pairTerminalRpc(request, env.PAIR_CONTENT, reader, env.PUBLIC_RELEASE_INGRESS_PROOF);
      } catch { return new Response(null, { status: 503 }); }
    }) satisfies OutboundHandler<PairEnvironment>,
    [PAIR_STORAGE_HOST]: (async (request, env) => {
      try {
        const reader = await privatePairReader({ account: env.FIREBASE_SERVICE_ACCOUNT, identity: pairWakeIdentity(env),
          workerVersionId: env.PAIR_WORKER_VERSION.id });
        return await pairStorageRpc(request, env.PAIR_CONTENT, reader);
      } catch { return new Response(null, { status: 503 }); }
    }) satisfies OutboundHandler<PairEnvironment>,
  };

  private async reader() {
    const identity = pairWakeIdentity(this.env);
    const workerVersionId = this.env.PAIR_WORKER_VERSION?.id;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workerVersionId ?? "")) throw new Error("Private pair version binding unavailable");
    return privatePairReader({ account: this.env.FIREBASE_SERVICE_ACCOUNT, identity,
      workerVersionId, ...(pairOriginalRecoveryEnabled(this.env) ? { originalRecoveryEnabled: true } : {}),
      ...(pairSwitchCodeEnabled(this.env) ? { switchCodeRecoveryEnabled: true } : {}) });
  }
  private async readerRequest(rawPair: PublicReleasePair, path: string, request?: Request): Promise<Response> {
    const reader = await this.reader(), pair = protocol.parsePublicReleasePair(rawPair);
    if (protocol.publicReleaseDigest(pair) !== protocol.publicReleaseDigest(reader.pair)) throw new Error("Private reader pair differs");
    const [billing, control] = await Promise.all([reader.read("system/billing"),
      reader.read(`${pairWork.publicReleasePairPath(pair.pairId)}/controls/runtime`)]);
    if ((billing as { disabled?: boolean } | null)?.disabled === true || !control ||
        typeof control !== "object" || Object.keys(control).sort().join(",") !== "pairId,schemaVersion,status" ||
        (control as { schemaVersion?: number }).schemaVersion !== 2 || (control as { pairId?: string }).pairId !== pair.pairId ||
        !["candidate", "retained"].includes((control as { status?: string }).status ?? "")) throw new Error("Private reader authority unavailable");
    // A read never drains queued work or invokes the executor/recovery path.
    // Node independently checks billing, retirement and the completed owner.
    this.envVars = { CMS_PUBLICATION_PAIR_JSON: JSON.stringify(pair), CMS_PUBLICATION_FIREBASE_ACCOUNT: this.env.FIREBASE_SERVICE_ACCOUNT,
      ...(pairOriginalRecoveryEnabled(this.env) ? { CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED: "true" } : {}),
      ...(pairSwitchCodeEnabled(this.env) ? { CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED: "true" } : {}) };
    return this.containerFetch(`http://container${path}`, request ? {
      method: "POST", headers: { "content-type": "application/json" }, body: request.body,
    } : { method: "GET" });
  }
  async readPrivatePair(request: Request, pair: PublicReleasePair): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== PAIR_READER_PATH || new URL(request.url).search) throw new Error("Private reader request refused");
    return this.readerRequest(pair, PAIR_READER_PATH, request);
  }
  async readerInstallation(pair: PublicReleasePair) {
    const response = await this.readerRequest(pair, "/private-pair-reader/v2/installation");
    if (!response.ok) { await response.body?.cancel(); throw new Error("Private reader installation unavailable"); }
    return jsonResponse(response, 4096);
  }
  private async probe(pair: Awaited<ReturnType<typeof privatePairReader>>["pair"], preflight: boolean) {
    this.envVars = { CMS_PUBLICATION_PAIR_JSON: JSON.stringify(pair), CMS_PUBLICATION_FIREBASE_ACCOUNT: this.env.FIREBASE_SERVICE_ACCOUNT,
      ...(pairOriginalRecoveryEnabled(this.env) ? { CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED: "true" } : {}),
      ...(pairSwitchCodeEnabled(this.env) ? { CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED: "true" } : {}) };
    const response = await this.containerFetch(`http://container/${preflight ? "health" : "wake"}`, { method: preflight ? "GET" : "POST" });
    if (!response.ok && !(preflight && response.status === 503)) { await response.body?.cancel(); throw new Error("Private pair container unavailable"); }
    const health = await jsonResponse(new Response(response.body, { status: 200 }), 4096) as Record<string, unknown>;
    if (health.pairId !== pair.pairId || health.commitSha !== pair.commitSha || health.journalNamespace !== pair.publisher.journalNamespace ||
        typeof health.executorInstalled !== "boolean" || typeof health.busy !== "boolean") throw new Error("Private pair container differs");
    const ready = health.status === "ready" && health.executorInstalled === true;
    if (!ready && !(preflight && health.status === "waiting-for-executor" && health.executorInstalled === false)) throw new Error("Private pair executor unavailable");
    return { ready, pairId: pair.pairId, commitSha: pair.commitSha, journalNamespace: pair.publisher.journalNamespace };
  }
  async check(identity: PairWakeIdentity): Promise<boolean> {
    if (!pairExecutorReady(this.env)) return false;
    const reader = await this.reader();
    return wakePublicReleasePair({ pair: reader.pair, identity, readWork: () => reader.due(),
      start: async () => { await this.probe(reader.pair, false); } });
  }
  async preflight(identity: PairWakeIdentity) {
    const reader = await this.reader();
    // Validate even an explicit preflight against current lifecycle authority.
    const observation = await reader.due();
    if (observation.billingDisabled) return { ready: false, pairId: reader.pair.pairId, reason: "billing-disabled" };
    let result: Awaited<ReturnType<PairPublicationRuntime["probe"]>> | undefined;
    await wakePublicReleasePair({ pair: reader.pair, identity, readWork: async () => ({ taskIds: ["private-preflight"] }),
      start: async () => { result = await this.probe(reader.pair, true); } });
    return result;
  }
  async retryStaging(identity: PairWakeIdentity, taskId: string): Promise<boolean> {
    if (!pairExecutorReady(this.env)) return false;
    if (!/^[a-f0-9]{64}$/.test(taskId)) throw new Error("Invalid private staging task");
    const reader = await this.reader();
    const observation = await reader.due();
    if (observation.billingDisabled) return false;
    let repaired = false;
    await wakePublicReleasePair({ pair: reader.pair, identity,
      readWork: async () => ({ taskIds: [taskId] }), start: async () => {
        this.envVars = { CMS_PUBLICATION_PAIR_JSON: JSON.stringify(reader.pair), CMS_PUBLICATION_FIREBASE_ACCOUNT: this.env.FIREBASE_SERVICE_ACCOUNT,
          ...(pairOriginalRecoveryEnabled(this.env) ? { CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED: "true" } : {}),
      ...(pairSwitchCodeEnabled(this.env) ? { CMS_PUBLICATION_PAIR_SWITCH_CODE_ENABLED: "true" } : {}) };
        const response = await this.containerFetch("http://container/retry-staging", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskId }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error("Private staging repair unavailable"); }
        const result = await jsonResponse(response, 1024) as Record<string, unknown>;
        if (result.status !== "staged" || result.taskId !== taskId) throw new Error("Private staging repair differs");
        repaired = true;
      } });
    return repaired;
  }
  async onActivityExpired() {
    try {
      if (!["running", "healthy"].includes((await this.getState()).status)) { await this.stop(); return; }
      const reader = await this.reader();
      await reader.due();
      const response = await this.containerFetch("http://container/health");
      const health = await jsonResponse(response, 4096) as Record<string, unknown>;
      if (health.status === "ready" && health.busy === true && health.executorInstalled === true &&
          health.pairId === reader.pair.pairId && health.commitSha === reader.pair.commitSha &&
          health.journalNamespace === reader.pair.publisher.journalNamespace) {
        await this.renewActivityTimeout(); return;
      }
    } catch { /* Durable task/journal recovery owns interrupted work. */ }
    await this.stop();
  }
}

/** Callable only through an explicitly provisioned private service binding. */
export class PairPublicationWake extends WorkerEntrypoint<PairEnvironment> {
  async readPrivatePair(request: Request, pair: PublicReleasePair) {
    return getContainer(this.env.PAIR_PUBLISHER, pairWakeIdentity(this.env).pairId).readPrivatePair(request, pair);
  }
  async readerInstallation(pair: PublicReleasePair) {
    return getContainer(this.env.PAIR_PUBLISHER, pairWakeIdentity(this.env).pairId).readerInstallation(pair);
  }
  async wake(identity: PairWakeIdentity) {
    return getContainer(this.env.PAIR_PUBLISHER, pairWakeIdentity(this.env).pairId).check(identity);
  }
  async retryStaging(identity: PairWakeIdentity, taskId: string) {
    return getContainer(this.env.PAIR_PUBLISHER, pairWakeIdentity(this.env).pairId).retryStaging(identity, taskId);
  }
  async preflight(identity: PairWakeIdentity) {
    return getContainer(this.env.PAIR_PUBLISHER, pairWakeIdentity(this.env).pairId).preflight(identity);
  }
}
export default {
  async fetch() { return new Response(null, { status: 404 }); },
  async scheduled(_event, env) {
    if (!pairExecutorReady(env)) return;
    await getContainer(env.PAIR_PUBLISHER, pairWakeIdentity(env).pairId).check(pairWakeIdentity(env));
  },
} satisfies ExportedHandler<PairEnvironment>;
