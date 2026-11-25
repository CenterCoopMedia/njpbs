// Deploys the preview renderer Worker and its container, then waits until the container reports ready.
// Run through deploy-cms.mjs; needs the tsx loader.
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { cmsTarget } from "./lib/cms-target.mjs";
import { prepareDevPreviewRenderer, preparePreviewRenderer } from "./prepare-preview-renderer.mjs";
import { repeatNetworkFault } from "./lib/network-fault.mjs";
import { deployPreviewRenderer } from "./lib/preview-renderer-deploy.mjs";
import { PREVIEW_RUNTIME_DOCUMENT } from "../site/scripts/cms-preview-cloud-control.ts";

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
const api = (path, init) => repeatNetworkFault(`Cloudflare ${path}`, async () => {
  const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}${path}`,
    { ...init, headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  const body = await reply.json().catch(() => null);
  if (reply.status === 404) return null;
  if (!reply.ok) throw new Error(`Cloudflare HTTP ${reply.status}: ${JSON.stringify(body?.errors)}`);
  return body.result;
});
const prepared = await (dev ? prepareDevPreviewRenderer : preparePreviewRenderer)(sha);
const run = (command, args) => new Promise((done, reject) => {
  let output = "";
  const child = spawn(command, args, { cwd: prepared.source, stdio: ["ignore", "pipe", "pipe"], env: { PATH: env.PATH, HOME: env.HOME, CI: "true", WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } });
  for (const stream of ["stdout", "stderr"]) child[stream].on("data", chunk => { process[stream].write(chunk); output = (output + chunk).slice(-6000); });
  child.on("error", reject).on("close", code => code === 0 ? done()
    : reject(Object.assign(new Error(`${args.slice(1, 3).join(" ")} exited ${code}`), { output })));
});
const wrangler = (...args) => repeatNetworkFault(`wrangler ${args[0]}`, () => run(process.execPath, [prepared.wrangler, ...args]));
const config = JSON.parse(readFileSync(prepared.configPath, "utf8"));
const image = `${config.containers[0].name}:${sha.slice(0, 12)}-${Date.now()}`;
const registryImage = `registry.cloudflare.com/${env.CLOUDFLARE_ACCOUNT_ID}/${image}`;
try {
  await deployPreviewRenderer({ firestore, sha, name: target.rendererWorker, api, sleep,
    async pushImage() {
      copyFileSync(config.containers[0].image, join(prepared.directory, "Dockerfile"));
      await wrangler("containers", "build", prepared.directory, "--tag", image);
      await wrangler("containers", "push", image);
      config.vars.PREVIEW_RENDERER_ENABLED = "true";
      config.containers[0].image = registryImage;
      delete config.containers[0].image_build_context;
      writeFileSync(prepared.configPath, JSON.stringify(config));
    },
    async deploy() {
      const secrets = join(prepared.directory, "secrets.json");
      writeFileSync(secrets, JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: env.CMS_PREVIEW_FIREBASE_ACCOUNT, R2_PREVIEW_CREDENTIAL: env.CMS_PREVIEW_R2_CREDENTIAL,
        ...(dev ? { CMS_DEV_ACCESS_CLIENT_ID: env.CMS_DEV_ACCESS_CLIENT_ID, CMS_DEV_ACCESS_CLIENT_SECRET: env.CMS_DEV_ACCESS_CLIENT_SECRET } : {}) }), { mode: 0o600 });
      await wrangler("deploy", "--config", prepared.configPath, "--secrets-file", secrets);
    } });
  console.log(`Preview renderer ready at ${sha}`);
} finally {
  await run("docker", ["image", "rm", image, registryImage]).catch(() => {}); // absent after a failed build
  rmSync(prepared.directory, { recursive: true, force: true });
}
process.exit(0);
