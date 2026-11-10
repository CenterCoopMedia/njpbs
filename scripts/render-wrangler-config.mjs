#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripComments } from "../.github/scripts/identity-boundary-guard.mjs";

// Only these controlled messages may reach CLI diagnostics; parser/OS errors stay hidden.
class RenderError extends Error {}

const kvId = value => /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
const rateLimitId = value => /^[1-9][0-9]*$/.test(value);
const intakeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === value && !url.username && !url.password &&
      !url.port && !url.search && !url.hash && url.pathname === "/api/report" &&
      !/(^|\.)example\.(?:org|com|net)$/.test(url.hostname);
  } catch { return false; }
};
const suppliers = Object.freeze({
  SHADOW_POST_REVISIONS_KV_NAMESPACE_ID: kvId,
  RATE_LIMIT_KV_NAMESPACE_ID: kvId,
  CRAWL_RATE_LIMIT_NAMESPACE_ID: rateLimitId,
  REPORT_INTAKE_URL: intakeUrl,
});

export function renderWranglerConfig(filename, { env = process.env, environment } = {}) {
  const source = resolve(filename);
  if (!lstatSync(source).isFile() || lstatSync(source).isSymbolicLink()) throw new RenderError("Invalid template");
  const extension = extname(source);
  if (![".json", ".jsonc", ".toml"].includes(extension)) throw new RenderError("Unsupported template");
  let body = readFileSync(source, "utf8");
  if (extension === ".toml") {
    if (environment) throw new RenderError("TOML profiles are not supported by this renderer");
  } else {
    const config = JSON.parse(stripComments(body));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new RenderError("Invalid template");
    if (environment) {
      if (!/^[A-Za-z0-9_-]+$/.test(environment) || !Object.hasOwn(config.env ?? {}, environment)) throw new RenderError("Unknown template profile");
      config.env = { [environment]: config.env[environment] };
    } else {
      delete config.env;
    }
    body = JSON.stringify(config, null, 2) + "\n";
  }
  const rendered = body.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_placeholder, name) => {
    if (!Object.hasOwn(suppliers, name)) throw new RenderError("Unknown template input");
    // config-input: CRAWL_RATE_LIMIT_NAMESPACE_ID, RATE_LIMIT_KV_NAMESPACE_ID, REPORT_INTAKE_URL
    // config-input: SHADOW_POST_REVISIONS_KV_NAMESPACE_ID
    const value = env[name];
    if (typeof value !== "string" ||
        /replace|placeholder|template|\$\{/i.test(value) || !suppliers[name](value)) {
      throw new RenderError(`Configure ${name} before rendering`);
    }
    return value;
  });
  if (/\$\{|REPLACE_ME/.test(rendered)) throw new RenderError("Unresolved template input");
  const output = resolve(dirname(source), `.wrangler-rendered-${basename(source, extension)}-${randomUUID()}${extension}`);
  // Same directory preserves every relative source, asset and schema path.
  // Exclusive creation also refuses a pre-existing file or symlink.
  writeFileSync(output, rendered, { flag: "wx", mode: 0o600 });
  return output;
}

function main(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!["--config", "--env"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new RenderError("Invalid arguments");
    options.set(key, value);
  }
  if (!options.has("--config")) throw new RenderError("Missing template");
  process.stdout.write(renderWranglerConfig(options.get("--config"), { environment: options.get("--env") }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    // Parser and filesystem errors can contain source values or paths.
    const reason = error instanceof RenderError ? error.message : "check the selected profile and configured suppliers";
    console.error(`Wrangler template rendering refused: ${reason}`);
    process.exitCode = 1;
  }
}
