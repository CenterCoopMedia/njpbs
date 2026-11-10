import assert from "node:assert/strict";
import { test } from "vitest";
import { createHash } from "node:crypto";
import { preparePrivatePairPublisher, createPrivatePairPublisherProvider, PrivatePairProviderError } from "../../scripts/lib/private-pair-publisher-provider.mjs";

import { accountId, versionId, otherVersion, deploymentId, namespaceId, applicationId, workerId, applicationName, imageReference, identity, source, moduleName, configuration, metadata, multipart, prepare, envelope, page, version, versionCode, container, deployment, network, provider } from "../helpers/private-pair-publisher-provider.mjs";

test("multipart seals bind deterministic module bytes, metadata and pair identity", async () => {
  const config = configuration();
  const first = await prepare();
  const second = await preparePrivatePairPublisher({ multipart: await multipart(metadata(), source, true), config, imageReference });
  assert.equal(first.bundleDigest, second.bundleDigest);
  assert.equal(first.configurationDigest, second.configurationDigest);
  assert.deepEqual(first.pairIdentity, identity);
  assert.equal(first.moduleManifest[0].sha256, createHash("sha256").update(source).digest("hex"));
  assert.ok(Object.isFrozen(first.pairIdentity));
  const differentCode = await preparePrivatePairPublisher({ multipart: await multipart(metadata(), `${source}// different\n`), config, imageReference });
  assert.notEqual(first.bundleDigest, differentCode.bundleDigest);
  const alteredConfig = configuration();
  alteredConfig.vars.PAIR_JOURNAL_NAMESPACE = "other-journal";
  const changedConfig = await prepare(metadata(alteredConfig), alteredConfig);
  assert.notEqual(first.configurationDigest, changedConfig.configurationDigest);
});

test("prepared inputs reject secret values, duplicate parts, public URLs and mixed buckets", async () => {
  const secretMetadata = metadata();
  secretMetadata.bindings.find(binding => binding.type === "inherit").type = "secret_text";
  await assert.rejects(() => prepare(secretMetadata), /prepared-bindings/);
  const config = configuration();
  config.workers_dev = true;
  await assert.rejects(() => prepare(metadata(), config), PrivatePairProviderError);
  const mixed = configuration();
  mixed.r2_buckets[0].bucket_name = "njpbs-cms-publication";
  await assert.rejects(() => prepare(metadata(), mixed), /configuration-bucket/);
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata()));
  form.append("metadata", JSON.stringify(metadata()));
  await assert.rejects(async () => preparePrivatePairPublisher({ multipart: new Uint8Array(await new Response(form).arrayBuffer()), config: configuration(), imageReference }), /multipart-parts/);
});

test("upload sends one multipart POST with a secret only at the consuming boundary", async () => {
  let reads = 0;
  const { api, requests, prepared } = await provider({ [`POST /workers/scripts/${applicationName}/versions`]: async (_url, init) => {
    const request = new Request("https://api.cloudflare.com/upload", init);
    const sent = await request.formData();
    const meta = JSON.parse(sent.get("metadata"));
    assert.deepEqual(meta.bindings.find(binding => binding.name === "FIREBASE_SERVICE_ACCOUNT"), { name: "FIREBASE_SERVICE_ACCOUNT", type: "secret_text", text: "synthetic-service-account" });
    assert.equal(await sent.get(moduleName).text(), source);
    return envelope({ id: versionId });
  } });
  assert.deepEqual(await api.uploadVersion({ readServiceAccount: () => { reads++; return "synthetic-service-account"; } }), { workerVersionId: versionId, publisherApplication: applicationName });
  assert.equal(reads, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get("bindings_inherit"), "strict");
  assert.ok(!JSON.stringify(prepared).includes("synthetic-service-account"));
  assert.equal(prepared.pairIdentity.journalNamespace, identity.journalNamespace);
});

