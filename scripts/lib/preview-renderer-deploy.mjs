// Puts one preview renderer version live: image first, then the pause, the Worker and the container.
import { isDeepStrictEqual } from "node:util";
import { PREVIEW_RUNTIME_DOCUMENT, parsePreviewRuntimeControl, previewRuntimeDrained } from "../../site/scripts/cms-preview-cloud-control.ts";

/**
 * `api(path, init)` answers a Cloudflare result, or null for an absent resource.
 * `pushImage()` and `deploy()` run Wrangler; `deploy` uploads the Worker and names the pushed image.
 */
export async function deployPreviewRenderer({ firestore, sha, name, api, pushImage, deploy, sleep, log = console.log }) {
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  const deployments = `/workers/scripts/${name}/deployments`;
  const starting = { schemaVersion: 1, phase: "starting", rendererSha: sha, serializerId: "cloudflare-preview" };
  const serving = async () => {
    const app = (await api("/containers/applications")).find(row => row.name === name);
    const list = app && await api(`/containers/applications/${app.id}/rollouts?limit=10`);
    const [rollout] = (Array.isArray(list) ? list : list?.rollouts ?? []).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { app, rollout, worker: (await api(deployments))?.deployments?.[0] };
  };

  // A refused token or a failed build ends here, while previews still work.
  await pushImage();
  const before = await serving();
  const newRollout = now => now.rollout && now.rollout.id !== before.rollout?.id ? now.rollout : null;

  let previous;
  // Previews return on what Cloudflare serves. The old container with the new Worker serves
  // none, so the old Worker version is put back. Answers false while a new container rolls out.
  const restore = () => openPrevious().catch(error => { log(`Previews were not restored: ${error.message}`); return true; });
  async function openPrevious() {
    if (previous?.phase !== "ready") return true;
    const now = await serving(), rollout = newRollout(now);
    if (rollout && rollout.status !== "reverted") return false;
    if (before.worker && now.worker?.id !== before.worker.id) {
      log("Putting the previous Worker version back");
      await api(deployments, { method: "POST", body: JSON.stringify({ strategy: "percentage",
        versions: before.worker.versions.map(({ version_id, percentage }) => ({ version_id, percentage })) }) });
    }
    await firestore.runTransaction(async transaction => {
      const control = (await transaction.get(ref)).data();
      if ([starting, { ...previous, phase: "paused" }].some(own => isDeepStrictEqual(control, own))) transaction.set(ref, previous);
    });
    log("Previews are open on the previous renderer");
    return true;
  }

  let failure;
  try {
    // Admission stays closed until the new renderer reports ready; admitted work finishes on the old one.
    await firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? parsePreviewRuntimeControl(snapshot.data()) : { ...starting };
      // Kept also when the answer to this write is lost. A repeat reads the pause that landed.
      if (!previous || !isDeepStrictEqual(current, { ...previous, phase: "paused" })) previous = current;
      transaction.set(ref, { ...current, phase: "paused" });
    });
    while (!await previewRuntimeDrained(firestore)) { log("Waiting for admitted previews"); await sleep(10); }
    await ref.set(starting);
    await deploy();
  } catch (error) {
    if (await restore()) throw error;
    failure = error;
    log(`${error.message}\nThe new container rolls out; previews return when it reports ready`);
  }

  for (let last = ""; ;) {
    const control = (await ref.get()).data();
    if (control?.rendererSha !== sha) throw new Error("Another renderer took over the release");
    if (control.phase === "ready") break;
    const now = await serving(), rollout = newRollout(now);
    const errors = now.rollout?.health?.errors?.map(row => row.event?.message).filter(Boolean).slice(-2).join("; ");
    const line = `control ${control.phase}, rollout ${now.rollout?.status ?? "none"}, instances ${JSON.stringify(now.app?.health?.instances ?? {})}${errors ? `, ${errors}` : ""}`;
    if (line !== last) log(last = line);
    if (rollout?.status === "reverted") {
      await restore();
      throw new Error(`Container rollout reverted: ${errors}`);
    }
    await sleep(10);
  }
  if (failure) throw failure;
}
