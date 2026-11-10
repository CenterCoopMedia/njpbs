import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== "--reconcile-static")) throw new Error("Unsupported pair executor check option");
const reconcileStatic = args.length === 1;
const node = process.execPath;
const tsx = path.join(root, "site/node_modules/tsx/dist/cli.mjs");
const run = (args, env = process.env) => execFileSync(node, args, { cwd: root, env, stdio: "inherit" });
execFileSync("/usr/bin/bwrap", ["--version"], { stdio: "inherit" });
// The compiler's public configuration is explicit; no provider credential,
// preload, Firebase emulator routing or caller renderer path is inherited.
const environment = { PATH: process.env.PATH, CMS_DEPLOYMENT_ENVIRONMENT: "development", DATA_HUB_PUBLIC: "1", CMS_OFFLINE_BUILD: "1",
  ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York" };
run([tsx, "site/scripts/build-public-post-renderer.ts", "--compile-only"], environment);
const pairEnvironment = { ...environment };
if (process.env.PAIR_SEMANTIC_MODEL_CACHE) pairEnvironment.PAIR_SEMANTIC_MODEL_CACHE = process.env.PAIR_SEMANTIC_MODEL_CACHE;
// Match the container's separate build command: its inline public compiler
// gate is absent here. The pair compiler preserves the existing sealed gate.
delete pairEnvironment.DATA_HUB_PUBLIC;
run([tsx, "site/scripts/build-public-release-pair-renderer.ts"], pairEnvironment);
if (reconcileStatic) {
  run(["scripts/run-firebase-emulators.mjs", "exec", "firestore",
    "node node_modules/vitest/vitest.mjs run tests/pair-executor-runtime/static.test.ts --no-file-parallelism --testTimeout=120000 --testNamePattern='reconciles an uncaptured sole-static'"]);
} else run(["scripts/run-firebase-emulators.mjs", "exec", "firestore",
  "node node_modules/vitest/vitest.mjs run tests/pair-executor-runtime/executor.test.ts tests/pair-executor-runtime/record-status.test.ts tests/pair-executor-runtime/static.test.ts tests/pair-executor-runtime/composite-compiled.test.ts tests/pair-executor-runtime/semantic-reuse-compiled.test.ts tests/pair-executor-runtime/composite.test.ts tests/pair-executor-runtime/code-pack.test.ts tests/functions/public-release-pair-execution-renewal.test.ts tests/functions/public-release-pair-wiring.test.js tests/functions/public-release-pair-work.test.js tests/functions/public-release-pair-view-staging.test.ts tests/functions/public-release-pair-view.test.ts tests/functions/public-release-pair-render-request.test.ts tests/functions/public-release-pair-storage-rpc.test.ts tests/functions/public-release-pair-output-file.test.ts tests/functions/public-release-pair-replay.test.ts --no-file-parallelism --testTimeout=120000"]);
