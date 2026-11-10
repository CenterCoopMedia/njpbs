import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { firstInstallScenario } from "./helpers/private-pair-first-install.mjs";
import { compilePrivateWorker } from "../scripts/install-private-public-release.mjs";
import protocol from "../functions/lib/public-release-pair.js";

it("runs the offline slot-preparation command as documented with structurally absent unknown identities", async () => {
  const current = await firstInstallScenario(), plan = current.slotPlan();
  plan.oldPair = current.intents[0].plan.pairTemplate; plan.newPair = current.intents[1].plan.pairTemplate;
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  plan.slotBundleDigest = hash(await compilePrivateWorker("workers/src/public-release-slot-worker.ts"));
  plan.ingressBundleDigest = hash(await compilePrivateWorker("workers/src/public-release-ingress-worker.ts"));
  const directory = mkdtempSync(join(tmpdir(), "first-install-plan-"));
  try {
    const template = join(directory, "template.json"), output = join(directory, "slots.json");
    writeFileSync(template, JSON.stringify({ schemaVersion: 1, kind: "private-pair-first-install-slots", installPlan: plan,
      publisherPlans: current.intents.map((intent: any) => intent.plan) }));
    const files = current.intents.map((intent: any, index: number) => {
      const filename = join(directory, `${index}-upload.json`), row = current.publishers.get(intent.prepared.applicationName);
      writeFileSync(filename, JSON.stringify({ kind: "private-pair-publisher-uploaded", planDigest: protocol.publicReleaseDigest(intent.plan),
        registered: false, deployed: false, version: { publisherApplication: row.name, workerVersionId: row.versionId,
          bundleDigest: intent.plan.bundleDigest, configurationDigest: intent.plan.configurationDigest, imageDigest: intent.plan.pairTemplate.publisher.imageDigest } }));
      return filename;
    });
    const args = ["scripts/prepare-private-public-release-slots.mjs", "--template", template, "--old-upload", files[0], "--new-upload", files[1], "--output", output];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CMS_DEV_ACCESS_ORIGIN: process.env.CMS_DEV_ACCESS_ORIGIN } });
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(readFileSync(output, "utf8"));
    expect(actual.schemaVersion).toBe(2);
    expect(actual.oldPair.publicWorker.versionId).toBeUndefined(); expect(actual.oldPair.readerReceiptDigest).toBeUndefined();
    expect(actual.oldPair.publisher.workerVersionId).toBe(current.publishers.get(actual.oldPair.publisher.application).versionId);
    expect(JSON.parse(result.stdout)).toMatchObject({ prepared: true, providerWrites: 0 });
    expect(spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CMS_DEV_ACCESS_ORIGIN: process.env.CMS_DEV_ACCESS_ORIGIN } }).status).toBe(1); // create-only output
    const swapped = [...args]; [swapped[4], swapped[6]] = [swapped[6], swapped[4]];
    expect(spawnSync(process.execPath, swapped, { encoding: "utf8", env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, CMS_DEV_ACCESS_ORIGIN: process.env.CMS_DEV_ACCESS_ORIGIN } }).status).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
