// @vitest-environment node
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { verifyVersionedCmsReaders } from "../../.github/scripts/cms-deploy-compatibility.mjs";
const api = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
const contractKeys = ["previewRequest", "postChrome", "settings", "capabilities", "adminSession"] as const;
const pair = (id: string, source = "a") => ({ schemaVersion: 2, pairId: `preview-${id}`, rendererSha: source.repeat(40),
  serializerId: `preview-${id}`, workerName: `njpbs-preview-${id}`, applicationName: `njpbs-preview-${id}`,
  workerVersion: `${source.repeat(8)}-${source.repeat(4)}-${source.repeat(4)}-${source.repeat(4)}-${source.repeat(12)}`,
  imageDigest: `sha256:${source.repeat(64)}`, requirements: Object.fromEntries(contractKeys.map(key => [key, 1])),
  capabilities: { dataHubCompositionVersion: 1, liveBlogVersion: 1, electionResultsVersion: 1 } });
const receipt = (component: string) => ({ schemaVersion: 2, component, state: "complete", lastComplete: {
  schemaVersion: 2, component, sourceSha: "b".repeat(40), inputFingerprint: "c".repeat(64),
  configurationFingerprint: "d".repeat(64), providerIdentities: { deploymentId: "deployed-v1" },
  supported: Object.fromEntries(contractKeys.map(key => [key, [1]])), verifiedAt: new Date().toISOString() } });
const state = () => ({ schemaVersion: 2, publicSelectorDigest: "a".repeat(64),
  publicPairs: ["b", "c"].map(value => ({ pairDigest: value.repeat(64), requirements: pair("old").requirements })),
  previewPairs: [pair("old"), pair("new", "b")],
  readers: { functions: receipt("functions"), cmsApi: receipt("cmsApi") } });
const replay = vi.fn(async (input: unknown) => {
  const { reader, state } = input as { reader: unknown; state: unknown };
  return { digest: "d".repeat(64), readerDigest: api.digest(reader), stateDigest: api.digest(state) };
});
it("keeps staged legacy rollback helpers independent of deploy-source pair code", () => {
  const root = mkdtempSync(join(tmpdir(), "cms-rollback-helpers-"));
  try {
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    for (const name of ["cms-component-receipt.mjs", "cms-release-plan.mjs", "repository-identity.mjs",
      "functions-configuration.mjs", "studio-title-files.mjs"]) {
      copyFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), "scripts/lib", name), join(root, "scripts/lib", name));
    }
    copyFileSync(new URL("../../scripts/render-development-config.mjs", import.meta.url), join(root, "scripts/render-development-config.mjs"));
    mkdirSync(join(root, "config"));
    copyFileSync(new URL("../../config/development-inputs.json", import.meta.url), join(root, "config/development-inputs.json"));
    copyFileSync(new URL("../../config/functions-configuration.json", import.meta.url), join(root, "config/functions-configuration.json"));
    mkdirSync(join(root, "agents/vmix"), { recursive: true });
    copyFileSync(new URL("../../agents/vmix/configuration.mjs", import.meta.url), join(root, "agents/vmix/configuration.mjs"));
    const entry = pathToFileURL(join(root, "scripts/lib/cms-release-plan.mjs")).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(entry)}); if (m.baselineMutation(null).blocked !== 'missing_receipt') process.exit(1);`], { stdio: "pipe" });
    mkdirSync(join(root, "functions/lib"), { recursive: true });
    writeFileSync(join(root, "functions/lib/cms-preview-pair.js"), 'throw new Error("Deploy-source code executed");');
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)});`], { stdio: "pipe" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("proves both deployed readers against retained public and preview contracts without ancestry", async () => {
  const live = state();
  const result = await verifyVersionedCmsReaders({ cmsSourceSha: "b".repeat(40), readLiveState: async () => live, replayDeployedReader: replay });
  expect(result.stateDigest).toBe(api.digest(live));
  expect(Object.keys(result.replays)).toEqual(["functions", "cmsApi"]);
});
it.each(contractKeys)("refuses missing retained %s support", async key => {
  const live = state(); live.publicPairs[1].requirements[key] = 2;
  await expect(verifyVersionedCmsReaders({ cmsSourceSha: "b".repeat(40), readLiveState: async () => live,
    replayDeployedReader: replay })).rejects.toThrow("cannot retain");
});
it("accepts distinct compatible deployed reader and renderer SHAs, bound by actual replay identities", async () => {
  const live = state(); live.readers.cmsApi.lastComplete.sourceSha = "e".repeat(40);
  const verified = await verifyVersionedCmsReaders({ cmsSourceSha: "c".repeat(40), readLiveState: async () => live, replayDeployedReader: replay });
  expect(verified.candidateSourceSha).toBe("c".repeat(40));
  expect(verified.readerDigests).toEqual({ functions: api.digest(live.readers.functions.lastComplete), cmsApi: api.digest(live.readers.cmsApi.lastComplete) });
});
it("refuses invented replay and authority change during replay", async () => {
  const live = state();
  await expect(verifyVersionedCmsReaders({ cmsSourceSha: "b".repeat(40), readLiveState: async () => live,
    replayDeployedReader: async () => ({ digest: "a".repeat(64), readerDigest: "0".repeat(64), stateDigest: "0".repeat(64) }) })).rejects.toThrow("bind the live receipts");
  let reads = 0;
  await expect(verifyVersionedCmsReaders({ cmsSourceSha: "b".repeat(40),
    readLiveState: async () => ++reads === 1 ? live : { ...live, publicSelectorDigest: "f".repeat(64) },
    replayDeployedReader: replay })).rejects.toThrow("changed during replay");
});
