import { expect, it } from "vitest";
import { configurePublicReleaseIngress, configurePublicReleaseSlot, configurePrivatePairReaderGateway } from "../scripts/configure-public-release-ingress.mjs";
import { releasePair } from "./helpers/private-public-release-pair.js";
import { sealedPair } from "./helpers/sealed-public-release-pair";
const oldPair = releasePair(), newPair = releasePair("b", "b".repeat(40)), accountId = "a".repeat(32);
it("constructs disabled private slots without embedding the unassigned provider version", () => {
  const candidate = sealedPair().pair;
  const config = configurePublicReleaseSlot({ pair: candidate, accountId, readerOrigin: "https://private-reader.example.test" });
  expect(config.workers_dev).toBe(false); expect(config.preview_urls).toBe(false); expect(config.routes).toEqual([]);
  expect(config.vars.PUBLIC_PAIR_SLOT_ENABLED).toBe("false");
  const identity = JSON.parse(config.vars.PUBLIC_PAIR_IDENTITY_JSON);
  expect(identity.publicWorker.versionId).toBeUndefined();
  expect(identity.readerReceiptDigest).toBeUndefined();
  expect(identity.publicWorker.incarnation).toBe(oldPair.publicWorker.incarnation);
  expect(config.version_metadata.binding).toBe("PAIR_WORKER_VERSION");
  expect(config.r2_buckets[0].bucket_name).toBe("njpbs-dev-cms-publication");
  expect(config.vars.PAIR_PRIVATE_ORIGIN).toBe("https://private-reader.example.test");
  expect(config.vars.PAIR_PRIVATE_HTTP_ENABLED).toBe("false");
  expect(config.services[1]).toEqual({ binding: "PAIR_READER", service: oldPair.publisher.application, entrypoint: "PairPublicationWake" });
  expect(() => configurePublicReleaseSlot({ pair: candidate, accountId })).toThrow();
  expect(() => configurePublicReleaseSlot({ pair: candidate, accountId, readerOrigin: "https://reader.example.test/path" })).toThrow();
});
it("includes both distinct private service bindings and freezes bootstrap on OLD", () => {
  const config = configurePublicReleaseIngress({ oldPair, newPair, accountId, ingressName: "njpbs-private-ingress-rehearsal" });
  expect(config.services.slice(1).map(binding => binding.service)).toEqual([oldPair.publicWorker.service, newPair.publicWorker.service]);
  expect(config.services.slice(1).map(binding => binding.entrypoint)).toEqual(["PublicReleaseSlotEntrypoint", "PublicReleaseSlotEntrypoint"]);
  expect(config.vars.PUBLIC_PAIR_BOOTSTRAP_ID).toBe(oldPair.pairId); expect(config.vars.PUBLIC_PAIR_INGRESS_ENABLED).toBe("false");
  expect(config.vars.PUBLIC_PAIR_ROUTING_MEASUREMENT_ENABLED).toBe("false"); expect(config.routes).toEqual([]);
  expect(() => configurePublicReleaseIngress({ oldPair, newPair: oldPair, accountId, ingressName: "njpbs-private-ingress-rehearsal" })).toThrow();
  expect(() => configurePublicReleaseIngress({ oldPair, newPair, accountId, ingressName: "njpbs-production" })).toThrow();
});
it("routes only the private Access hostname to a disabled gateway bound to its actual slot", () => {
  const candidate = sealedPair().pair;
  const config = configurePrivatePairReaderGateway({ pair: candidate, accountId,
    readerOrigin: "https://private-reader.example.test", gatewayName: "njpbs-private-reader-fixture" });
  expect(config.workers_dev).toBe(false); expect(config.preview_urls).toBe(false);
  expect(config.routes).toEqual([{ pattern: "private-reader.example.test", custom_domain: true }]);
  expect(config.vars).toEqual({ PAIR_READER_GATEWAY_ENABLED: "false", PAIR_PRIVATE_ORIGIN: "https://private-reader.example.test" });
  expect(config.services).toEqual([{ binding: "PAIR_SLOT_READER", service: oldPair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" }]);
  expect(() => configurePrivatePairReaderGateway({ pair: oldPair, accountId,
    readerOrigin: "https://private-reader.example.test/path", gatewayName: "njpbs-private-reader-fixture" })).toThrow();
  expect(() => configurePrivatePairReaderGateway({ pair: candidate, accountId,
    readerOrigin: "https://other.example.test", gatewayName: "njpbs-private-reader-fixture" })).toThrow();
});
