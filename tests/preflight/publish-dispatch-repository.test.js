import { afterEach, expect, it, vi } from "vitest";
import publish from "../../functions/publish.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["example-org/example-repo", "another-org/site"])("dispatches to the configured repository %s", async repository => {
  vi.stubEnv("CMS_PUBLISH_GITHUB_REPOSITORY", repository);
  const result = await publish.dispatchPublish({ token: "synthetic-test-token", payload: {}, fetchImpl: async url => {
    expect(url).toBe(`https://api.github.com/repos/${repository}/dispatches`);
    return new Response(null, { status: 204 });
  } });
  expect(result.dispatched).toBe(true);
});

it.each([undefined, "", "../repository", "owner/..", "owner/.", "REPLACE_ME/repository", "https://github.com/example-org/repo", "owner/repo/dispatches"])(
  "refuses missing and malformed dispatch targets before network access: %s", async repository => {
  vi.stubEnv("CMS_PUBLISH_GITHUB_REPOSITORY", repository);
  await expect(publish.dispatchPublish({ token: "synthetic-test-token", payload: {}, fetchImpl: () => {
    throw new Error("Credential must not reach another repository");
  } })).rejects.toThrow("repository is not approved");
});

it.each(["", "owner/.."])("refuses GitHub publication before queue, audit or App-token mutation: %s", async repository => {
  vi.stubEnv("CMS_PUBLISH_GITHUB_REPOSITORY", repository);
  const collection = vi.fn();
  const audit = vi.fn();
  const token = vi.fn();
  const request = vi.fn();
  await expect(publish.enqueuePublishBuild({ actor: { uid: "fixture-user" }, changes: [],
    readiness: { transport: "github", devApp: true } }, {
    firestore: { collection }, logAdminActionFn: audit, getDevAppTokenFn: token,
    fetchImpl: request, assertPublishedMediaSafeFn: async () => {},
  })).rejects.toThrow("repository is not approved");
  for (const sideEffect of [collection, audit, token, request]) expect(sideEffect).not.toHaveBeenCalled();
});

it("refuses missing GitHub identity before readiness reconciliation or credential reads", async () => {
  vi.stubEnv("CMS_PUBLISH_GITHUB_REPOSITORY", "");
  const billing = vi.fn();
  const getToken = vi.fn();
  const getDevCredentials = vi.fn();
  const collection = vi.fn();
  await expect(publish.assertPublishReady({ firestore: { collection } }, {
    getTransport: () => "github", assertBillingEnabledFn: billing, getToken, getDevCredentials,
  })).rejects.toThrow("repository is not approved");
  for (const action of [billing, getToken, getDevCredentials, collection]) expect(action).not.toHaveBeenCalled();
});
