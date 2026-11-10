#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import protocol from "../functions/lib/public-release-pair.js";
import rollout from "../functions/lib/public-release-pair-rollout.js";
import { installPrivatePublicRelease } from "./install-private-public-release.mjs";

/** Offline composition only. Native apply independently checks both durable
 * publisher upload seals before it grants any slot effect. */
export async function preparePrivatePublicReleaseSlots({ template, uploads, compile }) {
  protocol.exact(template, ["schemaVersion", "kind", "installPlan", "publisherPlans"]);
  if (template.schemaVersion !== 1 || template.kind !== "private-pair-first-install-slots" ||
      template.installPlan?.schemaVersion !== 2 || !Array.isArray(template.publisherPlans) || template.publisherPlans.length !== 2 ||
      !Array.isArray(uploads) || uploads.length !== 2) throw new Error("First-install slot preparation was refused");
  const plans = template.publisherPlans.map(rollout.parsePublicReleasePairUploadPlan);
  const pairs = [template.installPlan.oldPair, template.installPlan.newPair].map((pairTemplate, index) => {
    const plan = plans[index], upload = uploads[index], version = upload?.version;
    if (plan.schemaVersion !== 3 || plan.slotInstall.operationId !== template.installPlan.operationId ||
        plan.slotInstall.readerOrigin !== template.installPlan.readerOrigins[index] || plan.accountId !== template.installPlan.accountId ||
        protocol.publicReleaseDigest(pairTemplate) !== protocol.publicReleaseDigest(plan.pairTemplate) ||
        upload?.kind !== "private-pair-publisher-uploaded" || upload.planDigest !== protocol.publicReleaseDigest(plan) ||
        upload.registered !== false || upload.deployed !== false || version?.publisherApplication !== pairTemplate.publisher.application ||
        version.bundleDigest !== plan.bundleDigest || version.configurationDigest !== plan.configurationDigest || version.imageDigest !== pairTemplate.publisher.imageDigest ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(version.workerVersionId ?? "")) {
      throw new Error("First-install publisher upload receipt was refused");
    }
    return { ...pairTemplate, publisher: { ...pairTemplate.publisher, workerVersionId: version.workerVersionId } };
  });
  const plan = { ...template.installPlan, oldPair: pairs[0], newPair: pairs[1] };
  await installPrivatePublicRelease({ plan, ...compile ? { compile } : {} }); // Actual offline configuration/source validation.
  return plan;
}
export async function main(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    template: { type: "string" }, "old-upload": { type: "string" }, "new-upload": { type: "string" }, output: { type: "string" },
  } });
  if (Object.keys(values).length !== 4 || Object.values(values).some(value => !value)) throw new Error("First-install slot preparation was refused");
  const json = async path => {
    const bytes = await readFile(path); if (bytes.length > 256 * 1024) throw new Error("First-install input was refused");
    return JSON.parse(bytes.toString("utf8"));
  };
  const plan = await preparePrivatePublicReleaseSlots({ template: await json(values.template),
    uploads: [await json(values["old-upload"]), await json(values["new-upload"])] });
  await writeFile(values.output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ prepared: true, operationId: plan.operationId, planDigest: protocol.publicReleaseDigest(plan), providerWrites: 0 })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(() => {
  process.stderr.write("First-install slot preparation was refused; preserve the original inputs\n"); process.exitCode = 1;
});
