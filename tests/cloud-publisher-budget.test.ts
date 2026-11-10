import { expect, it, vi } from "vitest";
import { readPublisherBudget, readPublisherFleetBudget, summarizePublisherUsage } from "../scripts/lib/cloud-publisher-budget.mjs";
const applicationId = "11111111-1111-4111-8111-111111111111";
const start = "2026-10-01T00:00:00.000Z", end = "2026-10-02T00:00:00.000Z";
const row = (sum = {}) => ({ dimensions: { applicationId, date: "2026-10-01" },
  sum: { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0, ...sum } });
const input = (rows: unknown[]) => ({ rows, applicationId, start, end, otherMonthlyCents: 500 });
it("retains zero idle container compute cost while accounting for other monthly charges", () => {
  expect(summarizePublisherUsage(input([row()]))).toMatchObject({ grossObservedCents: 0, projectedMonthlyCents: 500, reviewRequired: false });
});
it("includes allocated byte-seconds and egress in a conservative review signal", () => {
  const usage = { cpuTimeSec: 86400, allocatedMemory: 6 * 2 ** 30 * 86400, allocatedDisk: 12e9 * 86400, txBytes: 1e9 };
  const result = summarizePublisherUsage(input([row(usage)]));
  expect(result.grossObservedCents).toBe(315);
  expect(result.projectedMonthlyCents).toBe(10255);
  expect(result.reviewRequired).toBe(true);
});
it.each([[], [row({ allocatedMemory: -1 })], [row({ cpuTimeSec: "0" })], [row(), row()],
  [{ ...row(), dimensions: { applicationId: "other", date: "2026-10-01" } }]])("refuses missing, malformed or mixed usage %#", rows => {
  expect(() => summarizePublisherUsage(input(rows))).toThrow("unavailable");
});
it("makes only target-scoped provider reads and returns sanitized costs", async () => {
  const token = "fixture-token".repeat(3);
  const request = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: applicationId, name: "njpbs-dev-cms-publisher", max_instances: 1,
      configuration: { environment: { SECRET: "private-placeholder" } } } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [row()] }] } }, errors: null })));
  const result = await readPublisherBudget({ ...input([]), environment: "development", token, request });
  expect(JSON.stringify(result)).not.toContain("private-placeholder");
  expect(JSON.stringify(result)).not.toContain(token);
  expect(request.mock.calls[0][0]).toMatch(new RegExp(`/containers/applications/${applicationId}$`));
  expect(JSON.parse(request.mock.calls[1][1].body).variables.application).toBe(applicationId);
  // Independent provider __type readback on 2026-10-12: accountTag and
  // applicationId are scalar string; datetime_geq/datetime_lt are Time.
  const query = JSON.parse(request.mock.calls[1][1].body).query;
  const declarations = Object.fromEntries([...query.matchAll(/\$(\w+): (\w+)/g)].map(match => [match[1], match[2]]));
  expect(declarations).toEqual({ account: "string", application: "string", start: "Time", end: "Time" });
  expect(request.mock.calls.map(([, init]) => init.method ?? "GET")).toEqual(["GET", "POST"]); // POST is GraphQL query only.
});
it("adds production and development projections with the common monthly baseline once", async () => {
  const devId = "22222222-2222-4222-8222-222222222222";
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith(`/${applicationId}`)) return Response.json({ success: true,
      result: { id: applicationId, name: "njpbs-cms-publisher", max_instances: 1 } });
    if (url.endsWith(`/${devId}`)) return Response.json({ success: true,
      result: { id: devId, name: "njpbs-dev-cms-publisher", max_instances: 1 } });
    const query = JSON.parse(String(init.body));
    expect(query.query.trim()).toMatch(/^query /);
    const id = query.variables.application;
    return Response.json({ data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [
      { ...row({ txBytes: 10e9 }), dimensions: { applicationId: id, date: "2026-10-01" } },
    ] }] } }, errors: null });
  });
  const result = await readPublisherFleetBudget({ productionApplicationId: applicationId,
    developmentApplicationId: devId, start, end, otherMonthlyCents: 1200, token: "fixture-token".repeat(3), request });
  expect(result.projectedMonthlyCents).toBe(4300); // $15.50 per owner + one $12 baseline.
  expect(result.grossObservedCents).toBe(100);
  expect(result.reviewRequired).toBe(true);
  expect(result.applications.map((app: any) => app.environment)).toEqual(["production", "development"]);
  expect(request.mock.calls).toHaveLength(4);
});
it("cannot establish a combined budget if either application's usage is unavailable", async () => {
  const request = vi.fn(async () => new Response(null, { status: 403 }));
  await expect(readPublisherFleetBudget({ productionApplicationId: applicationId,
    developmentApplicationId: "22222222-2222-4222-8222-222222222222", start, end,
    otherMonthlyCents: 500, token: "fixture-token".repeat(3), request })).rejects.toThrow("unavailable");
});
it("refuses rows outside the exclusive billing window and an unspecified baseline", () => {
  expect(() => summarizePublisherUsage(input([{ ...row(), dimensions: { applicationId, date: "2026-10-02" } }]))).toThrow();
  expect(() => summarizePublisherUsage({ ...input([row()]), otherMonthlyCents: undefined })).toThrow();
});
it("refuses permission failures before querying usage", async () => {
  const request = vi.fn(async () => new Response("private-provider-output", { status: 403 }));
  await expect(readPublisherBudget({ ...input([]), environment: "production", token: "fixture-token".repeat(3), request })).rejects.toThrow("unavailable");
  expect(request).toHaveBeenCalledOnce();
});
