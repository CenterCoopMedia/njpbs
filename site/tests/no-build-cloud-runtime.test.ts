// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  maintain: vi.fn(async () => {}), release: vi.fn(async () => {}), pass: null as null | (() => Promise<void>),
  retainPreview: vi.fn(async () => false),
  projection: null as null | (() => void),
}));
vi.mock("../scripts/no-build-post-background", () => ({ noBuildPostMaintenance: (input: { onPreviewProjection: () => void }) => {
  boundary.projection = input.onPreviewProjection;
  return boundary.maintain;
} }));
vi.mock("../scripts/no-build-post-maintenance-service", () => ({ startNoBuildPostMaintenanceService: (input: { maintain: () => Promise<void> }) => {
  boundary.pass = input.maintain;
  let finish!: () => void;
  return { closed: new Promise<void>(resolve => { finish = resolve; }), stop() { finish(); }, wake() {}, isRunning: () => false };
} }));
vi.mock("../scripts/public-worker-deployment-reconciliation-owner", () => ({ startPublicWorkerDeploymentReconciliationOwner: () => {
  let finish!: () => void;
  return { closed: new Promise<void>(resolve => { finish = resolve; }), stop() { finish(); } };
} }));
vi.mock("../scripts/no-build-cloud-release", () => ({ runNoBuildCloudRelease: boundary.release }));
vi.mock("../scripts/cloud-editorial-preview-retention", () => ({ cloudEditorialPreviewRetention: () => boundary.retainPreview }));
import { startNoBuildCloudRuntime } from "../scripts/no-build-cloud-runtime";
import { documents as postWorkDocuments } from "../../tests/no-build-cloud-contract";

beforeEach(() => { vi.clearAllMocks(); boundary.pass = null; });
const sha = "a".repeat(40);
const operationId = "11111111111111111111";
const runtime = { owner: "cloudflare", release: sha };

it("starts retention when the projection seals while public compilation is still pending", async () => {
  const documents = postWorkDocuments();
  const firestore = { doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: async () => ({ docs: [] }) }) };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  boundary.maintain.mockImplementationOnce(async () => { boundary.projection!(); await blocked; });
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  const pass = boundary.pass!();
  try {
    await vi.waitFor(() => expect(boundary.retainPreview).toHaveBeenCalledOnce());
    expect(boundary.release).not.toHaveBeenCalled();
  } finally { owner.stop(); release(); await pass; await owner.closed; }
});

it.each(["missing", "invalid", "excluded", "wrong-owner", "wrong-release"])(
  "enumerates family-owned reserved removals at the production wake entry (%s)", async mode => {
    const state = { schemaVersion: 1, mode: "dynamic", servingEnabled: true, rendererSha: sha, runtime,
      postId: "family-post", operationId, sourceVersion: 2, slug: "family-story", visible: false,
      ownedSlugs: ["family-story"], generation: 3 };
    if (mode === "wrong-owner") state.runtime = { ...runtime, owner: "node-compute" };
    if (mode === "wrong-release") state.rendererSha = "b".repeat(40);
    const documents: Record<string, unknown> = {
      "system/publicDeployment": { state: "idle", activeCommitSha: sha },
      [`cmsPublishQueue/${operationId}`]: { transport: "post-no-build-v1", backgroundRuntime: state.runtime,
        noBuildPost: { postId: "family-post", operationId, sourceVersion: 2 }, homeFullBuild: { status: "reserved" } },
    };
    if (mode === "invalid") documents["system/noBuildPostAdmission"] = { schemaVersion: 99 };
    if (mode === "excluded") documents["system/noBuildPostAdmission"] = { schemaVersion: 2, revision: 2,
      enabled: false, families: { posts: { mode: "ids", ids: ["other-post"] } } };
    const enumerate = vi.fn(async () => ({ docs: [{ data: () => state }] }));
    const firestore = {
      doc: (path: string) => ({ get: async () => ({ data: () => documents[path] }) }),
      collection: (path: string) => {
        expect(path).toBe("system/publicDeployment/noBuildPostOwners");
        return { get: enumerate };
      },
    };
    const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
      stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
      previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
    await boundary.pass!();
    expect(enumerate).toHaveBeenCalledOnce();
    expect(boundary.maintain).toHaveBeenCalledTimes(["wrong-owner", "wrong-release"].includes(mode) ? 0 : 1);
    owner.stop();
  });

