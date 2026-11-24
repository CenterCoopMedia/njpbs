import { expect, it } from "vitest";
import { BUCKET_PERMISSIONS, READER_PERMISSIONS, checkDevSetup, formatDevSetup } from "../scripts/check-dev-setup.mjs";

const ready = {
  testIamPermissions: { status: 200, body: { permissions: Object.keys(READER_PERMISSIONS) } },
  bucket: { status: 200, body: { permissions: BUCKET_PERMISSIONS } },
};

function transport(overrides = {}) {
  const answers = { ...ready, ...overrides }, calls = [];
  const request = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET" });
    const answer = url.includes("storage.googleapis.com") ? answers.bucket : answers.testIamPermissions;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { request, calls };
}

it("passes ready development grants with permission-test reads only", async () => {
  const { request, calls } = transport();
  const rows = await checkDevSetup(request);
  expect(rows.map(row => row.ok)).toEqual([true, true]);
  expect(calls).toEqual([
    { url: "https://cloudresourcemanager.googleapis.com/v1/projects/njpbs-site-dev:testIamPermissions", method: "POST" },
    { url: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\/storage\/v1\/b\/njpbs-dev-public-artifacts\/iam\/testPermissions\?/), method: "GET" },
  ]);
});

it("names every missing grant and its fix in one pass", async () => {
  const { request } = transport({
    testIamPermissions: { status: 200, body: { permissions: ["datastore.entities.get", "datastore.indexes.list"] } },
    bucket: { status: 404, body: {} },
  });
  const text = formatDevSetup(await checkDevSetup(request));
  expect(text).toContain("missing cloudfunctions.functions.get, cloudscheduler.jobs.get");
  expect(text).toContain("grant roles/cloudfunctions.viewer and roles/cloudscheduler.viewer");
  expect(text).toContain("gs://njpbs-dev-public-artifacts: absent");
  expect(text).toContain("gcloud storage buckets create gs://njpbs-dev-public-artifacts");
  expect(text).toContain("--role=roles/storage.objectUser");
});

it("reports a failed request as a failed row and still runs the other checks", async () => {
  const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
  const { request, calls } = transport({ testIamPermissions: timeout, bucket: { status: 403, body: {} } });
  const rows = await checkDevSetup(request);
  expect(rows).toMatchObject([{ ok: false, detail: "timed out" }, { ok: false, detail: "HTTP 403" }]);
  expect(rows.every(row => row.fix.startsWith("the request did not complete"))).toBe(true);
  expect(calls).toHaveLength(2);
});
