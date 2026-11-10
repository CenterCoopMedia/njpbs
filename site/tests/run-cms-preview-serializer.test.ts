// @vitest-environment node
import { expect, it, vi } from "vitest";
import { assertPreviewSandboxAvailable, parsePreviewOperatorArguments, parsePreviewStorageCredential, runCmsPreviewSerializerOperator } from "../scripts/run-cms-preview-serializer";

import * as operatorChecks from "../scripts/cms-preview-operator-checks";

it("reexports the shared preview argument and sandbox checks unchanged", () => {
  expect(parsePreviewOperatorArguments).toBe(operatorChecks.parsePreviewOperatorArguments);
  expect(assertPreviewSandboxAvailable).toBe(operatorChecks.assertPreviewSandboxAvailable);
});

const sha = "a".repeat(40);
const storage = { accessKeyId: "b".repeat(32), secretAccessKey: "c".repeat(64) };
const account = { type: "service_account", project_id: "njpbs-site", client_email: "synthetic@example.test", private_key: "synthetic".repeat(10) };
const args = ["--serve", sha, "preview-owner"];

function fixture() {
  const order: string[] = [];
  const runtime = { stop: vi.fn(), closed: Promise.resolve({ reason: "stopped" }) };
  const detach = vi.fn();
  const dependencies = {
    assertSource: vi.fn(async () => { order.push("source"); }),
    assertRelease: vi.fn(async () => { order.push("release"); }),
    assertSandbox: vi.fn(async () => { order.push("sandbox"); }),
    assertLock: vi.fn(() => { order.push("lock"); }),
    readCredential: vi.fn((fd: number) => { order.push(`credential-${fd}`); return JSON.stringify(fd === 3 ? storage : account); }),
    initializeFirebase: vi.fn(() => { order.push("firebase"); return {} as never; }),
    firestoreFor: vi.fn(() => ({} as never)),
    deleteFirebase: vi.fn(async () => { order.push("delete"); }),
    attachSignals: vi.fn((_stop: () => void) => detach),
    startService: vi.fn(async () => { order.push("service"); return runtime; }),
  };
  return { dependencies, order, runtime, detach };
}

it("checks source, sandbox and lock before credentials, then closes Firebase after service completion", async () => {
  const test = fixture();
  await runCmsPreviewSerializerOperator(args, test.dependencies, {});
  expect(test.order).toEqual(["source", "release", "sandbox", "lock", "credential-3", "credential-4", "firebase", "service", "delete"]);
  expect(test.dependencies.startService).toHaveBeenCalledWith(expect.objectContaining({
    rendererSha: sha, serializerId: "preview-owner", stateDirectory: "/var/lib/njpbs-cms-preview",
    publisherStateDirectory: "/var/lib/njpbs-cms-publisher", ...storage,
  }));
  expect(test.detach).toHaveBeenCalledOnce();
});

it("preflights without opening credentials or connecting to Firebase", async () => {
  const test = fixture();
  await runCmsPreviewSerializerOperator(["--preflight", sha, "preview-owner"], test.dependencies, {});
  expect(test.order).toEqual(["source", "release", "sandbox"]);
});

it.each(["assertSource", "assertRelease", "assertSandbox", "assertLock"] as const)("does not open credentials when %s fails", async check => {
  const test = fixture();
  test.dependencies[check].mockImplementationOnce(() => { throw new Error("unavailable"); });
  await expect(runCmsPreviewSerializerOperator(args, test.dependencies, {})).rejects.toThrow("unavailable");
  expect(test.dependencies.readCredential).not.toHaveBeenCalled();
  expect(test.dependencies.initializeFirebase).not.toHaveBeenCalled();
});

it("honors a stop signal during startup and closes Firebase after startup failure", async () => {
  const test = fixture();
  test.dependencies.attachSignals.mockImplementationOnce(stop => { stop(); return test.detach; });
  await runCmsPreviewSerializerOperator(args, test.dependencies, {});
  expect(test.runtime.stop).toHaveBeenCalled();
  test.dependencies.startService.mockRejectedValueOnce(new Error("startup failed"));
  await expect(runCmsPreviewSerializerOperator(args, test.dependencies, {})).rejects.toThrow("startup failed");
  expect(test.dependencies.deleteFirebase).toHaveBeenCalledTimes(2);
});

it("refuses another Firebase project, emulator routing and invalid storage credentials", async () => {
  const test = fixture();
  await expect(runCmsPreviewSerializerOperator(args, test.dependencies, { FIRESTORE_EMULATOR_HOST: "localhost:18080" })).rejects.toThrow("emulator");
  expect(test.order).toEqual([]);
  test.dependencies.readCredential.mockImplementation(fd => JSON.stringify(fd === 3 ? storage : { ...account, project_id: "another-project" }));
  await expect(runCmsPreviewSerializerOperator(args, test.dependencies, {})).rejects.toThrow("Firebase credential");
  expect(test.dependencies.initializeFirebase).not.toHaveBeenCalled();
  for (const value of ["null", "[]", "{}", JSON.stringify({ ...storage, endpoint: "https://wrong.example" }), "x".repeat(4097)]) {
    expect(() => parsePreviewStorageCredential(value)).toThrow();
  }
  const broken = `{"accessKeyId":"${"A".repeat(20)}","secretAccessKey":"${"B".repeat(40)}`;
  expect(() => parsePreviewStorageCredential(broken)).toThrow(/^Invalid private preview storage credential$/);
  expect(() => parsePreviewOperatorArguments(["--serve", "main", "preview-owner"])).toThrow("Usage");
});