it.each([false, true])("runs private retention without hiding public work or release when private refusal is %s", async refuses => {
  const documents = postWorkDocuments();
  delete documents[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  const firestore = {
    doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  if (refuses) boundary.retainPreview.mockRejectedValueOnce(new Error("Fixture private refusal"));
  try {
    await expect(boundary.pass!()).resolves.toBeUndefined();
    owner.stop(); await owner.closed;
    expect(boundary.retainPreview).toHaveBeenCalledOnce(); expect(boundary.maintain).toHaveBeenCalledOnce();
    expect(boundary.maintain.mock.invocationCallOrder[0]).toBeLessThan(boundary.retainPreview.mock.invocationCallOrder[0]);
    expect(boundary.release).toHaveBeenCalledOnce();
    if (refuses) expect(JSON.stringify(log.mock.calls)).not.toContain("Fixture private refusal");
  } finally { owner.stop(); log.mockRestore(); }
});

it("keeps public passes independent of a blocked private restore and drains its single tracked task", async () => {
  const documents = postWorkDocuments();
  delete documents[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  let unblock!: () => void, reached!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const started = new Promise<void>(resolve => { reached = resolve; });
  boundary.retainPreview.mockImplementationOnce(async () => { reached(); await blocked; return false; });
  const firestore = {
    doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  const pass = boundary.pass!();
  await started;
  try {
    expect(boundary.release).toHaveBeenCalledOnce();
    await pass; await boundary.pass!();
    expect(boundary.maintain).toHaveBeenCalledTimes(2); expect(boundary.release).toHaveBeenCalledTimes(2);
    expect(boundary.retainPreview).toHaveBeenCalledOnce(); expect(owner.isRunning()).toBe(true);
    owner.stop(); let closed = false; void owner.closed.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    unblock(); await owner.closed; expect(closed).toBe(true); expect(owner.isRunning()).toBe(false);
  } finally { unblock(); await pass; owner.stop(); await owner.closed; }
});

it.each(["stopped", "deploying"])("keeps private-start and public-release guards under %s", async guard => {
  const documents = postWorkDocuments(); delete documents[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  if (guard === "deploying") documents["system/publicDeployment"].state = "deploying";
  const firestore = {
    doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  if (guard === "stopped") owner.stop();
  await boundary.pass!(); owner.stop(); await owner.closed;
  expect(boundary.retainPreview).not.toHaveBeenCalled(); expect(boundary.release).not.toHaveBeenCalled();
});

it("holds maintenance, release and private retention during a billing stop, then resumes", async () => {
  let previewStarted!: () => void;
  const retained = new Promise<void>(resolve => { previewStarted = resolve; });
  boundary.retainPreview.mockImplementationOnce(async () => { previewStarted(); return false; });
  const documents = postWorkDocuments();
  Object.assign(documents["system/publicDeployment/aggregateContexts/current"], {
    finalNamespaceOwner: true, namespaceOperationId: "D".repeat(20),
  });
  delete documents[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  documents["system/billing"] = { disabled: true };
  documents["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase: "ready",
    commitSha: sha, serializerId: "cloudflare-publisher" };
  const enumerate = vi.fn(async () => ({ docs: [] }));
  const firestore = {
    doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: enumerate }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  try {
    await boundary.pass!();
    expect(enumerate).not.toHaveBeenCalled();
    expect(boundary.maintain).not.toHaveBeenCalled();
    expect(boundary.release).not.toHaveBeenCalled();
    expect(boundary.retainPreview).not.toHaveBeenCalled();
    documents["system/billing"].disabled = false;
    documents["system/cmsPublicationRuntime"].phase = "ready";
    await boundary.pass!();
    await retained;
    owner.stop(); await owner.closed;
    expect(boundary.maintain).toHaveBeenCalledOnce();
    expect(boundary.release).toHaveBeenCalledOnce();
    expect(boundary.retainPreview).toHaveBeenCalledOnce();
  } finally { owner.stop(); }
});

it.each(["paused", "starting"])("drains accepted work and runs staged releases during %s runtime admission", async phase => {
  const documents = postWorkDocuments();
  documents["system/cmsPublicationRuntime"] = { schemaVersion: 1, phase, commitSha: sha, serializerId: "cloudflare-publisher" };
  const firestore = {
    doc: (name: string) => ({ get: async () => ({ data: () => documents[name] }) }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  try {
    await boundary.pass!();
    expect(boundary.maintain).toHaveBeenCalledOnce();
    expect(boundary.release).toHaveBeenCalledOnce();
  } finally { owner.stop(); await owner.closed; }
});

it("does not start private retention after stop while its billing read is pending", async () => {
  const documents = postWorkDocuments();
  Object.assign(documents["system/publicDeployment/aggregateContexts/current"], {
    finalNamespaceOwner: true, namespaceOperationId: "D".repeat(20),
  });
  delete documents[`cmsPublishQueue/${"D".repeat(20)}`].previewContext;
  let reads = 0, reach!: () => void, unblock!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const firestore = {
    doc: (name: string) => ({ get: async () => {
      if (name === "system/billing" && ++reads === 3) { reach(); await blocked; }
      return { data: () => documents[name] };
    } }),
    collection: () => ({ get: async () => ({ docs: [] }) }),
  };
  const owner = startNoBuildCloudRuntime({ firestore, firebaseApp: {}, commitSha: sha, serializerId: "cloud-fixture",
    stateDirectory: "/fixture", buildEnvironment: {}, cloudflareApiToken: "", storage: { target: { backgroundBucket: "fixture-bucket" } },
    previewStorageCredential: {}, mediaManagerCredential: {} } as unknown as Parameters<typeof startNoBuildCloudRuntime>[0]);
  try {
    await boundary.pass!(); await reached;
    owner.stop(); unblock(); await owner.closed;
    expect(boundary.retainPreview).not.toHaveBeenCalled();
  } finally { unblock(); owner.stop(); await owner.closed; }
});
