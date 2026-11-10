import { expect, it, vi } from "vitest";
const vendor = vi.hoisted(() => ({ getContainer: vi.fn() }));
vi.mock("@cloudflare/containers", () => ({ Container: class {}, ContainerProxy: class {}, getContainer: vendor.getContainer }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import worker, { PairPublicationRuntime, pairWakeIdentity, pairExecutorReady, pairOriginalRecoveryEnabled, pairSwitchCodeEnabled, type PairEnvironment } from "./pair-worker";
import { releasePair } from "../tests/helpers/private-public-release-pair.js";
import ownership from "../functions/lib/public-release-pair-work.js";
import deployment from "../functions/lib/public-deployment-pointer.js";
import { PAIR_TERMINAL_HOST } from "./pair-terminal-rpc";
import { PAIR_OWNER_WRITE_HOST } from "./pair-owner-write-rpc";

it("requires all sealed opt-ins and the actual ingress proof binding for original continuation", () => {
  const enabled = { PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: "true", PUBLIC_PAIR_OWNER_WRITE_ENABLED: "true",
    PUBLIC_PAIR_TERMINAL_ENABLED: "true", PUBLIC_RELEASE_INGRESS_PROOF: { prove: async () => new Response() } };
  expect(pairOriginalRecoveryEnabled(enabled)).toBe(true);
  for (const key of Object.keys(enabled)) {
    expect(pairOriginalRecoveryEnabled({ ...enabled, [key]: undefined })).toBe(false);
  }
  expect(pairOriginalRecoveryEnabled({ ...enabled, PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: "TRUE" })).toBe(false);
});

it("starts the existing private wake when only an original-publication hint is due", async () => {
  const pair = releasePair(), runtime = Object.create(PairPublicationRuntime.prototype);
  runtime.env = { PAIR_EXECUTOR_READY: "true" };
  runtime.reader = async () => ({ pair, due: async () => ({ taskIds: [], publicationPending: true }) });
  runtime.probe = vi.fn();
  expect(await runtime.check({ pairId: pair.pairId, commitSha: pair.commitSha,
    environment: pair.environment, journalNamespace: pair.publisher.journalNamespace })).toBe(true);
  expect(runtime.probe).toHaveBeenCalledExactlyOnceWith(pair, false);
});

it.each(["false", "true"])("preserves the sealed continuation mode on a cold staging-repair start (%s)", async enabled => {
  const pair = releasePair(), taskId = "a".repeat(64), runtime = Object.create(PairPublicationRuntime.prototype);
  runtime.env = { PAIR_EXECUTOR_READY: "true", PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: enabled,
    PUBLIC_PAIR_OWNER_WRITE_ENABLED: "true", PUBLIC_PAIR_TERMINAL_ENABLED: "true",
    PUBLIC_RELEASE_INGRESS_PROOF: { prove: async () => new Response() }, FIREBASE_SERVICE_ACCOUNT: "unit-only" };
  runtime.reader = async () => ({ pair, due: async () => ({ billingDisabled: false }) });
  runtime.containerFetch = vi.fn(async (url: string) => {
    expect(url).toBe("http://container/retry-staging");
    expect(runtime.envVars.CMS_PUBLICATION_PAIR_ORIGINAL_RECOVERY_ENABLED).toBe(enabled === "true" ? "true" : undefined);
    return Response.json({ status: "staged", taskId });
  });
  expect(await runtime.retryStaging({ pairId: pair.pairId, commitSha: pair.commitSha,
    environment: pair.environment, journalNamespace: pair.publisher.journalNamespace }, taskId)).toBe(true);
  expect(runtime.containerFetch).toHaveBeenCalledTimes(1);
});

it.each([undefined, "false", "TRUE", "1"])("keeps owner writes off before credential reads (%s)", async enabled => {
  const env = { PUBLIC_PAIR_OWNER_WRITE_ENABLED: enabled,
    get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Credential must not be read"); } } as unknown as PairEnvironment;
  expect((await PairPublicationRuntime.outboundByHost[PAIR_OWNER_WRITE_HOST](new Request(`http://${PAIR_OWNER_WRITE_HOST}/`), env)).status).toBe(403);
  expect(vendor.getContainer).not.toHaveBeenCalled();
});

it.each([undefined, "false", "true"])("keeps the terminal bridge inert without both enablement and a binding (%s)", async enabled => {
  const env = { PUBLIC_PAIR_TERMINAL_ENABLED: enabled,
    get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Credential must not be read"); } } as unknown as PairEnvironment;
  const result = await PairPublicationRuntime.outboundByHost[PAIR_TERMINAL_HOST](new Request(`http://${PAIR_TERMINAL_HOST}/prove`), env);
  expect(result.status).toBe(403); expect(vendor.getContainer).not.toHaveBeenCalled();
});
it.each([undefined, "false"])("does not read credentials when a binding exists but the bridge is off (%s)", async enabled => {
  const prove = vi.fn(), env = { PUBLIC_PAIR_TERMINAL_ENABLED: enabled, PUBLIC_RELEASE_INGRESS_PROOF: { prove },
    get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Credential must not be read"); } } as unknown as PairEnvironment;
  expect((await PairPublicationRuntime.outboundByHost[PAIR_TERMINAL_HOST](new Request(`http://${PAIR_TERMINAL_HOST}/prove`), env)).status).toBe(403);
  expect(prove).not.toHaveBeenCalled(); expect(vendor.getContainer).not.toHaveBeenCalled();
});

it("adds no public route that can start a container", async () => {
  const env = { get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Credential must not be read"); } } as unknown as PairEnvironment;
  for (const path of ["/", "/wake", "/health", "/retry-staging"]) {
    expect((await worker.fetch(new Request(`https://example.test${path}`, { method: "POST" }), env, {} as ExecutionContext)).status).toBe(404);
  }
  expect(vendor.getContainer).not.toHaveBeenCalled();
});
it("disabled recovery does not fetch credentials, construct a container or advertise readiness", async () => {
  const env = { PAIR_EXECUTOR_READY: "false", get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Credential must not be read"); } } as unknown as PairEnvironment;
  await worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
  const runtime = Object.create(PairPublicationRuntime.prototype);
  runtime.env = env;
  expect(await runtime.check({})).toBe(false);
  expect(await runtime.retryStaging({}, "a".repeat(64))).toBe(false);
  expect(vendor.getContainer).not.toHaveBeenCalled();
});
it("keeps container routing on one validated pair incarnation", () => {
  const incarnation = "aaaaaaaa-1111-4111-8111-111111111111";
  const env = { PAIR_ID: `njpbs-pair-slot-${incarnation}:${incarnation}`, PAIR_COMMIT_SHA: "a".repeat(40),
    PAIR_ENVIRONMENT: "development", PAIR_JOURNAL_NAMESPACE: `pair-${incarnation}` } as PairEnvironment;
  expect(pairWakeIdentity(env).pairId).toBe(env.PAIR_ID);
  expect(() => pairWakeIdentity({ ...env, PAIR_ID: `njpbs-production:${incarnation}` })).toThrow();
});

it("accepts only explicit sealed executor readiness values", () => {
  expect(pairExecutorReady({ PAIR_EXECUTOR_READY: "false" })).toBe(false);
  expect(pairExecutorReady({ PAIR_EXECUTOR_READY: "true" })).toBe(true);
  for (const value of [undefined, "", "1", "TRUE", true, ["true"]]) {
    expect(() => pairExecutorReady({ PAIR_EXECUTOR_READY: value as string })).toThrow("readiness is invalid");
  }
});
it.each(["false", "true"])("refuses explicit private preflight compute when billing is disabled (sealed ready=%s)", async executorReady => {
  const pair = releasePair();
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const encoded = Buffer.from(await crypto.subtle.exportKey("pkcs8", key.privateKey)).toString("base64");
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const account = JSON.stringify({ type: "service_account", project_id: "njpbs-site-dev",
    client_email: "fixture@njpbs-site-dev.iam.gserviceaccount.com", private_key: privateKey });
  const base = ownership.publicReleasePairPath(pair.pairId);
  const records = new Map<string, unknown>([
    [base, pair], [`${base}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "candidate" }],
    ["system/publicDeployment", deployment.initialPublicDeploymentPointer()], ["system/billing", { disabled: true }],
    [`${base}/journals/${pair.publisher.journalNamespace}`, { schemaVersion: 2, pairId: pair.pairId, journalNamespace: pair.publisher.journalNamespace, job: null }],
  ]);
  function value(raw: unknown): unknown {
    if (raw === null) return { nullValue: null };
    if (typeof raw === "string") return { stringValue: raw };
    if (typeof raw === "boolean") return { booleanValue: raw };
    if (typeof raw === "number") return { integerValue: String(raw) };
    return { mapValue: { fields: Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, item]) => [key, value(item)])) } };
  }
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    if (url.href === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "fixture-only", token_type: "Bearer", expires_in: 300 });
    const prefix = "/v1/projects/njpbs-site-dev/databases/(default)/documents/";
    if (url.origin !== "https://firestore.googleapis.com" || !url.pathname.startsWith(prefix)) throw new Error("Unexpected fixture network target");
    const path = decodeURIComponent(url.pathname.slice(prefix.length)), raw = records.get(path);
    if (raw === undefined) return new Response(null, { status: 404 });
    return Response.json({ name: `projects/njpbs-site-dev/databases/(default)/documents/${path}`,
      fields: (value(raw) as { mapValue: { fields: unknown } }).mapValue.fields });
  });
  const runtime = Object.create(PairPublicationRuntime.prototype);
  const containerFetch = vi.fn();
  runtime.env = { PAIR_ID: pair.pairId, PAIR_COMMIT_SHA: pair.commitSha, PAIR_ENVIRONMENT: pair.environment,
    PAIR_JOURNAL_NAMESPACE: pair.publisher.journalNamespace, PAIR_EXECUTOR_READY: executorReady,
    PAIR_WORKER_VERSION: { id: pair.publisher.workerVersionId }, FIREBASE_SERVICE_ACCOUNT: account };
  runtime.containerFetch = containerFetch;
  try {
    const result = await runtime.preflight(pairWakeIdentity(runtime.env));
    expect(result).toMatchObject({ ready: false, reason: "billing-disabled" });
    await expect(runtime.readerInstallation(pair)).rejects.toThrow("Private reader authority unavailable");
    await expect(runtime.readPrivatePair(new Request("https://private.example.test/private-pair-reader/v2/read", {
      method: "POST", body: "{}" }), pair)).rejects.toThrow("Private reader authority unavailable");
    expect(containerFetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

it.each([undefined, "false", "TRUE", "1", "true"])("requires separate literal CODE opt-in and every original sealed prerequisite (%s)", async flag => {
  const env = { PUBLIC_PAIR_SWITCH_CODE_ENABLED: flag, PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED: "true", PUBLIC_PAIR_OWNER_WRITE_ENABLED: "true",
    PUBLIC_PAIR_TERMINAL_ENABLED: "true", PUBLIC_RELEASE_INGRESS_PROOF: { prove: async () => new Response() } };
  expect(pairSwitchCodeEnabled(env)).toBe(flag === "true");
  for (const key of ["PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED", "PUBLIC_PAIR_OWNER_WRITE_ENABLED", "PUBLIC_PAIR_TERMINAL_ENABLED", "PUBLIC_RELEASE_INGRESS_PROOF"])
    expect(pairSwitchCodeEnabled({ ...env, [key]: undefined })).toBe(false);
  if (flag !== "true") {
    const sealed = { ...env, get FIREBASE_SERVICE_ACCOUNT() { throw new Error("Disabled CODE must not consume credentials"); } } as PairEnvironment;
    expect((await PairPublicationRuntime.outboundByHost[PAIR_OWNER_WRITE_HOST](new Request(`http://${PAIR_OWNER_WRITE_HOST}/`, {
      method: "PUT", headers: { "x-owner-kind": "switch-code" } }), sealed)).status).toBe(403);
  }
});