test("every mutation makes one request when the provider loses or rejects its reply", async () => {
  const operations = [
    ["/workers/workers", api => api.createWorkerIdentity()],
    [`/workers/scripts/${applicationName}/versions`, api => api.uploadVersion({ readServiceAccount: () => "synthetic-service-account" })],
    [`/workers/scripts/${applicationName}/subdomain`, api => api.setPrivateSubdomain()],
    [`/workers/scripts/${applicationName}/deployments`, api => api.deployVersion({ versionId })],
    ["/containers/applications", api => api.createContainerApplication({ namespaceId })],
  ];
  for (const [path, operation] of operations) {
    for (const failure of [() => { throw new TypeError("sensitive provider body must not escape"); }, () => new Response("sensitive provider body must not escape", { status: 503 }), () => new Response(null, { status: 302, headers: { Location: "https://example.test" } })]) {
      const { api, requests } = await provider({ [`POST ${path}`]: failure });
      if (path === "/containers/applications") await api.readNamespace({ versionId });
      const countBefore = requests.length;
      await assert.rejects(() => operation(api), error => error instanceof PrivatePairProviderError && error.uncertain === true && !String(error.stack).includes("sensitive provider"));
      assert.equal(requests.length - countBefore, 1);
    }
  }
});

test("independent UUID readback checks code, runtime configuration and namespace", async () => {
  const { api, requests, prepared } = await provider();
  assert.deepEqual(await api.readVersion({ versionId, requireNamespace: true }), { publisherApplication: applicationName, workerVersionId: versionId, namespaceId, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest, imageDigest: `sha256:${"d".repeat(64)}` });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.searchParams.get("include"), "modules");
  for (const mutate of [
    value => { value.id = otherVersion; },
    value => { value.modules[0].content_base64 = Buffer.from("wrong code").toString("base64"); },
    value => { value.bindings.find(binding => binding.name === "PAIR_EXECUTOR_READY").text = "true"; },
    value => { value.bindings.push({ name: "PUBLIC_ACTIVATION", type: "secret_text" }); },
    value => { value.bindings.find(binding => binding.name === "PAIR_PUBLISHER").namespace_id = "c".repeat(32); },
    value => { value.compatibility_flags = []; },
    value => { value.exports.PairPublicationRuntime.storage = "legacy-kv"; },
  ]) {
    const { api: bad } = await provider({ [`GET /workers/workers/${applicationName}/versions/${versionId}`]: () => {
      const value = versionCode(); mutate(value); return envelope(value);
    } });
    await assert.rejects(() => bad.readVersion({ versionId }), PrivatePairProviderError);
  }
});

test("private inventory reads every account zone and refuses public attachment or incomplete lists", async () => {
  const { api, requests } = await provider();
  const inventory = await api.readPrivateInventory();
  assert.equal(inventory.private, true);
  assert.equal(inventory.zoneIds.length, 2);
  assert.equal(inventory.routeCount, 2);
  assert.equal(requests.filter(row => row.url.pathname.endsWith("/workers/routes")).length, 2);
  const cases = [
    { [`GET /workers/scripts/${applicationName}/subdomain`]: () => envelope({ enabled: false, previews_enabled: true }) },
    { "GET /workers/domains": () => envelope([{ id: "candidate-domain", service: applicationName }]) },
    { [`GET /zones/${"2".repeat(32)}/workers/routes`]: () => envelope([{ id: "candidate-route", script: applicationName }]) },
    { "GET /zones": () => envelope([]) },
    { "GET /workers/domains": () => envelope([], { page: 1, count: 0, total_count: 1, total_pages: 2 }) },
    { [`GET /zones/${"2".repeat(32)}/workers/routes`]: () => envelope([{ id: "missing-owner" }]) },
  ];
  for (const overrides of cases) {
    const { api: bad } = await provider(overrides);
    await assert.rejects(() => bad.readPrivateInventory(), PrivatePairProviderError);
  }
});

