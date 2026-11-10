import { expect, it } from "vitest";
import { env, currentCodeFixture } from "./current-code-fixture";
import { readPrivateCurrentCode, readPrivateCurrentCodeReference } from "./record-code-source";

it("qualifies an exact current CODE reference without loading immutable object bytes", async () => {
  const fixture = await currentCodeFixture();
  expect(await readPrivateCurrentCodeReference(env, fixture.rendererSha, fixture.request)).toEqual(fixture.code.reference);
  expect(fixture.request.mock.calls.some(([url]) => String(url).includes("r2.cloudflarestorage.com"))).toBe(false);
  expect(fixture.request.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/_publication.json")).toHaveLength(2);
});
it.each(["publication", "pointer", "manifest"])("refuses %s movement during a reference-only qualification", async race => {
  const fixture = await currentCodeFixture({ race });
  await expect(readPrivateCurrentCodeReference(env, fixture.rendererSha, fixture.request)).rejects.toThrow();
  expect(fixture.request.mock.calls.some(([url]) => String(url).includes("r2.cloudflarestorage.com"))).toBe(false);
});

it("reads actual current CODE bytes through fixed read-only provider routes without a typed family", async () => {
  const fixture = await currentCodeFixture();
  const result = await readPrivateCurrentCode(env, fixture.rendererSha, fixture.request);
  expect(result.reference).toEqual(fixture.code.reference);
  expect(Buffer.from(result.bytes).toString("utf8")).toBe(JSON.stringify(fixture.code.input));
  expect(fixture.request.mock.calls.some(([url]) => /noBuildRecords|queue|health|container/.test(String(url)))).toBe(false);
});
it.each([undefined, "", "invalid/account"])("refuses missing or invalid storage account configuration %s", async accountId => {
  const fixture = await currentCodeFixture();
  await expect(readPrivateCurrentCode({ ...env, CLOUDFLARE_ACCOUNT_ID: accountId }, fixture.rendererSha, fixture.request)).rejects.toThrow();
  expect(fixture.request.mock.calls.some(([url]) => String(url).includes("r2.cloudflarestorage.com"))).toBe(false);
});
it.each(["publication", "pointer", "manifest"])("refuses current CODE %s movement after the object read", async race => {
  const fixture = await currentCodeFixture({ race });
  await expect(readPrivateCurrentCode(env, fixture.rendererSha, fixture.request)).rejects.toThrow();
});
it.each([{ badBytes: true }, { large: true }])("refuses invalid or oversized current CODE bytes %j", async options => {
  const fixture = await currentCodeFixture(options);
  await expect(readPrivateCurrentCode(env, fixture.rendererSha, fixture.request)).rejects.toThrow();
  if (options.large) expect(fixture.request.mock.calls.some(([url]) => String(url).includes("r2.cloudflarestorage.com"))).toBe(false);
});
it("refuses a mixed project and a foreign renderer before private storage", async () => {
  const fixture = await currentCodeFixture();
  await expect(readPrivateCurrentCode({ ...env, FIREBASE_PROJECT_ID: "njpbs-site-dev" }, fixture.rendererSha, fixture.request)).rejects.toThrow();
  await expect(readPrivateCurrentCode(env, "b".repeat(40), fixture.request)).rejects.toThrow();
  expect(fixture.request.mock.calls.some(([url]) => String(url).includes("r2.cloudflarestorage.com"))).toBe(false);
});
