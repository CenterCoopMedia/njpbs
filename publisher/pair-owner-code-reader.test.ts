import { expect, it, vi } from "vitest";
import { pairOwnerCodeSnapshotReader } from "./pair-owner-code-reader";
const resource = "projects/demo-code-reader/databases/(default)/documents";
it("opens one server-side read snapshot, binds every batch read, caches within it and rolls back even on refusal", async () => {
  const transactions: string[] = [];
  const request = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://firestore.googleapis.com"); expect(init?.redirect).toBe("error");
    if (url.pathname.endsWith(":beginTransaction")) {
      expect(JSON.parse(String(init?.body))).toEqual({ options: { readOnly: {} } });
      return Response.json({ transaction: "c25hcHNob3Q=" });
    }
    if (url.pathname.endsWith(":rollback")) {
      expect(JSON.parse(String(init?.body))).toEqual({ transaction: "c25hcHNob3Q=" }); return Response.json({});
    }
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)); transactions.push(body.transaction);
    expect(body.documents).toEqual([`${resource}/system/publicDeployment`]);
    return Response.json([{ found: { name: `${resource}/system/publicDeployment`, fields: { schemaVersion: 2 } } }]);
  });
  const run = pairOwnerCodeSnapshotReader({ projectId: "demo-code-reader", token: "unit-only", request, decode: raw => raw as any });
  await expect(run(async read => {
    const [first, second] = await Promise.all([read("system/publicDeployment"), read("system/publicDeployment")]);
    expect(first).toBe(second); throw new Error("Authority refused");
  })).rejects.toThrow("Authority refused");
  expect(transactions).toEqual(["c25hcHNob3Q="]);
  expect(request).toHaveBeenCalledTimes(3);
});
it("refuses mixed resource names and never performs a commit", async () => {
  const methods: string[] = [];
  const request = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)); methods.push(url.pathname);
    if (url.pathname.endsWith(":beginTransaction")) return Response.json({ transaction: "c25hcHNob3Q=" });
    if (url.pathname.endsWith(":rollback")) return Response.json({});
    return Response.json([{ found: { name: "projects/foreign/databases/(default)/documents/system/publicDeployment", fields: {} } }]);
  });
  const run = pairOwnerCodeSnapshotReader({ projectId: "demo-code-reader", token: "unit-only", request, decode: raw => raw as any });
  await expect(run(read => read("system/publicDeployment"))).rejects.toThrow("differs");
  expect(methods.some(path => path.endsWith(":commit"))).toBe(false);
  expect(methods.at(-1)).toBe(`/v1/${resource}:rollback`);
});