test("numeric zone pagination is exhausted and changed pages fail closed", async () => {
  const { api, requests } = await provider({ "GET /zones": url => {
    const number = Number(url.searchParams.get("page"));
    return page([{ id: String(number).repeat(32), account: { id: accountId } }], number, 2, 2);
  } });
  assert.equal((await api.readPrivateInventory()).zoneIds.length, 2);
  assert.equal(requests.filter(row => row.url.pathname.endsWith("/zones")).length, 2);
  const { api: bad } = await provider({ "GET /zones": () => page([{ id: "1".repeat(32), account: { id: accountId } }], 1, 2, 2) });
  await assert.rejects(() => bad.readPrivateInventory(), /pagination/);
});

test("initial inventory allows only a documented absent Worker and still reads account routing", async () => {
  const { api, requests } = await provider({
    [`GET /workers/workers/${applicationName}`]: () => new Response(null, { status: 404 }),
    "GET /containers/applications": () => envelope([], {}),
    "GET /workers/durable_objects/namespaces": () => page([], 1, 0, 0),
  });
  const inventory = await api.readInitialInventory();
  assert.equal(inventory.intendedWorkerExists, false);
  assert.equal(inventory.intendedContainerExists, false);
  assert.equal(inventory.namespaceId, null);
  assert.equal(inventory.zoneIds.length, 2);
  assert.ok(requests.every(request => request.method === "GET"));
  await assert.rejects(() => api.readInitialInventory({ retainedApplications: [applicationName] }), /retained-overlap/);
  const { api: forbidden } = await provider({ [`GET /workers/workers/${applicationName}`]: () => new Response(null, { status: 403 }) });
  await assert.rejects(() => forbidden.readInitialInventory(), /request-failed/);
  const { api: deployed } = await provider({ [`GET /workers/workers/${applicationName}`]: () => envelope({ id: workerId, name: applicationName, subdomain: { enabled: false, previews_enabled: false }, deployed_on: "2026-10-28T00:00:00Z" }) });
  await assert.rejects(() => deployed.readWorkerIdentity({ requireUndeployed: true }), /already-deployed/);
});

test("standard Container creation uses exact immutable image and never the managed API", async () => {
  const { api, requests } = await provider({ "POST /containers/applications": (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { name: applicationName, scheduling_policy: "default", configuration: { image: imageReference, instance_type: "standard-2" }, instances: 0, max_instances: 1, durable_objects: { namespace_id: namespaceId }, rollout_active_grace_period: 0 });
    return envelope({ id: applicationId });
  } });
  await assert.rejects(() => api.createContainerApplication({ namespaceId }), /namespace-readback-required/);
  assert.equal(requests.length, 0);
  await api.readNamespace({ versionId });
  const countBefore = requests.length;
  assert.equal((await api.createContainerApplication({ namespaceId })).applicationId, applicationId);
  assert.equal(requests.length - countBefore, 1);
  assert.equal((await api.readContainerApplication({ applicationId, namespaceId })).imageReference, imageReference);
  for (const mutate of [
    value => { value.configuration.image = imageReference.replace("d".repeat(64), "c".repeat(64)); },
    value => { value.scheduling_policy = "durable_object"; },
    value => { value.durable_objects.namespace_id = "c".repeat(32); },
    value => { value.configuration.environment_variables = [{ name: "OVERRIDE", value: "unsafe" }]; },
    value => { value.configuration.instance_type = "lite"; },
  ]) {
    const { api: bad } = await provider({ [`GET /containers/applications/${applicationId}`]: () => { const result = container(); mutate(result); return envelope(result); } });
    await assert.rejects(() => bad.readContainerApplication({ applicationId, namespaceId }), PrivatePairProviderError);
  }
});

test("Container cursor pagination finds a candidate on a later page and rejects cycles", async () => {
  const { api, requests } = await provider({ "GET /containers/applications": url => url.searchParams.get("page_token") === "second"
    ? envelope([container()], { page_token: "second" })
    : envelope([{ id: otherVersion, name: "old-container" }], { next_page_token: "second" }) });
  assert.equal((await api.readContainerApplication({ applicationId, namespaceId })).applicationId, applicationId);
  assert.equal(requests.filter(row => row.url.pathname.endsWith("/applications")).length, 2);
  const { api: bad } = await provider({ "GET /containers/applications": () => envelope([], { next_page_token: "repeat" }) });
  await assert.rejects(() => bad.listContainerApplications(), /pagination-incomplete/);
});

