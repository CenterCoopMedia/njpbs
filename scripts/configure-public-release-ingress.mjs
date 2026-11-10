import { devAccessOrigin } from "./lib/deployment-settings.mjs";
import { fileURLToPath } from "node:url";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import targets from "../functions/lib/publication-target.js";
import { privatePairReaderCapabilities, PAIR_READER_CONTRACT } from "../packages/content-core/src/private-pair-http.mjs";

const fail = () => { throw new Error("Private public-pair configuration was refused"); };
const slotIdentity = pair => {
  const { versionId, ...publicWorker } = pair.publicWorker;
  const { readerReceiptDigest: _runtimeReceipt, ...stable } = pair;
  return { ...stable, publicWorker };
};
/** Offline construction only: no provider call, route installation or enablement. */
export function configurePublicReleaseSlot({ pair: rawPair, accountId, readerOrigin,
  slotEnabled = false, readerAccess = { enabled: false, audience: "", clientId: "" }, compatibilityDate = "2026-07-09" }) {
  const pair = protocol.parsePublicReleasePair(rawPair); work.assertPrivatePairResources(pair);
  if (pair.readerContractDigest !== protocol.publicReleaseDigest(PAIR_READER_CONTRACT) ||
      pair.capabilityDigest !== protocol.publicReleaseDigest(privatePairReaderCapabilities(pair.commitSha))) fail();
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) || typeof slotEnabled !== "boolean") fail();
  const origin = new URL(readerOrigin);
  if (origin.protocol !== "https:" || origin.origin !== readerOrigin || origin.username || origin.password) fail();
  protocol.exact(readerAccess, ["enabled", "audience", "clientId"]);
  const disabledEmpty = readerAccess.enabled === false && readerAccess.audience === "" && readerAccess.clientId === "";
  const validAccess = /^[a-f0-9]{64}$/.test(readerAccess.audience) && /^[a-zA-Z0-9]+\.access$/.test(readerAccess.clientId);
  if (typeof readerAccess.enabled !== "boolean" || !disabledEmpty && !validAccess) fail();
  return { name: pair.publicWorker.service, account_id: accountId,
    main: fileURLToPath(new URL("../workers/src/public-release-slot-worker.ts", import.meta.url)),
    compatibility_date: compatibilityDate, compatibility_flags: ["nodejs_compat"],
    workers_dev: false, preview_urls: false, routes: [],
    vars: { PUBLIC_PAIR_SLOT_ENABLED: String(slotEnabled), PUBLIC_PAIR_IDENTITY_JSON: JSON.stringify(slotIdentity(pair)),
      PAIR_PRIVATE_HTTP_ENABLED: String(readerAccess.enabled), PAIR_PRIVATE_ORIGIN: readerOrigin,
      PAIR_ACCESS_AUDIENCE: readerAccess.audience, PAIR_ACCESS_CLIENT_ID: readerAccess.clientId,
      CMS_DEV_ACCESS_ORIGIN: readerAccess.enabled ? devAccessOrigin() : "" },
    version_metadata: { binding: "PAIR_WORKER_VERSION" },
    r2_buckets: [{ binding: "PAIR_CONTENT", bucket_name: targets.publicationTarget(pair.environment).publicationBucket }],
    services: [{ binding: "CMS_API", service: pair.environment === "production" ? "njpbs-cms-api" : "template-dev-cms-api", entrypoint: "PublicContentEntrypoint" },
      { binding: "PAIR_READER", service: pair.publisher.application, entrypoint: "PairPublicationWake" }],
  };
}
/** Offline gateway configuration. Access app/policy installation is a separate
 * coordinator operation; this constructs no domain, route or deployment. */
export function configurePrivatePairReaderGateway({ pair: rawPair, accountId, readerOrigin, gatewayName,
  enabled = false, compatibilityDate = "2026-07-09" }) {
  const pair = protocol.parsePublicReleasePair(rawPair); work.assertPrivatePairResources(pair);
  const origin = new URL(readerOrigin);
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^njpbs-private-reader-[a-z0-9-]{1,40}$/.test(gatewayName ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate) || typeof enabled !== "boolean" ||
      origin.protocol !== "https:" || origin.origin !== readerOrigin || origin.username || origin.password) fail();
  const deployment = { schemaVersion: 1, environment: pair.environment, service: pair.publicWorker.service,
    versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: readerOrigin,
    contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) };
  if (deployment.contractDigest !== pair.readerContractDigest || protocol.publicReleaseDigest(deployment) !== pair.readerReceiptDigest) fail();
  return { name: gatewayName, account_id: accountId,
    main: fileURLToPath(new URL("../workers/src/private-pair-reader-gateway.ts", import.meta.url)),
    compatibility_date: compatibilityDate, compatibility_flags: ["nodejs_compat"],
    workers_dev: false, preview_urls: false, routes: [{ pattern: origin.hostname, custom_domain: true }],
    vars: { PAIR_READER_GATEWAY_ENABLED: String(enabled), PAIR_PRIVATE_ORIGIN: readerOrigin },
    services: [{ binding: "PAIR_SLOT_READER", service: pair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" }],
  };
}
export function configurePublicReleaseIngress({ oldPair: rawOld, newPair: rawNew, accountId,
  ingressName, compatibilityDate = "2026-07-09", developmentIngress = false }) {
  const oldPair = protocol.parsePublicReleasePair(rawOld), newPair = protocol.parsePublicReleasePair(rawNew);
  work.assertPrivatePairResources(oldPair); work.assertPrivatePairResources(newPair);
  if (oldPair.environment !== newPair.environment || oldPair.pairId === newPair.pairId ||
      oldPair.publicWorker.service === newPair.publicWorker.service || oldPair.publicWorker.versionId === newPair.publicWorker.versionId ||
      !/^[a-f0-9]{32}$/.test(accountId ?? "") || !/^njpbs-private-ingress-[a-z0-9-]{1,30}$/.test(ingressName ?? "") ||
      typeof developmentIngress !== "boolean" || developmentIngress && oldPair.environment !== "development") fail();
  return { name: ingressName, account_id: accountId,
    main: fileURLToPath(new URL("../workers/src/public-release-ingress-worker.ts", import.meta.url)),
    compatibility_date: compatibilityDate, compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false, routes: [],
    vars: { PUBLIC_PAIR_INGRESS_ENABLED: String(developmentIngress), PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED: "false", PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED: String(developmentIngress),
      PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([oldPair, newPair]), PUBLIC_PAIR_BOOTSTRAP_ID: developmentIngress ? "" : oldPair.pairId },
    r2_buckets: [{ binding: "PAIR_CONTENT", bucket_name: targets.publicationTarget(oldPair.environment).publicationBucket }],
    services: [
      { binding: "CMS_API", service: oldPair.environment === "production" ? "njpbs-cms-api" : "template-dev-cms-api", entrypoint: "PublicContentEntrypoint" },
      { binding: "PAIR_SLOT_OLD", service: oldPair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" },
      { binding: "PAIR_SLOT_NEW", service: newPair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" },
    ],
  };
}
