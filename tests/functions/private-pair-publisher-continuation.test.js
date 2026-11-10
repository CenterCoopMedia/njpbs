import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { configurePublicReleasePairPublisher } from "../../scripts/configure-public-release-pair-publisher.mjs";
import { preparePrivatePairPublisher, createPrivatePairPublisherProvider } from "../../scripts/lib/private-pair-publisher-provider.mjs";
import { releasePair } from "../helpers/private-public-release-pair.js";
import * as f from "../helpers/private-pair-publisher-provider.mjs";

const flags = ["PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED", "PUBLIC_PAIR_OWNER_WRITE_ENABLED", "PUBLIC_PAIR_TERMINAL_ENABLED", "PUBLIC_PAIR_SWITCH_CODE_ENABLED"];
const ingressProofService = "njpbs-private-ingress-development";
function enabledConfig() {
  const config = f.configuration();
  config.vars.PAIR_EXECUTOR_READY = "true";
  for (const flag of flags) config.vars[flag] = "true";
  config.services = [{ binding: "PUBLIC_RELEASE_INGRESS_PROOF", service: ingressProofService, entrypoint: "PublicReleaseIngressProofEntrypoint" }];
  return config;
}
const prepare = async config => preparePrivatePairPublisher({ config, imageReference: f.imageReference, multipart: await f.multipart(f.metadata(config)) });

it("keeps continuation absent by default and requires complete initial adoption before the UUID exists", () => {
  const pair = { ...releasePair(), environment: "production" };
  const input = { pair, retainedPairs: [], legacyConfig: JSON.parse(readFileSync(new URL("../../publisher/wrangler.json", import.meta.url))),
    imageReference: `registry.cloudflare.com/example/pair@${pair.publisher.imageDigest}` };
  const off = configurePublicReleasePairPublisher(input);
  expect(configurePublicReleasePairPublisher({ ...input, continuationEnabled: false })).toEqual(off);
  expect(off).not.toHaveProperty("services");
  for (const flag of flags) expect(off.vars).not.toHaveProperty(flag);
  const on = configurePublicReleasePairPublisher({ ...input, executorReady: true, continuationEnabled: true, ingressProofService });
  for (const flag of flags) expect(on.vars[flag]).toBe("true");
  expect(on.services).toEqual([{ binding: "PUBLIC_RELEASE_INGRESS_PROOF", service: ingressProofService, entrypoint: "PublicReleaseIngressProofEntrypoint" }]);
  expect(configurePublicReleasePairPublisher({ ...input, executorReady: true, continuationEnabled: true, ingressProofService,
    pair: { ...pair, publisher: { ...pair.publisher, workerVersionId: f.otherVersion } } })).toEqual(on);
  for (const override of [{ continuationEnabled: "true" }, { continuationEnabled: true },
    { continuationEnabled: true, ingressProofService }, { ingressProofService },
    { continuationEnabled: true, executorReady: true, ingressProofService: [ingressProofService] },
    { continuationEnabled: true, executorReady: true, ingressProofService: "njpbs-production" }])
    expect(() => configurePublicReleasePairPublisher({ ...input, ...override })).toThrow();
});

it("seals all continuation flags, exact proof service and original trigger policy in actual prepared metadata", async () => {
  const off = await prepare(f.configuration()), config = enabledConfig(), on = await prepare(config);
  expect(off.continuationEnabled).toBe(false); expect(on.continuationEnabled).toBe(true);
  expect(on.bundleDigest).toBe(off.bundleDigest); expect(on.configurationDigest).not.toBe(off.configurationDigest);
  const changed = structuredClone(config); changed.services[0].service = "njpbs-private-ingress-other";
  expect((await prepare(changed)).configurationDigest).not.toBe(on.configurationDigest);
  for (const change of [c => { delete c.services; }, c => { delete c.vars[flags[0]]; },
    c => { c.vars[flags[1]] = "false"; }, c => { c.vars.PAIR_EXECUTOR_READY = "false"; },
    c => { c.services[0].entrypoint = "default"; }, c => { c.services[0].environment = "production"; },
    c => { c.triggers.crons = []; }]) {
    const bad = structuredClone(config); change(bad); await expect(prepare(bad)).rejects.toThrow();
  }
  const badMetadata = f.metadata(config); badMetadata.bindings.find(b => b.name === "PUBLIC_RELEASE_INGRESS_PROOF").service = "njpbs-private-ingress-other";
  await expect(preparePrivatePairPublisher({ config, imageReference: f.imageReference, multipart: await f.multipart(badMetadata) }))
    .rejects.toMatchObject({ code: "prepared-bindings" });
});

it("uploads the sealed mode and refuses stale proof bindings in both independent version readbacks", async () => {
  const config = enabledConfig(), prepared = await prepare(config), meta = f.metadata(config);
  const bindings = () => meta.bindings.map(binding => binding.type === "inherit" ? { name: binding.name, type: "secret_text" }
    : binding.type === "durable_object_namespace" ? { ...binding, namespace_id: f.namespaceId }
    : binding.type === "service" ? { ...binding, environment: "production" } : binding);
  let tamper = "";
  const net = f.network({
    [`POST /workers/scripts/${f.applicationName}/versions`]: (_url, init) => {
      const upload = JSON.parse(init.body.get("metadata"));
      for (const flag of flags) expect(upload.bindings.find(b => b.name === flag).text).toBe("true");
      expect(upload.bindings.find(b => b.name === "PUBLIC_RELEASE_INGRESS_PROOF")).toEqual({ name: "PUBLIC_RELEASE_INGRESS_PROOF", type: "service",
        service: ingressProofService, entrypoint: "PublicReleaseIngressProofEntrypoint" });
      return f.envelope({ id: f.versionId });
    },
    [`GET /workers/scripts/${f.applicationName}/versions/${f.versionId}`]: () => {
      const row = f.version(); row.resources.bindings = bindings();
      if (tamper === "detail") row.resources.bindings.find(b => b.name === "PUBLIC_RELEASE_INGRESS_PROOF").service = "njpbs-private-ingress-other";
      if (tamper === "environment") row.resources.bindings.find(b => b.name === "PUBLIC_RELEASE_INGRESS_PROOF").environment = "staging";
      return f.envelope(row);
    },
    [`GET /workers/workers/${f.applicationName}/versions/${f.versionId}`]: () => {
      const row = f.versionCode(); row.bindings = bindings();
      if (tamper === "code") row.bindings.find(b => b.name === flags[3]).text = "false";
      return f.envelope(row);
    },
  });
  const api = createPrivatePairPublisherProvider({ prepared, fetchImpl: net.fetchImpl, readToken: () => "fixture-only" });
  await api.uploadVersion({ readServiceAccount: () => "fixture-only" });
  expect((await api.readVersion({ versionId: f.versionId })).configurationDigest).toBe(prepared.configurationDigest);
  for (const mode of ["detail", "code", "environment"]) { tamper = mode; await expect(api.readVersion({ versionId: f.versionId })).rejects.toThrow(); }
  expect(net.requests.filter(r => r.method !== "GET")).toHaveLength(1);
});
