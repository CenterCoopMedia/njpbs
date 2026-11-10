#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PrivatePairProviderError } from "./lib/private-pair-publisher-provider.mjs";
import { preparePrivatePairPublisherInstall } from "./lib/private-pair-publisher-prepare.mjs";

let phase = "arguments";
try {
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" } }, strict: true });
  if (!values.input || !values.output) throw new Error("Arguments required");
  phase = "input";
  const input = JSON.parse(await readFile(values.input, "utf8"));
  phase = "offline bundle";
  const { plan, prepared } = await preparePrivatePairPublisherInstall(input);
  const receipt = { schemaVersion: 2, kind: "private-pair-publisher-preparation", plan,
    executorReady: prepared.executorReady, moduleManifest: prepared.moduleManifest, providerWrites: 0, runtimePreflight: "not-run" };
  phase = "receipt";
  await writeFile(values.output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, executorReady: prepared.executorReady, bundleDigest: plan.bundleDigest, configurationDigest: plan.configurationDigest }));
} catch (error) {
  if (phase === "arguments") console.error("Use --input <intent.json> --output <new-receipt.json>.");
  else if (error instanceof PrivatePairProviderError) console.error(`Private publisher preparation refused: ${error.code}.`);
  else if (phase === "receipt" && error?.code === "EEXIST") console.error("Preparation receipt already exists. Choose a new output path.");
  else console.error(`Private publisher preparation failed at ${phase}.`);
  process.exitCode = 1;
}