test("deployment readback requires current singleton 100 percent of the exact UUID", async () => {
  const { api } = await provider();
  assert.equal((await api.readDeployment({ versionId, deploymentId })).trafficPercent, 100);
  for (const versions of [[{ version_id: versionId, percentage: 99 }], [{ version_id: otherVersion, percentage: 100 }], [{ version_id: versionId, percentage: 50 }, { version_id: otherVersion, percentage: 50 }]]) {
    const { api: bad } = await provider({ [`GET /workers/scripts/${applicationName}/deployments`]: () => envelope({ deployments: [{ ...deployment(), versions }] }) });
    await assert.rejects(() => bad.readDeployment({ versionId }), /deployment-traffic/);
  }
});

test("lost upload recovery uses only reads and refuses multiple identical versions", async () => {
  const list = [`GET /workers/scripts/${applicationName}/versions`];
  const { api, requests } = await provider({ [list]: () => envelope({ items: [{ id: versionId }] }, { page: 1, count: 1, total_count: 1, total_pages: 1 }) });
  assert.equal((await api.recoverVersion()).workerVersionId, versionId);
  assert.ok(requests.every(request => request.method === "GET"));
  const { api: empty } = await provider();
  assert.equal(await empty.recoverVersion(), null);
  const { api: duplicate } = await provider({ [list]: () => envelope({ items: [{ id: versionId }, { id: otherVersion }] }, { page: 1, count: 2, total_count: 2, total_pages: 1 }) });
  await assert.rejects(() => duplicate.recoverVersion(), /recovery-ambiguous/);
});

test("upload receipts stay identical after deployment provisions the namespace", async () => {
  let provisioned = false;
  const namespaceBinding = value => {
    if (!provisioned) delete value.bindings.find(binding => binding.name === "PAIR_PUBLISHER").namespace_id;
    return value;
  };
  const { api } = await provider({
    [`GET /workers/scripts/${applicationName}/versions/${versionId}`]: () => {
      const value = versionCode();
      namespaceBinding(value);
      return envelope({ id: versionId, resources: { script: { named_handlers: [{ name: "PairPublicationRuntime" }, { name: "PairPublicationWake" }, { name: "ContainerProxy" }] }, bindings: value.bindings,
        script_runtime: { ...metadata(), bindings: undefined, main_module: undefined, keep_bindings: undefined } } });
    },
    [`GET /workers/workers/${applicationName}/versions/${versionId}`]: () => envelope(namespaceBinding(versionCode())),
  });
  const before = await api.readVersion({ versionId });
  provisioned = true;
  assert.deepEqual(await api.readVersion({ versionId }), before);
  assert.equal(before.namespaceId, null);
  assert.equal((await api.readNamespace({ versionId })).namespaceId, namespaceId);
});

test("lost Container recovery checks the namespace, exact application and current deployment", async () => {
  const { api, requests } = await provider();
  const recovered = await api.recoverContainer({ namespaceId, versionId, deploymentId });
  assert.equal(recovered.applicationId, applicationId);
  assert.deepEqual(recovered, await api.readContainerApplication({ applicationId, namespaceId }));
  assert.ok(requests.every(request => request.method === "GET"));
  const { api: resumed } = await provider();
  await resumed.readNamespace({ versionId });
  assert.equal((await resumed.recoverContainer({ namespaceId })).applicationId, applicationId);
  const { api: absent } = await provider({ "GET /containers/applications": () => envelope([], {}) });
  await absent.readNamespace({ versionId });
  assert.equal(await absent.recoverContainer({ namespaceId }), null);
  const { api: wrongNamespace } = await provider({ "GET /workers/durable_objects/namespaces": () => page([{ id: "c".repeat(32), class: "PairPublicationRuntime", script: applicationName, use_sqlite: true }]) });
  await assert.rejects(() => wrongNamespace.recoverContainer({ namespaceId, versionId }), /namespace-identity/);
});

