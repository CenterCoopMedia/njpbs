import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import type { Firestore } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deployPreviewRenderer } from "../../scripts/lib/preview-renderer-deploy.mjs";

const NAME = "example-renderer";
const OLD = "a".repeat(40), NEW = "b".repeat(40);
const READY = { schemaVersion: 1, phase: "ready", rendererSha: OLD, serializerId: "cloudflare-preview", liveBlogVersion: 1 };
let db: Firestore;
const control = () => db.doc("system/cmsPreviewRuntime");
const read = async () => (await control().get()).data();

/** Cloudflare with one Worker and one container application. */
function cloudflare() {
  const workers = [{ id: "worker-old", versions: [{ version_id: "version-old", percentage: 100 }] }];
  const rollouts = [{ id: "rollout-old", status: "completed", created_at: "2026-11-25T20:00:00Z" }];
  const app = { id: "app", name: NAME, configuration: { image: "image-old", vcpu: 1 } };
  const api = async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/containers/applications") return [structuredClone(app)];
    if (path === "/containers/applications/app" && init?.method === "PATCH") return Object.assign(app, JSON.parse(init.body!));
    if (path === "/containers/applications/app/rollouts?limit=10") return { rollouts: [...rollouts] };
    if (path === `/workers/scripts/${NAME}/deployments`) {
      if (init?.method === "POST") workers.unshift({ id: `worker-${workers.length}`, versions: JSON.parse(init.body!).versions });
      return { deployments: structuredClone(workers) };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { api, app, workers, rollouts,
    nameImage: () => { app.configuration = { image: "image-new", vcpu: 1 }; },
    uploadWorker: () => workers.unshift({ id: "worker-new", versions: [{ version_id: "version-new", percentage: 100 }] }),
    rollOut: () => rollouts.push({ id: "rollout-new", status: "progressing", created_at: "2026-11-25T22:00:00Z" }) };
}
const ready = () => control().set({ ...READY, rendererSha: NEW });
const run = (provider: ReturnType<typeof cloudflare>, options: Record<string, unknown> = {}) => deployPreviewRenderer({ firestore: db, sha: NEW, name: NAME,
  api: provider.api, pushImage: async () => {}, deploy: async () => {}, sleep: ready, log: () => {}, ...options } as never);

beforeAll(() => { db = isolatedFirestore("preview-renderer-deploy.test.ts") as unknown as Firestore; });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await control().set(READY);
});

describe("preview renderer deploy", () => {
  it("pushes the image while previews are open and ends when the container is ready", async () => {
    const provider = cloudflare(), seen: unknown[] = [];
    await run(provider, { pushImage: async () => { seen.push((await read())?.phase); },
      deploy: async () => { seen.push((await read())?.phase); provider.uploadWorker(); provider.rollOut(); } });
    expect(seen).toEqual(["ready", "starting"]);
    expect(await read()).toMatchObject({ phase: "ready", rendererSha: NEW });
  });

  it("never pauses when the image cannot be pushed", async () => {
    await expect(run(cloudflare(), { pushImage: async () => { throw new Error("build failed"); } })).rejects.toThrow("build failed");
    expect(await read()).toEqual(READY);
  });

  it("never pauses when Cloudflare's current state cannot be read", async () => {
    const api = async () => { throw new Error("Cloudflare HTTP 403"); };
    await expect(run({ ...cloudflare(), api } as never)).rejects.toThrow("403");
    expect(await read()).toEqual(READY);
  });

  it("puts the old Worker back when only the Worker was uploaded", async () => {
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { provider.uploadWorker(); throw new Error("no rollout"); } })).rejects.toThrow("no rollout");
    expect(provider.workers[0].versions).toEqual([{ version_id: "version-old", percentage: 100 }]);
    expect(await read()).toEqual(READY);
  });

  it("puts the old container image back when the rollout was never asked for", async () => {
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { provider.uploadWorker(); provider.nameImage(); throw new Error("no rollout"); } })).rejects.toThrow("no rollout");
    expect(provider.app.configuration).toEqual({ image: "image-old", vcpu: 1 });
    expect(await read()).toEqual(READY);
  });

  it("keeps previews closed when Cloudflare does not take the old state back", async () => {
    const provider = cloudflare();
    const api = async (path: string, init?: { method?: string; body?: string }) => init?.method === "PATCH" ? null : provider.api(path, init);
    await expect(run({ ...provider, api } as never, { deploy: async () => { provider.nameImage(); throw new Error("no rollout"); } })).rejects.toThrow("no rollout");
    expect((await read())?.phase).toBe("starting");
  });

  it("opens previews without a Worker write when nothing was uploaded", async () => {
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { throw new Error("refused"); } })).rejects.toThrow("refused");
    expect(provider.workers).toHaveLength(1);
    expect(await read()).toEqual(READY);
  });

  it("waits for the new container when its rollout started, then reports the failure", async () => {
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { provider.uploadWorker(); provider.rollOut(); throw new Error("after the rollout"); } }))
      .rejects.toThrow("after the rollout");
    expect(provider.workers[0].id).toBe("worker-new");
    expect(await read()).toMatchObject({ phase: "ready", rendererSha: NEW });
  });

  it("puts the old Worker back when Cloudflare reverts the rollout", async () => {
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { provider.uploadWorker(); provider.rollOut(); provider.rollouts[1].status = "reverted"; } }))
      .rejects.toThrow("Container rollout reverted");
    expect(provider.workers[0].versions[0].version_id).toBe("version-old");
    expect(await read()).toEqual(READY);
  });

  it("restores the control that was live at the pause, also when the pause answer was lost", async () => {
    const provider = cloudflare();
    const changed = { ...READY, electionResultsVersion: 2 };
    const lost = new Proxy(db, { get: (target, key) => key === "runTransaction" ? async (work: never) => {
      await db.runTransaction(work);
      if ((await read())?.phase === "paused") throw new Error("answer lost");
    } : typeof (target as never)[key] === "function" ? (target as never as Record<PropertyKey, CallableFunction>)[key].bind(target) : (target as never)[key] });
    await expect(run(provider, { firestore: lost, pushImage: async () => { await control().set(changed); } })).rejects.toThrow("answer lost");
    expect(await read()).toEqual(changed);
  });

  it("leaves a control that another deploy took over, and a pause it did not make", async () => {
    const other = { ...READY, phase: "starting", rendererSha: "c".repeat(40) };
    const provider = cloudflare();
    await expect(run(provider, { deploy: async () => { await control().set(other); provider.uploadWorker(); throw new Error("refused"); } })).rejects.toThrow("refused");
    expect(await read()).toEqual(other);
    expect(provider.workers[0].id).toBe("worker-new");
    await control().set({ ...READY, phase: "paused" });
    await expect(run(cloudflare(), { deploy: async () => { throw new Error("refused"); } })).rejects.toThrow("refused");
    expect((await read())?.phase).not.toBe("ready");
  });
});
