import { execFileSync } from "node:child_process";
import { developmentInputs } from "./render-development-config.mjs";
import { rm } from "node:fs/promises";
import { prepareCloudPublisher } from "./prepare-cloud-publisher.mjs";
import {
  prepareDevPreviewRenderer,
  preparePreviewRenderer,
} from "./prepare-preview-renderer.mjs";

const prepare = {
  "preview-renderer": preparePreviewRenderer,
  "dev-preview-renderer": prepareDevPreviewRenderer,
  "cloud-publisher": prepareCloudPublisher,
};
const [target, commit] = process.argv.slice(2);
if (process.argv.length !== 4 || !Object.hasOwn(prepare, target)) {
  throw new Error(
    "Usage: check-prepared-worker <preview-renderer|dev-preview-renderer|cloud-publisher> <exact commit>",
  );
}

// Use the deployment's isolated checkout, component dependencies and rewritten
// config. Repository-root dependencies must not mask undeclared Worker imports.
// This command is exclusively an offline bundle check. Synthetic suppliers keep
// account resource names and protected origins out of public CI configuration.
Object.assign(process.env, Object.fromEntries(Object.entries(developmentInputs).map(([name, input]) =>
  [name, input.placeholder.replace("template-", "fixture-").replace("example.org", "fixture.test")])));
const prepared = await prepare[target](commit);
try {
  console.log(`Checking prepared ${target} at ${commit}`);
  execFileSync(
    process.execPath,
    [
      prepared.wrangler,
      "deploy",
      "--config",
      prepared.configPath,
      "--dry-run",
      "--containers-rollout=none",
    ],
    {
      cwd: prepared.source,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "true",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: "inherit",
    },
  );
} finally {
  await rm(prepared.directory, { recursive: true, force: true });
}
