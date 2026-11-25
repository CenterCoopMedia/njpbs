import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireReleaseSource } from "./require-release-source.mjs";
import { httpFault, providerCall } from "../../scripts/lib/provider-call.mjs";
import { requireMainCi } from "./require-main-ci.mjs";
import { repositoryMatches, workflowMatches } from "../../scripts/lib/repository-identity.mjs";
import { deploymentInputFingerprint, productionDeploymentInputs, readDeploymentManifest } from "../../scripts/render-development-config.mjs";
import targets from "../../functions/lib/publication-target.js";

const inputLabel = "org.njpbs.deployment-input-sha256";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
class ImageRefusal extends Error {}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const bytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// One publisher source builds a distinct image and Worker per target. The image
// name is the target's publisher Worker, so a development image can never carry
// the production name, tag or receipt.
export function publisherTarget(environment) {
  if (!["production", "development"].includes(environment)) throw new ImageRefusal("Publisher target must be production or development");
  return targets.publicationTarget(environment);
}

// Development replaces only the production resource names in the same source.
export function targetSource(source, target) {
  if (target.environment === "production") return source;
  const config = structuredClone(source);
  config.name = target.publisherWorker;
  config.containers[0].name = target.publisherWorker;
  config.r2_buckets = config.r2_buckets.map(bucket => ({ ...bucket, bucket_name: target.publicationBucket }));
  config.routes = [{ pattern: new URL(target.publisherOrigin).host, custom_domain: true }];
  // Only a development Worker carries the account pin its container checks before every upload.
  config.vars = { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "", ...config.vars };
  return config;
}

export async function verifySource({ sha, cwd = process.cwd(), env = process.env, request }) {
  if (!repositoryMatches(env.GITHUB_REPOSITORY, env, env.GITHUB_REPOSITORY_ID) ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "publisher-image.yml", env)) {
    throw new ImageRefusal("Publisher image workflow identity refused");
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new ImageRefusal("A full deploy SHA is required");
  try { requireReleaseSource({ sha, cwd }); }
  catch { throw new ImageRefusal("Publisher source must be clean and on main at the exact SHA"); }
  try { return await requireMainCi({ repository: env.GITHUB_REPOSITORY, sha, request, env }); }
  catch { throw new ImageRefusal("No successful main CI/ci proof for publisher source"); }
}

// Wrangler's managed-registry API issues a short-lived pull credential. Keep it
// in memory; response bodies and authorization headers never enter logs/files.
export async function registryReader(account, token, imageName, send = fetch) {
  // A registry read that failed at the provider is asked again. Every other
  // answer, a missing tag among them, belongs to the caller.
  const request = (url, options) => providerCall("registry read", async () => {
    const answer = await send(url, options);
    if (answer.status >= 500 || [408, 425, 429].includes(answer.status)) {
      await answer.body?.cancel?.();
      throw httpFault(answer);
    }
    return answer;
  });
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
    method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiration_minutes: 15, permissions: ["pull"] }),
  });
  if (!response.ok) throw new ImageRefusal("Registry read credential refused");
  const envelope = await response.json();
  if (envelope.success !== true || typeof envelope.result?.password !== "string" || !envelope.result.password) {
    throw new ImageRefusal("Registry read credential missing");
  }
  const authorization = `Basic ${Buffer.from(`v1:${envelope.result.password}`).toString("base64")}`;
  return async (tag) => {
    const manifest = await request(`https://registry.cloudflare.com/v2/${account}/${imageName}/manifests/${tag}`, {
      method: "GET", redirect: "error",
      headers: { Authorization: authorization, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    });
    if (manifest.status === 404) return null;
    if (!manifest.ok) throw new ImageRefusal("Registry manifest lookup refused");
    const digest = manifest.headers.get("Docker-Content-Digest");
    const raw = Buffer.from(await manifest.arrayBuffer());
    if (!digestPattern.test(digest ?? "") || `sha256:${sha256(raw)}` !== digest) {
      throw new ImageRefusal("Registry manifest digest differs");
    }
    const configDigest = JSON.parse(raw).config?.digest;
    if (!digestPattern.test(configDigest ?? "")) throw new ImageRefusal("Registry image config digest missing");
    const blobUrl = `https://registry.cloudflare.com/v2/${account}/${imageName}/blobs/${configDigest}`;
    let blob = await request(blobUrl, {
      method: "GET", redirect: "manual", headers: { Authorization: authorization },
    });
    // Distribution permits a storage redirect. Never forward registry credentials.
    if ([302, 307].includes(blob.status)) {
      const location = blob.headers.get("Location");
      if (!location) throw new ImageRefusal("Registry blob redirect missing");
      const download = new URL(location, blobUrl);
      if (download.protocol !== "https:" || download.username || download.password) throw new ImageRefusal("Registry blob redirect refused");
      blob = await request(download.href, { method: "GET", redirect: "error" });
    }
    if (!blob.ok) throw new ImageRefusal("Registry image config lookup refused");
    const configBytes = Buffer.from(await blob.arrayBuffer());
    if (`sha256:${sha256(configBytes)}` !== configDigest) throw new ImageRefusal("Registry image config digest differs");
    return { digest, inputFingerprint: JSON.parse(configBytes).config?.Labels?.[inputLabel] };
  };
}

