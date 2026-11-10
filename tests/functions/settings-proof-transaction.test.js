import { afterEach, expect, it, vi } from "vitest";
import proofReads from "../../functions/lib/settings-proof-transaction.js";

const { settingsProofTransaction, readSettingsInputs } = proofReads;
afterEach(() => vi.useRealTimers());
const document = path => ({ path });
const query = key => ({ key, isEqual: other => other.key === key });

it("uses one snapshot for repeated document, query and batch reads", async () => {
  vi.useFakeTimers();
  let requests = 0;
  const network = rows => new Promise(resolve => {
    requests++;
    setTimeout(() => resolve(rows), 100);
  });
  const transaction = settingsProofTransaction({
    get: reference => network({ value: reference.path ?? reference.key }),
    getAll: (...references) => network(references.map(reference => ({ value: reference.path }))),
  });
  const reads = Promise.all([
    transaction.get(document("system/publicDeployment")),
    transaction.getAll(document("cmsPages/home"), document("system/publicDeployment"), document("cmsPages/home")),
    transaction.get(document("cmsPages/home")),
    transaction.get(query("published Posts")), transaction.get(query("published Posts")),
    transaction.get(query("published Pages")),
  ]);
  await vi.advanceTimersByTimeAsync(100);
  expect(await reads).toEqual([
    { value: "system/publicDeployment" },
    [{ value: "cmsPages/home" }, { value: "system/publicDeployment" }, { value: "cmsPages/home" }],
    { value: "cmsPages/home" }, { value: "published Posts" }, { value: "published Posts" }, { value: "published Pages" },
  ]);
  expect(requests).toBe(4);
});

it("rechecks changed authority in each transaction callback and SDK retry", async () => {
  let revision = 1030;
  // The SDK may reuse its transaction object when it invokes the callback again.
  const native = { get: async () => ({ revision }) };
  const first = settingsProofTransaction(native);
  expect(await first.get(document("public/context"))).toEqual({ revision: 1030 });
  revision = 1031;
  expect(await settingsProofTransaction(native).get(document("public/context"))).toEqual({ revision: 1031 });
});

it("keeps SDK batch options and writes on the native transaction", async () => {
  const native = {
    writes: [],
    async getAll(...args) { return args; },
    update(reference, value) { this.writes.push({ reference, value }); return this; },
  };
  const transaction = settingsProofTransaction(native);
  const reference = document("cmsPublishQueue/accepted");
  const options = { fieldMask: ["revision"] };
  expect(await transaction.getAll(reference, options)).toEqual([reference, options]);
  transaction.update(reference, { verified: true });
  expect(native.writes).toEqual([{ reference, value: { verified: true } }]);
});

it("bounds source reads and retains roster order when responses finish out of order", async () => {
  vi.useFakeTimers();
  let active = 0, maximum = 0;
  const roster = Array.from({ length: 62 }, (_, id) => id);
  const start = Date.now();
  const result = readSettingsInputs(roster, id => new Promise(resolve => {
    maximum = Math.max(maximum, ++active);
    setTimeout(() => { active--; resolve(id); }, id % 2 ? 100 : 200);
  }));
  await vi.advanceTimersByTimeAsync(1_600);
  expect(await result).toEqual(roster);
  expect(maximum).toBe(8);
  expect(Date.now() - start).toBe(1_600);
});

it("waits for the failed source batch and refuses partial coverage", async () => {
  vi.useFakeTimers();
  let active = 0;
  const unavailable = new Error("Source unavailable");
  const result = readSettingsInputs(Array.from({ length: 9 }, (_, id) => id), id => new Promise((resolve, reject) => {
    active++;
    setTimeout(() => { active--; id === 0 ? reject(unavailable) : resolve(id); }, id === 0 ? 10 : 100);
  }));
  const refused = expect(result).rejects.toBe(unavailable);
  await vi.advanceTimersByTimeAsync(100);
  await refused;
  expect(active).toBe(0);
});
