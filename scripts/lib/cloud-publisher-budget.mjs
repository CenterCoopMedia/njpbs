import { createRequire } from "node:module";
const { publicationTarget } = createRequire(import.meta.url)("../../functions/lib/publication-target.js");
export const ACCOUNT = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
const API = "https://api.cloudflare.com/client/v4";
const MAX_BYTES = 1024 * 1024;
// Published rate card checked 2026-10-11. Gross estimates deliberately do not
// consume shared included allowances. Network uses the highest listed rate.
const rates = { cpuSecond: 0.000020, gibMemorySecond: 0.0000025, gbDiskSecond: 0.00000007, gbEgress: 0.05 };
const refuse = () => { throw new Error("Cloud publisher billing readback is unavailable"); };
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const monthlyCents = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
function window(start, end) {
  const first = Date.parse(start), last = Date.parse(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first || last - first > 31 * 86400_000 ||
      new Date(first).toISOString() !== start || new Date(last).toISOString() !== end) refuse();
  return { first, last, seconds: (last - first) / 1000 };
}
export function summarizePublisherUsage({ rows, applicationId, start, end, otherMonthlyCents }) {
  const observed = window(start, end);
  if (!monthlyCents(otherMonthlyCents) ||
      !Array.isArray(rows) || rows.length === 0 || rows.length > 32) refuse();
  const dates = new Set();
  let dollars = 0;
  const usage = { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 };
  for (const row of rows) {
    const date = row?.dimensions?.date;
    const stamp = Date.parse(`${date}T00:00:00Z`);
    if (row?.dimensions?.applicationId !== applicationId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
        !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date || dates.has(date) ||
        stamp < Date.parse(start.slice(0, 10)) || stamp >= observed.last) refuse();
    dates.add(date);
    for (const key of Object.keys(usage)) { if (!number(row?.sum?.[key])) refuse(); usage[key] += row.sum[key]; }
  }
  dollars = usage.cpuTimeSec * rates.cpuSecond + usage.allocatedMemory / 2 ** 30 * rates.gibMemorySecond +
    usage.allocatedDisk / 1e9 * rates.gbDiskSecond + usage.txBytes / 1e9 * rates.gbEgress;
  const grossObservedCents = Math.ceil(dollars * 100);
  const projectedMonthlyCents = Math.ceil(dollars * 100 * 31 * 86400 / observed.seconds) + otherMonthlyCents;
  if (!Number.isSafeInteger(projectedMonthlyCents)) refuse();
  return { start, end, usage, grossObservedCents, otherMonthlyCents, projectedMonthlyCents,
    startingBudgetCents: 1000, reviewThresholdCents: 4000,
    startingBudgetExceeded: projectedMonthlyCents > 1000, reviewRequired: projectedMonthlyCents > 4000,
    basis: "gross 31-day run rate; shared allowances excluded; other monthly cost supplied separately" };
}
async function boundedJson(response) {
  if (!response.ok || !response.body) { await response.body?.cancel(); refuse(); }
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_BYTES) refuse(); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { refuse(); }
}
export async function readPublisherBudget({ environment, applicationId, start, end, otherMonthlyCents, token, request = fetch }) {
  const target = publicationTarget(environment);
  window(start, end);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(applicationId ?? "") ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(token ?? "") || !monthlyCents(otherMonthlyCents)) refuse();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const application = await boundedJson(await request(`${API}/accounts/${ACCOUNT}/containers/applications/${applicationId}`, {
    headers, redirect: "error", signal: AbortSignal.timeout(10_000),
  }));
  if (application?.success !== true || application.result?.id !== applicationId ||
      application.result?.name !== target.publisherWorker || application.result?.max_instances !== 1) refuse();
  const body = await boundedJson(await request(`${API}/graphql`, { method: "POST", headers,
    redirect: "error", signal: AbortSignal.timeout(10_000), body: JSON.stringify({
      query: `query PublisherUsage($account: string, $application: string, $start: Time, $end: Time) {
        viewer { accounts(filter: {accountTag: $account}) {
          containersUsageAdaptiveGroups(limit: 100, filter: {applicationId: $application, datetime_geq: $start, datetime_lt: $end}, orderBy: [date_ASC]) {
            dimensions { applicationId date } sum { cpuTimeSec allocatedMemory allocatedDisk txBytes }
          }
        } }
      }`, variables: { account: ACCOUNT, application: applicationId, start, end },
    }),
  }));
  if (body?.errors?.length || body?.data?.viewer?.accounts?.length !== 1) refuse();
  const result = summarizePublisherUsage({ rows: body.data.viewer.accounts[0].containersUsageAdaptiveGroups,
    applicationId, start, end, otherMonthlyCents });
  return { environment: target.environment, publisher: target.publisherWorker, applicationId, ...result };
}

/** One review signal for both owners and one explicit non-container baseline.
 * These are readbacks; neither a high estimate nor missing usage changes work. */
export async function readPublisherFleetBudget({ productionApplicationId, developmentApplicationId,
  start, end, otherMonthlyCents, token, request = fetch }) {
  if (!monthlyCents(otherMonthlyCents) || productionApplicationId === developmentApplicationId) refuse();
  const applications = [];
  for (const [environment, applicationId] of [["production", productionApplicationId], ["development", developmentApplicationId]]) {
    applications.push(await readPublisherBudget({ environment, applicationId, start, end,
      otherMonthlyCents: 0, token, request }));
  }
  const grossObservedCents = applications.reduce((total, app) => total + app.grossObservedCents, 0);
  const projectedMonthlyCents = applications.reduce((total, app) => total + app.projectedMonthlyCents, otherMonthlyCents);
  if (!Number.isSafeInteger(projectedMonthlyCents)) refuse();
  return { start, end, applications, grossObservedCents, otherMonthlyCents, projectedMonthlyCents,
    startingBudgetCents: 1000, reviewThresholdCents: 4000,
    startingBudgetExceeded: projectedMonthlyCents > 1000, reviewRequired: projectedMonthlyCents > 4000,
    basis: "production and development gross 31-day run rates; shared allowances excluded; common other costs counted once" };
}
