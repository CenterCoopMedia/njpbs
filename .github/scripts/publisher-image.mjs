import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireReleaseSource } from "./require-release-source.mjs";
import { requireMainCi } from "./require-main-ci.mjs";
import { repositoryMatches, workflowMatches } from "../../scripts/lib/repository-identity.mjs";

const imageName = "njpbs-cms-publisher";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const bytes = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function verifySource({ sha, cwd = process.cwd(), env = process.env, request }) {
  if (!repositoryMatches(env.GITHUB_REPOSITORY, env, env.GITHUB_REPOSITORY_ID) ||
      !workflowMatches(env.GITHUB_WORKFLOW_REF, "publisher-image.yml", env)) {
    throw new Error("Publisher image workflow identity refused");
  }
  requireReleaseSource({ sha, cwd });
  return requireMainCi({ repository: env.GITHUB_REPOSITORY, sha, request, env });
}

// Wrangler's managed-registry API issues a short-lived pull credential. Keep it
// in memory; response bodies and authorization headers never enter logs/files.
export async function registryReader(account, token, request = fetch) {
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiration_minutes: 15, permissions: ["pull"] }),
  });
  if (!response.ok) throw new Error("Registry read credential refused");
  const envelope = await response.json();
  if (envelope.success !== true || typeof envelope.result?.password !== "string" || !envelope.result.password) {
    throw new Error("Registry read credential missing");
  }
  const authorization = `Basic ${Buffer.from(`v1:${envelope.result.password}`).toString("base64")}`;
  return async (tag) => {
    const manifest = await request(`https://registry.cloudflare.com/v2/${account}/${imageName}/manifests/${tag}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: authorization, Accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" },
    });
    if (manifest.status === 404) return null;
    if (!manifest.ok) throw new Error("Registry manifest lookup refused");
    const digest = manifest.headers.get("Docker-Content-Digest");
    if (!digestPattern.test(digest ?? "") || `sha256:${sha256(Buffer.from(await manifest.arrayBuffer()))}` !== digest) {
      throw new Error("Registry manifest digest differs");
    }
    return digest;
  };
}

export async function publishImage({ sha, account, lookup, build }) {
  let digest = await lookup(sha);
  if (!digest) {
    await build(`${imageName}:${sha}`);
    digest = await lookup(sha);
  }
  if (!digestPattern.test(digest ?? "")) throw new Error("Published image digest missing");
  // Verify the immutable address, including on a reused SHA tag.
  if (await lookup(digest) !== digest) throw new Error("Immutable image readback differs");
  return `registry.cloudflare.com/${account}/${imageName}@${digest}`;
}

export function productionConfig(source, prepared, { checkout, sha, image, variables }) {
  if (source.main !== "worker.ts" || source.containers?.length !== 1 ||
      source.containers[0].image !== "./Dockerfile" || source.containers[0].image_build_context !== "./build" ||
      !path.isAbsolute(checkout) || !/^[a-f0-9]{40}$/.test(sha) ||
      !/^[a-f0-9]{32}$/.test(variables.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      (source.account_id !== undefined && source.account_id !== variables.CLOUDFLARE_ACCOUNT_ID) ||
      variables.PUBLICATION_ENABLED !== "true" ||
      JSON.stringify(Object.keys(source.vars).sort()) !== JSON.stringify(Object.keys(variables).sort()) ||
      Object.values(variables).some(value => typeof value !== "string") ||
      !image.startsWith(`registry.cloudflare.com/${variables.CLOUDFLARE_ACCOUNT_ID}/${imageName}@`) ||
      !digestPattern.test(image.split("@")[1] ?? "")) {
    throw new Error("Publisher source/config contract refused");
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
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(config))) throw new Error("Prepared configuration differs from exact source");
  return config;
}

export function receiptFiles({ sha, image, config, runId, checkout }) {
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error("Workflow run ID missing");
  const configBytes = bytes(config);
  return {
    "publisher.json": configBytes,
    "receipt.json": bytes({ schema: 1, source_sha: sha, image, config: "publisher.json", config_sha256: sha256(configBytes), workflow_run_id: runId, source_checkout: checkout }),
  };
}

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...options });
  } catch {
    // Child errors can retain credential-bearing output. Never print the error object.
    throw new Error("Publisher image command failed; child output withheld");
  }
}

async function main(mode, env = process.env) {
  const sha = env.SOURCE_SHA, checkout = process.cwd();
  const metadataPath = path.join(env.RUNNER_TEMP, "publisher-image-prepared.json");
  if (mode === "verify") {
    await verifySource({ sha, env, request: async route => {
      const response = await fetch(`https://api.github.com${route}`, {
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GH_TOKEN}` },
        redirect: "error", signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Source CI lookup refused");
      return response.json();
    } });
  } else if (mode === "prepare") {
    const variables = JSON.parse(env.PUBLISHER_PUBLIC_VARS_JSON);
    const prepared = JSON.parse(command(process.execPath, ["scripts/prepare-cloud-publisher.mjs", sha], {
      env: { ...env, CLOUDFLARE_ACCOUNT_ID: variables.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_PUBLIC_WORKER_TAG: variables.CLOUDFLARE_PUBLIC_WORKER_TAG, PUBLIC_SHARE_UPLOAD_ORIGIN: variables.PUBLIC_SHARE_UPLOAD_ORIGIN },
    }));
    if (prepared.commitSha !== sha) throw new Error("Prepared source SHA differs");
    productionConfig(json("publisher/wrangler.json"), json(prepared.configPath), {
      checkout, sha, variables, image: `registry.cloudflare.com/${variables.CLOUDFLARE_ACCOUNT_ID}/${imageName}@sha256:${"0".repeat(64)}`,
    });
    copyFileSync(path.join(prepared.source, "publisher/Dockerfile"), path.join(prepared.directory, "Dockerfile"));
    writeFileSync(metadataPath, bytes({ ...prepared, variables }), { mode: 0o600 });
  } else if (mode === "image") {
    const prepared = json(metadataPath), account = prepared.variables.CLOUDFLARE_ACCOUNT_ID;
    if (!/^[a-f0-9]{32}$/.test(account ?? "") || !env.CLOUDFLARE_API_TOKEN) throw new Error("Registry configuration missing");
    const image = await publishImage({ sha, account,
      lookup: async ref => (await registryReader(account, env.CLOUDFLARE_API_TOKEN))(ref),
      build: tag => command(process.execPath, [prepared.wrangler, "containers", "build", prepared.directory, "--push", "--tag", tag], {
        env: { ...env, CLOUDFLARE_ACCOUNT_ID: account },
      }),
    });
    const config = productionConfig(json("publisher/wrangler.json"), json(prepared.configPath), { checkout, sha, image, variables: prepared.variables });
    const directory = path.join(env.RUNNER_TEMP, "publisher-image-receipt");
    mkdirSync(directory);
    for (const [name, content] of Object.entries(receiptFiles({ sha, image, config, checkout, runId: env.GITHUB_RUN_ID }))) writeFileSync(path.join(directory, name), content);
  } else throw new Error("Expected verify, prepare or image");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(() => { console.error("Publisher image step refused; credential-bearing output withheld."); process.exitCode = 1; });
}