export async function publishImage({ sha, account, imageName, inputFingerprint, lookup, build }) {
  if (!/^[a-f0-9]{64}$/.test(inputFingerprint ?? "")) throw new ImageRefusal("Deployment input fingerprint missing");
  let record = await lookup(sha);
  if (!record) {
    try { await build(`${imageName}:${sha}`); }
    catch (error) {
      // A push can land before the command fails; the registry says whether it did.
      record = await lookup(sha);
      if (!record) throw error;
    }
    record ??= await lookup(sha);
  }
  if (!digestPattern.test(record?.digest ?? "")) throw new ImageRefusal("Published image digest missing");
  if (record.inputFingerprint !== inputFingerprint) throw new ImageRefusal("Existing SHA image has different deployment inputs; use a new source commit");
  // Verify the immutable address, including on a reused SHA tag.
  const immutable = await lookup(record.digest);
  if (immutable?.digest !== record.digest || immutable.inputFingerprint !== inputFingerprint) throw new ImageRefusal("Immutable image readback differs");
  return `registry.cloudflare.com/${account}/${imageName}@${record.digest}`;
}

export function productionConfig(source, prepared, { checkout, sha, image, variables, target = publisherTarget("production") }) {
  const imageName = target.publisherWorker;
  if (variables.CMS_DEPLOYMENT_ENVIRONMENT !== target.environment || variables.PUBLICATION_SERIALIZER_ID !== target.serializerId ||
      source.main !== "worker.ts" || source.containers?.length !== 1 ||
      source.containers[0].image !== "./Dockerfile" || source.containers[0].image_build_context !== "./build" ||
      !path.isAbsolute(checkout) || !/^[a-f0-9]{40}$/.test(sha) ||
      !/^[a-f0-9]{32}$/.test(variables.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      (source.account_id !== undefined && source.account_id !== variables.CLOUDFLARE_ACCOUNT_ID) ||
      (target.environment === "development" && variables.CMS_DEV_CLOUDFLARE_ACCOUNT_ID !== variables.CLOUDFLARE_ACCOUNT_ID) ||
      variables.PUBLICATION_ENABLED !== "true" ||
      JSON.stringify(Object.keys(source.vars).sort()) !== JSON.stringify(Object.keys(variables).sort()) ||
      Object.values(variables).some(value => typeof value !== "string") ||
      !image.startsWith(`registry.cloudflare.com/${variables.CLOUDFLARE_ACCOUNT_ID}/${imageName}@`) ||
      !digestPattern.test(image.split("@")[1] ?? "")) {
    throw new ImageRefusal("Publisher source/config contract refused");
  }
  const config = structuredClone(prepared);
  config.account_id = variables.CLOUDFLARE_ACCOUNT_ID;
  config.main = path.join(checkout, "publisher/worker.ts");
  config.vars = { ...variables, PUBLICATION_COMMIT_SHA: sha };
  config.containers[0].image = image;
  delete config.containers[0].image_build_context;
  const expected = structuredClone(source);
  expected.account_id = config.account_id;
  expected.main = config.main;
  expected.vars = config.vars;
  expected.containers[0].image = image;
  delete expected.containers[0].image_build_context;
  // Same structural comparison as release_publisher_run.go; key order is immaterial.
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(config))) throw new ImageRefusal("Prepared configuration differs from exact source");
  return config;
}

export function receiptFiles({ sha, image, config, runId, checkout, inputFingerprint, target = publisherTarget("production") }) {
  if (!/^[1-9][0-9]*$/.test(runId)) throw new ImageRefusal("Workflow run ID missing");
  const configBytes = bytes(config);
  if (target.environment === "production") return {
    "publisher.json": configBytes,
    "receipt.json": bytes({ schema: 1, source_sha: sha, image, config: "publisher.json", config_sha256: sha256(configBytes), workflow_run_id: runId, source_checkout: checkout, deployment_input_sha256: inputFingerprint }),
  };
  // A development Worker bundles development templates, so a config pointing at
  // this unrendered checkout is not deployable. A future development deployer
  // must render its checkout with the inputs this fingerprint records.
  return {
    "receipt.json": bytes({ schema: 1, target: target.environment, source_sha: sha, image, workflow_run_id: runId, deployment_input_sha256: inputFingerprint }),
  };
}