test("private preflight is explicitly unbound until a real authorized caller exists", async () => {
  const { api, requests } = await provider();
  await assert.rejects(() => api.preflight({ identity }), /private-preflight-unbound/);
  assert.equal(requests.length, 0);
  let calls = 0;
  const { api: bound } = await provider({}, { preflightCaller: async value => { calls++; assert.deepEqual(value, identity); return { ready: true, pairId: value.pairId, commitSha: value.commitSha, journalNamespace: value.journalNamespace, ignored: "not-in-receipt" }; } });
  const result = await bound.preflight({ identity });
  assert.equal(result.ready, true);
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(result, "ignored"), false);
  const { api: failed } = await provider({}, { preflightCaller: async () => { throw new Error("sensitive text"); } });
  await assert.rejects(() => failed.preflight({ identity }), error => error.uncertain && !String(error).includes("sensitive"));
  const { api: refused } = await provider({}, { preflightCaller: async () => { throw new PrivatePairProviderError("preflight-target-changed"); } });
  await assert.rejects(() => refused.preflight({ identity }), error => error.code === "preflight-target-changed" && error.uncertain === false);
});


test("documented export and Container readbacks reject missing handlers or public version URLs", async () => {
  const script = `GET /workers/scripts/${applicationName}/versions/${versionId}`;
  const code = `GET /workers/workers/${applicationName}/versions/${versionId}`;
  for (const change of [
    value => { value.resources.script.named_handlers = [{ name: "PairPublicationRuntime" }]; },
    value => { value.resources.script_runtime.exports.PairPublicationRuntime.container = "other-container"; },
  ]) {
    const { api } = await provider({ [script]: () => { const value = version(); change(value); return envelope(value); } });
    await assert.rejects(() => api.readVersion({ versionId }));
  }
  const { api } = await provider({ [code]: () => { const value = versionCode(); value.urls = ["https://public.example.test"]; return envelope(value); } });
  await assert.rejects(() => api.readVersion({ versionId }), /version-public-urls/);
});


test("Worker identity accepts the documented hex ID and preserves exact independent readback", async () => {
  for (const id of [workerId, "66666666-6666-4666-8666-666666666666"]) {
    const row = { id, name: applicationName, subdomain: { enabled: false, previews_enabled: false }, deployed_on: null };
    const { api } = await provider({
      "POST /workers/workers": () => envelope(row),
      [`GET /workers/workers/${applicationName}`]: () => envelope(row),
    });
    assert.equal((await api.createWorkerIdentity()).workerId, id);
    assert.equal((await api.readWorkerIdentity({ requireUndeployed: true })).workerId, id);
  }
  const { api } = await provider({ [`GET /workers/workers/${applicationName}`]: () =>
    envelope({ id: "not-a-provider-id", name: applicationName, subdomain: { enabled: false, previews_enabled: false }, deployed_on: null }) });
  await assert.rejects(() => api.readWorkerIdentity(), /worker-identity/);
});


test("an accepted private-subdomain mutation still requires exact readback", async () => {
  for (const result of [{ enabled: true, previews_enabled: false }, { enabled: false }]) {
    const { api, requests } = await provider({ [`POST /workers/scripts/${applicationName}/subdomain`]: () => envelope(result) });
    await assert.rejects(() => api.setPrivateSubdomain(), error => error.code === "mutation-readback-required" && error.uncertain === true);
    assert.equal(requests.length, 1);
  }
});

test("Container absence remains pending while a different application ID refuses", async () => {
  const { api: pending } = await provider({ "GET /containers/applications": () => envelope([], {}) });
  await assert.rejects(() => pending.readContainerApplication({ applicationId, namespaceId }),
    error => error.code === "application-readback-pending" && error.uncertain === true);
  const { api: wrong } = await provider();
  await assert.rejects(() => wrong.readContainerApplication({ applicationId: otherVersion, namespaceId }), /application-inventory/);
});


