// Deploys the preview renderer Worker and its container, then waits until the container reports ready.
// Run through deploy-cms.mjs; needs the tsx loader.
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { cmsTarget } from "./lib/cms-target.mjs";
import { prepareDevPreviewRenderer, preparePreviewRenderer } from "./prepare-preview-renderer.mjs";
import { PREVIEW_RUNTIME_DOCUMENT, pausePreviewRuntime, previewRuntimeDrained } from "../site/scripts/cms-preview-cloud-control.ts";

const require = createRequire(import.meta.url);
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const [sha, always] = process.argv.slice(2);
const target = cmsTarget();
const dev = target.environment === "development";
const env = process.env;
const firestore = getFirestore(initializeApp({ credential: applicationDefault(), projectId: target.projectId }));
const sleep = seconds => new Promise(done => setTimeout(done, seconds * 1000));

const live = (await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data();
if (!always && live?.phase === "ready" && live.rendererSha === sha) { console.log(`The renderer is live at ${sha}`); process.exit(0); }

if (dev) {
  // The container never reports ready when this client cannot read the dev site, and reports no reason.
  const reply = await fetch(`${target.publicOrigin}/_publication.json`, { redirect: "manual",
    headers: { "CF-Access-Client-Id": env.CMS_DEV_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CMS_DEV_ACCESS_CLIENT_SECRET } });
  if (reply.status !== 200) throw new Error(`CMS_DEV_ACCESS_CLIENT_ID cannot read ${target.publicOrigin}: HTTP ${reply.status}`);
}
const api = async path => {
  const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  const body = await reply.json().catch(() => null);
  if (reply.status >= 500 || reply.status === 429) return null; // read again on the next turn
  if (!reply.ok) throw new Error(`Cloudflare HTTP ${reply.status}: ${JSON.stringify(body?.errors)}`);
  return body.result;
};
const containers = "/containers/applications";
const deployed = async () => (await api(`/workers/scripts/${target.rendererWorker}/deployments`))?.deployments?.[0]?.id;
const prepared = await (dev ? prepareDevPreviewRenderer : preparePreviewRenderer)(sha);
try {
  // A refused token ends here, while previews still work.
  const before = live && await deployed();
  const starting = { schemaVersion: 1, phase: "starting", rendererSha: sha, serializerId: "cloudflare-preview" };
  let uploading = false;
  try {
    // Admission stays closed until the new renderer reports ready; admitted work finishes on the old one.
    await pausePreviewRuntime(firestore, sha);
    while (!await previewRuntimeDrained(firestore)) { console.log("Waiting for admitted previews"); await sleep(10); }
    const config = JSON.parse(readFileSync(prepared.configPath, "utf8"));
    config.vars.PREVIEW_RENDERER_ENABLED = "true";
    writeFileSync(prepared.configPath, JSON.stringify(config));
    const secrets = join(prepared.directory, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: env.CMS_PREVIEW_FIREBASE_ACCOUNT, R2_PREVIEW_CREDENTIAL: env.CMS_PREVIEW_R2_CREDENTIAL,
      ...(dev ? { CMS_DEV_ACCESS_CLIENT_ID: env.CMS_DEV_ACCESS_CLIENT_ID, CMS_DEV_ACCESS_CLIENT_SECRET: env.CMS_DEV_ACCESS_CLIENT_SECRET } : {}) }), { mode: 0o600 });
    await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).set(starting);
    uploading = true;
    await new Promise((done, reject) => spawn(process.execPath, [prepared.wrangler, "deploy", "--config", prepared.configPath, "--secrets-file", secrets],
      { cwd: prepared.source, stdio: ["ignore", "inherit", "inherit"], env: { PATH: env.PATH, HOME: env.HOME, CI: "true", WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } })
      .on("error", reject).on("close", code => code === 0 ? done() : reject(new Error(`wrangler deploy exited ${code}`))));
  } catch (error) {
    // While Cloudflare still serves the old version, the old renderer takes previews again.
    if (live?.phase === "ready" && (!uploading || before && await deployed() === before)) await firestore.runTransaction(async transaction => {
      const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT), now = (await transaction.get(ref)).data();
      if ([starting, { ...live, phase: "paused" }].some(own => isDeepStrictEqual(now, own))) transaction.set(ref, live);
    });
    throw error;
  }

  for (let last = ""; ;) {
    const control = (await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data();
    if (control?.rendererSha !== sha) throw new Error("Another renderer took over the release");
    if (control.phase === "ready") break;
    const app = (await api(containers))?.find(row => row.name === target.rendererWorker);
    const rollouts = app && await api(`${containers}/${app.id}/rollouts?limit=10`);
    const rollout = (Array.isArray(rollouts) ? rollouts : rollouts?.rollouts ?? [])
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    const errors = rollout?.health?.errors?.map(row => row.event?.message).filter(Boolean).slice(-2).join("; ");
    const line = `control ${control.phase}, rollout ${rollout?.status ?? "none"}, instances ${JSON.stringify(app?.health?.instances ?? {})}${errors ? `, ${errors}` : ""}`;
    if (line !== last) console.log(last = line);
    if (rollout?.status === "reverted") throw new Error(`Container rollout reverted: ${errors}`);
    await sleep(10);
  }
  console.log(`Preview renderer ready at ${sha}`);
} finally { rmSync(prepared.directory, { recursive: true, force: true }); }
process.exit(0);
