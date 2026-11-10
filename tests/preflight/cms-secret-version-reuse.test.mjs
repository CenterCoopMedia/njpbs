import { readCmsDeployWorkflow } from "../helpers/cms-deploy-workflow.mjs";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  currentVersionMatches,
  provisionCmsSecret,
  setSecret,
} from "../../scripts/lib/functions-secret-versions.mjs";

const name = "CMS_EDGE_ORIGIN_SECRET";
const path = `projects/njpbs-site/secrets/${name}`;
const version = `${path}/versions/3`;

test("public video purge token reuses its enabled secret version", async () => {
  const purgeName = "CMS_MEDIA_CACHE_PURGE_TOKEN";
  const purgeVersion = `projects/njpbs-site/secrets/${purgeName}/versions/1`;
  const client = { async request({ url }) {
    if (url.endsWith("/versions/latest")) return { data: { name: purgeVersion, state: "ENABLED" } };
    return { data: { name: purgeVersion, payload: { data: Buffer.from("fixture token").toString("base64") } } };
  } };
  assert.equal(await provisionCmsSecret(purgeName, "fixture token", client), false);
});

function clientFor(value, state = "ENABLED") {
  return {
    async request({ url }) {
      if (url.endsWith("/versions/latest")) {
        return { data: { name: version, state } };
      }
      if (url.endsWith(`${version}:access`)) {
        return {
          data: {
            name: version,
            payload: { data: Buffer.from(value).toString("base64") },
          },
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
}

test("unchanged latest secret value does not create a version", async () => {
  const created = [];
  const changed = await provisionCmsSecret(
    name,
    "same value",
    clientFor("same value"),
    async (...args) => created.push(args),
  );
  assert.equal(changed, false);
  assert.deepEqual(created, []);
});

test("changed latest secret value creates one version", async () => {
  const created = [];
  const changed = await provisionCmsSecret(
    name,
    "new value",
    clientFor("old value"),
    async (...args) => created.push(args),
  );
  assert.equal(changed, true);
  assert.equal(created.length, 1);
  assert.equal(created[0][0], name);
  assert.equal(created[0][1].toString("utf8"), "new value");
});

test("empty existing secret gets its first version", async () => {
  const client = {
    async request({ url }) {
      if (url.endsWith("/versions/latest")) {
        throw { response: { status: 404 } };
      }
      if (url.endsWith(`/secrets/${name}`)) {
        return { data: { name: path } };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  assert.equal(await currentVersionMatches(name, Buffer.from("new"), client), false);
});

test("disabled and inaccessible versions fail before provisioning", async () => {
  await assert.rejects(
    currentVersionMatches(name, Buffer.from("value"), clientFor("value", "DISABLED")),
    /not enabled/,
  );
  const inaccessible = {
    async request({ url }) {
      if (url.endsWith("/versions/latest")) {
        return { data: { name: version, state: "ENABLED" } };
      }
      throw { response: { status: 403 } };
    },
  };
  await assert.rejects(
    currentVersionMatches(name, Buffer.from("value"), inaccessible),
    /Could not compare/,
  );
});

test("metadata failures and unknown names fail closed", async () => {
  const failed = { async request() { throw { response: { status: 403 } }; } };
  await assert.rejects(
    currentVersionMatches(name, Buffer.from("value"), failed),
    /Could not read latest/,
  );
  await assert.rejects(
    provisionCmsSecret("OTHER_SECRET", "value", clientFor("value"), async () => {}),
    /Unknown CMS/,
  );
});

test("Google's numeric project resource names are accepted", async () => {
  const numericVersion = version.replace("njpbs-site", "123456789");
  const client = {
    async request({ url }) {
      if (url.endsWith("/versions/latest")) return { data: { name: numericVersion, state: "ENABLED" } };
      assert.equal(url, `https://secretmanager.googleapis.com/v1/${version}:access`);
      return { data: { name: numericVersion, payload: { data: Buffer.from("value").toString("base64") } } };
    },
  };
  assert.equal(await currentVersionMatches(name, Buffer.from("value"), client), true);
});

test.each(["DISABLED", "DESTROYED"])("%s latest version never falls back to an older enabled value", async (state) => {
  const setter = vi.fn();
  await assert.rejects(provisionCmsSecret(name, "value", clientFor("value", state), setter));
  assert.equal(setter.mock.calls.length, 0);
});

test.each([403, 429, 500])("metadata status %s never triggers a write", async (status) => {
  const setter = vi.fn();
  const client = { async request() { throw { response: { status }, message: "sensitive upstream data" }; } };
  await assert.rejects(provisionCmsSecret(name, "value", client, setter), /Could not read latest/);
  assert.equal(setter.mock.calls.length, 0);
});

test("missing secret resource fails closed", async () => {
  const setter = vi.fn();
  const client = { async request() { throw { response: { status: 404 } }; } };
  await assert.rejects(provisionCmsSecret(name, "value", client, setter), /Could not verify empty/);
  assert.equal(setter.mock.calls.length, 0);
});

test("missing desired value never reads or writes", async () => {
  const request = vi.fn();
  const setter = vi.fn();
  await assert.rejects(provisionCmsSecret(name, "", { request }, setter), /Missing provisioning/);
  assert.equal(request.mock.calls.length, 0);
  assert.equal(setter.mock.calls.length, 0);
});

test("binary comparison preserves trailing newlines", async () => {
  const setter = vi.fn();
  await provisionCmsSecret(name, "value\n", clientFor("value"), setter);
  assert.equal(setter.mock.calls[0][1].toString(), "value\n");
});

test("rotation uses the existing secret with an in-memory payload and no automatic retries", async () => {
  const request = vi.fn(async () => ({ data: { name: version, state: "ENABLED" } }));
  await setSecret(name, Buffer.from("fixture secret"), { request });
  assert.deepEqual(request.mock.calls[0][0], {
    url: `https://secretmanager.googleapis.com/v1/${path}:addVersion`,
    method: "POST",
    data: { payload: { data: Buffer.from("fixture secret").toString("base64") } },
    retry: false,
  });
});

test("write failures omit upstream payloads and require readback before retry", async () => {
  const request = vi.fn(async () => { throw new Error("private payload fixture"); });
  await assert.rejects(setSecret(name, Buffer.from("value"), { request }),
    /^FunctionsConfigurationError: Secret provisioning failed for CMS_EDGE_ORIGIN_SECRET; verify latest version before retrying$/);
  assert.equal(request.mock.calls.length, 1);
});

test("routine deployment verifies secrets without provisioning", () => {
  const workflow = readCmsDeployWorkflow();
  assert.equal(workflow.includes("node scripts/component-runner.mjs functions verify-config"), true);
  assert.equal(workflow.includes("functions provision-config"), false);
  assert.equal(workflow.includes("functions:secrets:set"), false);
});

test("malformed base64 never causes a rotation", async () => {
  const setter = vi.fn();
  const client = { async request({ url }) {
    if (url.endsWith("/versions/latest")) return { data: { name: version, state: "ENABLED" } };
    return { data: { name: version, payload: { data: "A" } } };
  } };
  await assert.rejects(provisionCmsSecret(name, "value", client, setter), /Invalid latest secret payload/);
  assert.equal(setter.mock.calls.length, 0);
});