test("single-page domains accept complete counts without total_pages and reject truncation", async () => {
  const rows = [{ id: "old-domain", service: "old-worker" }];
  for (const total_pages of [undefined, null, 1]) {
    const { api } = await provider({ "GET /workers/domains": () => envelope(rows, { page: 1, count: 1, total_count: 1, total_pages }) });
    assert.equal((await api.readPrivateInventory()).domainCount, 1);
  }
  for (const info of [{ page: 1, count: 1, total_count: 2 }, { page: 1, count: 1, total_count: 1, total_pages: 2 },
    { page: 2, count: 1, total_count: 1 }, { page: 1, count: 1, total_count: 1, per_page: 0 }]) {
    const { api } = await provider({ "GET /workers/domains": () => envelope(rows, info) });
    await assert.rejects(() => api.readPrivateInventory(), /pagination-incomplete/);
  }
});


test("numeric inventories exhaust complete counts when total_pages is omitted", async () => {
  const { api, requests } = await provider({ "GET /zones": url => {
    const current = Number(url.searchParams.get("page"));
    return envelope([{ id: String(current).repeat(32), account: { id: accountId } }], { page: current, count: 1, total_count: 2 });
  } });
  assert.equal((await api.readPrivateInventory()).zoneIds.length, 2);
  assert.equal(requests.filter(row => row.url.pathname.endsWith("/zones")).length, 2);
});

test("version recovery uses the documented complete deployable inventory without invented page metadata", async () => {
  const { api, requests } = await provider({ [`GET /workers/scripts/${applicationName}/versions`]: url => {
    assert.equal(url.searchParams.get("deployable"), "true");
    return envelope({ items: [{ id: versionId }] });
  } });
  assert.equal((await api.recoverVersion()).workerVersionId, versionId);
  assert.ok(requests.every(row => row.method === "GET"));
});


test("the initial executor option is sealed in exact bindings and cannot be a later flag flip", async () => {
  const config = configuration();
  config.vars.PAIR_EXECUTOR_READY = "true";
  const ready = await preparePrivatePairPublisher({ multipart: await multipart(metadata(config)), config, imageReference });
  const dormant = await prepare();
  assert.equal(ready.executorReady, true);
  assert.equal(dormant.executorReady, false);
  assert.equal(ready.bundleDigest, dormant.bundleDigest);
  assert.notEqual(ready.configurationDigest, dormant.configurationDigest);
  const net = network({
    [`POST /workers/scripts/${applicationName}/versions`]: (_url, init) => {
      const upload = JSON.parse(init.body.get("metadata"));
      assert.equal(upload.bindings.find(binding => binding.name === "PAIR_EXECUTOR_READY").text, "true");
      return envelope({ id: versionId });
    },
    [`GET /workers/scripts/${applicationName}/versions/${versionId}`]: () => {
      const row = version();
      row.resources.bindings.find(binding => binding.name === "PAIR_EXECUTOR_READY").text = "true";
      return envelope(row);
    },
    [`GET /workers/workers/${applicationName}/versions/${versionId}`]: () => {
      const row = versionCode();
      row.bindings.find(binding => binding.name === "PAIR_EXECUTOR_READY").text = "true";
      return envelope(row);
    },
  });
  const api = createPrivatePairPublisherProvider({ prepared: ready, fetchImpl: net.fetchImpl, readToken: () => "synthetic-token" });
  await api.uploadVersion({ readServiceAccount: () => "synthetic-service-account" });
  assert.equal((await api.readVersion({ versionId })).configurationDigest, ready.configurationDigest);
  const { api: wrong } = await provider({}, { prepared: ready });
  await assert.rejects(() => wrong.readVersion({ versionId }), /version-bindings/);
  for (const value of [true, "1", "yes", "TRUE"]) {
    const invalid = configuration();
    invalid.vars.PAIR_EXECUTOR_READY = value;
    const upload = await multipart(metadata(invalid));
    await assert.rejects(() => preparePrivatePairPublisher({ multipart: upload, config: invalid, imageReference }), { code: "invalid-input" });
  }
});
