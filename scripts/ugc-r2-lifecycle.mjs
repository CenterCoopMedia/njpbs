import { runUgcR2Policy } from "./lib/ugc-r2-policy.mjs";

try {
  await runUgcR2Policy("lifecycle", process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
