import { releasePair } from "./private-public-release-pair.js";
import * as fixture from "./private-pair-publisher-provider.mjs";
import { preparePrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-provider.mjs";

// Stateful Cloudflare HTTP boundary shared by install and exact-target proofs.
export async function privatePairPublisherScenario(db, options = {}) {
  const accountId = options.accountId ?? fixture.accountId;
  const imageReference = fixture.imageReference.replace(fixture.accountId, accountId);
  const config = fixture.configuration();
  config.account_id = accountId;
  config.containers[0].image = imageReference;
  if (options.continuationEnabled === true) {
    config.vars.PAIR_EXECUTOR_READY = "true";
    for (const flag of ["PUBLIC_PAIR_ORIGINAL_RECOVERY_ENABLED", "PUBLIC_PAIR_OWNER_WRITE_ENABLED", "PUBLIC_PAIR_TERMINAL_ENABLED", "PUBLIC_PAIR_SWITCH_CODE_ENABLED"])
      config.vars[flag] = "true";
    config.services = [{ binding: "PUBLIC_RELEASE_INGRESS_PROOF", service: "njpbs-private-ingress-development", entrypoint: "PublicReleaseIngressProofEntrypoint" }];
  }
  const meta = fixture.metadata(config);
  const prepared = await preparePrivatePairPublisher({ multipart: await fixture.multipart(meta), config, imageReference });
  const pairTemplate = releasePair();
  pairTemplate.pairId = fixture.identity.pairId;
  pairTemplate.commitSha = fixture.identity.commitSha;
  pairTemplate.publicWorker = { ...pairTemplate.publicWorker, service: `njpbs-pair-slot-${fixture.incarnation}`, incarnation: fixture.incarnation };
  pairTemplate.publisher = { application: fixture.applicationName, imageDigest: fixture.imageReference.split("@")[1],
    journalNamespace: fixture.identity.journalNamespace };
  const plan = { schemaVersion: 2, kind: "private-pair-publisher-upload", pairTemplate,
    accountId, imageReference,
    bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest };
  const state = { worker: false, version: false, deployment: false, application: false };
  let credentialReads = 0, preflights = 0;
  const script = `/workers/scripts/${fixture.applicationName}`;
  const resource = `/workers/workers/${fixture.applicationName}`;
  const bindings = () => meta.bindings.map(binding => binding.type === "inherit" ? { name: binding.name, type: "secret_text" }
    : binding.type === "durable_object_namespace" ? { ...binding, namespace_id: fixture.namespaceId } : binding);
  const version = () => {
    const row = fixture.version();
    row.resources.bindings = bindings();
    if (!state.deployment) for (const binding of row.resources.bindings) delete binding.namespace_id;
    return fixture.envelope(row);
  };
  const net = fixture.network({
    [`GET ${resource}`]: () => {
      if (!state.worker || options.lagIdentityReads > 0) {
        if (state.worker) options.lagIdentityReads--;
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      return fixture.envelope({ id: fixture.workerId, name: fixture.applicationName,
        subdomain: { enabled: false, previews_enabled: false }, deployed_on: state.deployment ? "2026-10-28T00:00:00Z" : null });
    },
    "GET /containers/applications": () => {
      if (state.application && options.lagContainerReads > 0) {
        options.lagContainerReads--;
        return fixture.envelope([], {});
      }
      return fixture.envelope(state.application ? [fixture.container()] : [], {});
    },
    [`GET /containers/applications/${fixture.applicationId}`]: () => {
      const row = fixture.container();
      row.account_id = accountId;
      row.configuration.image = imageReference;
      return fixture.envelope(row);
    },
    "GET /workers/durable_objects/namespaces": () => fixture.page(state.deployment
      ? [{ id: fixture.namespaceId, class: "PairPublicationRuntime", script: fixture.applicationName, use_sqlite: true }] : []),
    [`GET ${script}/versions`]: () => fixture.envelope({ items: state.version ? [{ id: fixture.versionId }] : [] },
      { page: 1, count: state.version ? 1 : 0, total_count: state.version ? 1 : 0, total_pages: state.version ? 1 : 0 }),
    [`GET ${script}/versions/${fixture.versionId}`]: version,
    [`GET ${resource}/versions/${fixture.versionId}`]: () => {
      const row = fixture.versionCode();
      row.bindings = bindings();
      if (!state.deployment) for (const binding of row.bindings) delete binding.namespace_id;
      if (options.wrongBytes) row.modules[0].content_base64 = Buffer.from("different module bytes").toString("base64");
      return fixture.envelope(row);
    },
    [`GET ${script}/deployments`]: () => {
      if (state.deployment && options.lagDeploymentReads > 0) {
        options.lagDeploymentReads--;
        return fixture.envelope({ deployments: [] });
      }
      return fixture.envelope({ deployments: state.deployment ? [fixture.deployment()] : [] });
    },
    "POST /workers/workers": () => { state.worker = true; return fixture.envelope({ id: options.identityResponseId ?? fixture.workerId, name: fixture.applicationName }); },
    [`POST ${script}/versions`]: () => {
      state.version = true;
      if (options.loseVersionResponse) throw new Error("Fixture lost reply after commit");
      return fixture.envelope({ id: fixture.versionId });
    },
    [`POST ${script}/deployments`]: () => { state.deployment = true; return fixture.envelope({ id: options.deploymentResponseId ?? fixture.deploymentId }); },
    [`GET ${script}/schedules`]: () => {
      if (options.failTriggerPreparationReads > 0) { options.failTriggerPreparationReads--; throw new Error("Fixture trigger GET unavailable"); }
      if (state.trigger && options.lagTriggerReads > 0) { options.lagTriggerReads--; return fixture.envelope({ schedules: [] }); }
      return fixture.envelope({ schedules: state.trigger ? [{ cron: options.triggerCron ?? "* * * * *", created_on: "2026-10-29T00:00:00Z" }] : [] });
    },
    [`PUT ${script}/schedules`]: (_url, init) => {
      if (init.body !== JSON.stringify([{ cron: "* * * * *" }])) throw new Error("Unexpected fixture trigger");
      if (options.failTrigger) throw new Error("Fixture failed before trigger commit");
      state.trigger = true;
      if (options.loseTriggerResponse) throw new Error("Fixture lost trigger reply after commit");
      return fixture.envelope({ schedules: [{ cron: "* * * * *" }] });
    },
    "POST /containers/applications": () => {
      if (options.failContainer) throw new Error("Fixture failed before commit");
      state.application = true;
      return fixture.envelope({ id: options.containerResponseId ?? fixture.applicationId });
    },
  }, { accountId });
  const input = { firestore: db, plan, prepared, fetchImpl: net.fetchImpl, authorized: true,
    readToken: () => { credentialReads++; return "synthetic-provider-token"; },
    readServiceAccount: () => { credentialReads++; return "synthetic-service-account"; },
    preflightCaller: async identity => { preflights++; return { ...identity, ready: true }; } };
  return { input, state, requests: net.requests, counters: () => ({ credentialReads, preflights }),
    writes: () => net.requests.filter(row => row.method !== "GET") };
}