// Prepares the exact source for one target and returns its deployment input
// fingerprint. The image workflow and the development installer share it.
export function prepareTarget({ sha, target, variables, checkout, source, env }) {
  const prepared = JSON.parse(command(process.execPath, ["scripts/prepare-cloud-publisher.mjs", sha,
    // Older source commits accept only the SHA; production keeps that call.
    ...(target.environment === "production" ? [] : [target.environment])], {
    cwd: checkout,
    env: { ...env, CLOUDFLARE_ACCOUNT_ID: variables.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PUBLIC_WORKER_TAG: variables.CLOUDFLARE_PUBLIC_WORKER_TAG, PUBLIC_SHARE_UPLOAD_ORIGIN: variables.PUBLIC_SHARE_UPLOAD_ORIGIN },
  }));
  if (prepared.commitSha !== sha) throw new ImageRefusal("Prepared source SHA differs");
  productionConfig(source, targetSource(json(prepared.configPath), target), {
    checkout, sha, variables, target, image: `registry.cloudflare.com/${variables.CLOUDFLARE_ACCOUNT_ID}/${target.publisherWorker}@sha256:${"0".repeat(64)}`,
  });
  const manifest = readDeploymentManifest(prepared.source);
  const inputs = json(path.join(prepared.source, ".rendered-deployment-inputs.json")).inputs;
  // Development renders every input; production renders only its own.
  const names = target.environment === "production" ? productionDeploymentInputs : Object.keys(manifest.inputs);
  const paths = names.flatMap(name => manifest.inputs[name].files);
  const inputFingerprint = deploymentInputFingerprint(paths, inputs, manifest);
  if (!/^[a-f0-9]{64}$/.test(inputFingerprint)) throw new ImageRefusal("Prepared deployment input fingerprint missing");
  return { prepared, inputFingerprint };
}

// Child output can hold credentials and these logs are public: only Wrangler's
// numeric API code is taken from it.
export function childFailure(error) {
  const status = Number.isInteger(error?.status) ? `exit ${error.status}` : "exit unknown";
  const signal = /^SIG[A-Z0-9]{2,12}$/.test(error?.signal ?? "") ? `, signal ${error.signal}` : "";
  const code = /\[code: (\d{1,6})\]/.exec(String(error?.stderr ?? ""))?.[1] ??
    (/^E[A-Z0-9_]{2,30}$/.test(error?.code ?? "") ? error.code : null);
  return `Publisher image command failed (${status}${signal}${code === null ? "" : `, code ${code}`}); child output withheld`;
}

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    throw new ImageRefusal(childFailure(error));
  }
}

async function main(mode, env = process.env) {
  const sha = env.SOURCE_SHA, checkout = process.cwd();
  const target = publisherTarget(env.PUBLISHER_TARGET), imageName = target.publisherWorker;
  const source = () => targetSource(json("publisher/wrangler.json"), target);
  const metadataPath = path.join(env.RUNNER_TEMP, "publisher-image-prepared.json");
  if (mode === "verify") {
    await verifySource({ sha, env, request: async route => {
      const response = await fetch(`https://api.github.com${route}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}` },
        redirect: "error",
      });
      if (!response.ok) throw new ImageRefusal("Source CI lookup refused");
      return response.json();
    } });
  } else if (mode === "prepare") {
    // The development pin comes from its own repository variable, separate from the account in the vars JSON.
    const variables = { ...JSON.parse(env.PUBLISHER_PUBLIC_VARS_JSON),
      ...(target.environment === "development" ? { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: env.CMS_DEV_CLOUDFLARE_ACCOUNT_ID ?? "" } : {}) };
    const { prepared, inputFingerprint } = prepareTarget({ sha, target, variables, checkout, source: source(), env });
    const dockerfile = readFileSync(path.join(prepared.source, "publisher/Dockerfile"), "utf8");
    writeFileSync(path.join(prepared.directory, "Dockerfile"), `${dockerfile}\nLABEL ${inputLabel}="${inputFingerprint}"\n`);
    writeFileSync(metadataPath, bytes({ ...prepared, variables, inputFingerprint }), { mode: 0o600 });
  } else if (mode === "image") {
    const prepared = json(metadataPath), account = prepared.variables.CLOUDFLARE_ACCOUNT_ID;
    if (!/^[a-f0-9]{32}$/.test(account ?? "") || !env.CLOUDFLARE_API_TOKEN) throw new ImageRefusal("Registry configuration missing");
    const image = await publishImage({ sha, account, imageName, inputFingerprint: prepared.inputFingerprint,
      lookup: async ref => (await registryReader(account, env.CLOUDFLARE_API_TOKEN, imageName))(ref),
      build: tag => command(process.execPath, [prepared.wrangler, "containers", "build", prepared.directory, "--push", "--tag", tag], {
        env: { ...env, CLOUDFLARE_ACCOUNT_ID: account },
      }),
    });
    const config = productionConfig(source(), targetSource(json(prepared.configPath), target), { checkout, sha, image, target, variables: prepared.variables });
    const directory = path.join(env.RUNNER_TEMP, "publisher-image-receipt");
    mkdirSync(directory);
    for (const [name, content] of Object.entries(receiptFiles({ sha, image, config, checkout, target, runId: env.GITHUB_RUN_ID, inputFingerprint: prepared.inputFingerprint }))) writeFileSync(path.join(directory, name), content);
  } else throw new ImageRefusal("Expected verify, prepare or image");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error instanceof ImageRefusal ? error.message : "Publisher image step failed; credential-bearing output withheld."); process.exitCode = 1; });
}
