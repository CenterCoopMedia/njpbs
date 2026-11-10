import { describe, expect, it, vi } from "vitest";
import { loadFunctionSource } from "../../scripts/lib/functions-deploy-inventory.mjs";
import { checkEventTriggerIam, eventTriggerRequirements } from "../../scripts/check-cms-secret-iam.mjs";

const number = "123456789";
const compute = `${number}-compute@developer.gserviceaccount.com`;
const media = "boardwalk-s3-media@njpbs-site.iam.gserviceaccount.com";
const endpoint = (overrides = {}) => ({ __endpoint: { platform: "gcfv2",
  eventTrigger: { eventType: "google.cloud.firestore.document.v1.written" }, ...overrides } });
const requirements = eventTriggerRequirements({
  onWrite: endpoint(), onCustom: endpoint({ serviceAccountEmail: media }),
}, number);
const policy = (...bindings) => JSON.stringify({ bindings });
const grant = (role, account, extra = {}) => ({ role, members: [`serviceAccount:${account}`], ...extra });
const receivers = requirements.map(({ account }) => grant("roles/eventarc.eventReceiver", account));
const invokers = requirements.map(({ account }) => grant("roles/run.invoker", account));

describe("Functions event trigger IAM preflight", () => {
  it("discovers the real custom search and private-video triggers and the platform defaults", () => {
    const events = eventTriggerRequirements(loadFunctionSource("njpbs-site"), number);
    expect(events.filter(event => event.account === media).map(event => event.name).sort()).toEqual([
      "onPrivateVideoAssetWrite", "onVideoSearchAssetWrite", "onVideoSearchShardWrite",
    ]);
    expect(events.find(event => event.name === "onDatasetRefresh")).toEqual({ name: "onDatasetRefresh", region: "us-central1", account: compute });
    expect(events.every(event => event.account === compute || event.account === media)).toBe(true);
  });

  it("uses SDK reset defaults, expands regions and excludes HTTP and first-generation functions", () => {
    expect(eventTriggerRequirements({
      onWrite: endpoint({ region: ["us-central1", "us-east1"], serviceAccountEmail: { toJSON: () => null } }),
      legacy: endpoint({ platform: "gcfv1" }), http: { __endpoint: { platform: "gcfv2", httpsTrigger: {} } },
    }, number)).toEqual([
      { name: "onWrite", region: "us-central1", account: compute },
      { name: "onWrite", region: "us-east1", account: compute },
    ]);
    for (const account of ["other@example.test", {}, "bad\naccount"]) {
      expect(() => eventTriggerRequirements({ onWrite: endpoint({ serviceAccountEmail: account }) }, number)).toThrow(/Unresolved event trigger identity/);
    }
    expect(() => eventTriggerRequirements({ onWrite: endpoint() }, "bad")).toThrow(/project number/);
  });

  it("reads project IAM once and accepts existing project invocation grants", () => {
    const readProject = vi.fn(() => policy(...receivers, ...invokers));
    const readService = vi.fn();
    checkEventTriggerIam(requirements, readProject, readService);
    expect(readProject).toHaveBeenCalledTimes(1);
    expect(readService).not.toHaveBeenCalled();
    checkEventTriggerIam([], readProject, readService);
    expect(readProject).toHaveBeenCalledTimes(1);
  });

  it("accepts exact per-service invocation without requiring a wider project grant", () => {
    const readService = vi.fn(({ account }) => policy(grant("roles/run.invoker", account)));
    checkEventTriggerIam(requirements, () => policy(...receivers), readService);
    expect(readService.mock.calls.map(([event]) => event)).toEqual(requirements);
  });

  it.each(requirements)("refuses missing or conditional receiver grants for $name", ({ name, account }) => {
    for (const replacement of [null, grant("roles/eventarc.eventReceiver", account, { condition: { expression: "true" } })]) {
      const readService = vi.fn();
      const bindings = receivers.filter(binding => !binding.members.includes(`serviceAccount:${account}`));
      if (replacement) bindings.push(replacement);
      expect(() => checkEventTriggerIam(requirements, () => policy(...bindings, ...invokers), readService))
        .toThrow(`Event trigger ${name} needs an unconditional roles/eventarc.eventReceiver`);
      expect(readService).not.toHaveBeenCalled();
    }
  });

  it.each([{}, { condition: { expression: "true" } }, { members: [`serviceAccount:${compute}`] }])(
    "refuses absent, conditional or different-account service invocation: %j", extra => {
      const custom = requirements.filter(event => event.account === media);
      const binding = Object.keys(extra).length ? grant("roles/run.invoker", media, extra) : { role: "roles/viewer", members: [`serviceAccount:${media}`] };
      expect(() => checkEventTriggerIam(custom, () => policy(...receivers), () => policy(binding)))
        .toThrow("onCustom needs an unconditional roles/run.invoker");
    },
  );

  it.each(["{", "null", "[]", '{"bindings":{}}'])("refuses malformed policy metadata safely: %s", input => {
    expect(() => checkEventTriggerIam(requirements, () => input, vi.fn())).toThrow("Could not read event trigger IAM policy metadata");
    expect(() => checkEventTriggerIam(requirements, () => policy(...receivers), () => input)).toThrow("Could not read event trigger IAM policy metadata");
  });
  it("defers only a proved-new service while keeping receiver grants and strict postdeploy validation", () => {
    expect(checkEventTriggerIam(requirements, () => policy(...receivers), () => null, { allowFirstDeploy: true })).toEqual(requirements);
    expect(() => checkEventTriggerIam(requirements, () => policy(...receivers), () => null)).toThrow();
    expect(() => checkEventTriggerIam(requirements, () => policy(), () => null, { allowFirstDeploy: true })).toThrow("eventReceiver");
    expect(() => checkEventTriggerIam(requirements, () => policy(...receivers), () => policy(), { allowFirstDeploy: true })).toThrow("run.invoker");
  });

});
