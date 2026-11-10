import { afterAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { privatePairPublisherScenario } from "../tests/helpers/private-pair-publisher-install.mjs";
import { preparePrivatePairPublisherInstall } from "../scripts/lib/private-pair-publisher-prepare.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "publisher-operator-process-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// Deliberate first budget for this real-process proof: two offline Wrangler
// preparations plus the actual CLI under concurrent build work. The measured
// 15 s budget follows hosted measurements of 3389 ms (PR) and 5230/5429 ms (main);
// local ordinary runs were 2763/1782/1545 ms, loaded 2304/2110/2155 ms.
it("runs the real pinned preparation and default-off operator process without credentials or SDK/provider access", async () => {
  // Refresh only Git's cached stat data once. Both real preparations still
  // check HEAD and tracked/untracked changes before and after bundling.
  execFileSync("git", ["update-index", "--refresh"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  // The shared scenario constructs only secret-free inputs; it does no I/O.
  const current = await privatePairPublisherScenario(undefined, { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const pairTemplate = structuredClone(current.input.plan.pairTemplate);
  pairTemplate.commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const intent = { pairTemplate, retainedPairs: [], imageReference: current.input.plan.imageReference, executorReady: false,
    legacyConfig: { name: "njpbs-dev-cms-publisher", account_id: current.input.plan.accountId, compatibility_date: "2026-10-28",
      vars: { CMS_DEPLOYMENT_ENVIRONMENT: "development" }, r2_buckets: [{ bucket_name: "njpbs-dev-cms-publication" }] } };
  const { plan, prepared } = await preparePrivatePairPublisherInstall(intent);
  const bytes = JSON.stringify({ schemaVersion: 1, kind: "private-pair-publisher-operator", intent,
    preparation: { schemaVersion: 2, kind: "private-pair-publisher-preparation", plan, executorReady: prepared.executorReady,
      moduleManifest: prepared.moduleManifest, providerWrites: 0, runtimePreflight: "not-run" },
    preflightOperationId: "publisher-process-proof", credentialIdentity: { projectId: "njpbs-site-dev",
      clientEmail: "pair-test@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "a".repeat(40) } });
  const filename = join(directory, "packet.json");
  writeFileSync(filename, bytes);
  const output = execFileSync(process.execPath, ["scripts/install-private-pair-publisher.mjs", "--packet", filename,
    "--packet-digest", createHash("sha256").update(bytes).digest("hex")], { cwd: root, encoding: "utf8",
    // No credential environment or descriptors are inherited by the CLI.
    env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: current.input.plan.accountId }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    execFileSync(process.execPath, ["scripts/install-private-pair-publisher.mjs", "--packet", filename,
      "--packet-digest", "0".repeat(64)], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    throw new Error("Changed packet digest must refuse");
  } catch (error) {
    expect(String((error as { stderr?: Buffer }).stderr)).toContain("operator-packet-refused; uncertain=false");
  }
  expect(JSON.parse(output)).toMatchObject({ executorReady: false, providerWrites: 0, runtimePreflight: "not-run",
    publicSelectionChanged: false, publicationSuccess: false });
}, 15_000);
