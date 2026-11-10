import { createHash } from "node:crypto";

export const BOOTSTRAP_PREFLIGHTS = Object.freeze([
  [1, "identities-and-enrollment"], [2, "private-publishers"], [3, "views-replay-and-qualification"],
  [4, "old-only-ingress-and-readers"], [5, "switch-and-settlement"], [6, "cms-preview-and-admin"], [7, "isolated-rehearsal"],
].map(([layer, name]) => Object.freeze({ layer, name })));
const refuse = code => { const error = new Error(code); error.code = code; throw error; };
const WRITES = new Set(["set", "create", "update", "delete", "add", "batch", "bulkWriter", "recursiveDelete", "onSnapshot"]);

/** Defense against accidentally running a writer as a preflight. Actual owner
 * adapters are trusted, reviewed code; this facade is not an untrusted-code VM.
 */
export function readOnlyBootstrapFirestore(firestore) {
  const originals = new WeakMap(), wrapped = new WeakMap();
  const unwrap = value => originals.get(value) ?? value;
  const wrap = target => {
    if (!target || typeof target !== "object") return target;
    if (wrapped.has(target)) return wrapped.get(target);
    const proxy = new Proxy(target, { get(object, key) {
      if (WRITES.has(key)) return () => refuse("bootstrap-write-forbidden");
      if (key === "runTransaction") return (run, options = {}) => object.runTransaction(tx => run(wrap(tx)), { ...options, readOnly: true });
      if (key === "firestore") return wrap(firestore);
      const value = Reflect.get(object, key, object);
      if (["ref", "parent", "query"].includes(key)) return wrap(value);
      if (key === "docs" && Array.isArray(value)) return value.map(wrap);
      if (typeof value !== "function") return value;
      if (["doc", "collection", "collectionGroup", "where", "orderBy", "limit", "limitToLast", "offset", "select", "startAt", "startAfter", "endAt", "endBefore", "withConverter", "count", "sum", "average"].includes(key)) {
        return (...args) => wrap(value.apply(object, args));
      }
      if (key === "get" && typeof object.data === "function") return (...args) => value.apply(object, args);
      if (["get", "getAll", "listCollections", "listDocuments"].includes(key)) return async (...args) => {
        const result = await value.apply(object, args.map(unwrap));
        return Array.isArray(result) ? result.map(wrap) : wrap(result);
      };
      if (key === "forEach" && Array.isArray(object.docs)) return callback => object.docs.forEach(row => callback(wrap(row)));
      if (["data", "isEqual", "toJSON", "toString", "toDate", "toMillis", "valueOf"].includes(key)) {
        return (...args) => value.apply(object, args.map(unwrap));
      }
      return () => refuse("bootstrap-read-api-unsupported");
    } });
    originals.set(proxy, target); wrapped.set(target, proxy);
    return proxy;
  };
  return wrap(firestore);
}

function freezePacket(value) {
  if (value && typeof value === "object") { for (const entry of Object.values(value)) freezePacket(entry); Object.freeze(value); }
  return value;
}
export async function runBootstrapPreflights({ firestore, adapters, input, adapterDigest = null, packetDigest, emit = () => {} }) {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-[a-z0-9-]{1,60}$/.test(firestore.projectId ?? "")) refuse("bootstrap-emulator-required");
  const readonly = readOnlyBootstrapFirestore(firestore);
  const packet = freezePacket(structuredClone(input));
  const boundPacketDigest = packetDigest ?? createHash("sha256").update(JSON.stringify(packet ?? null)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(boundPacketDigest)) refuse("bootstrap-packet-digest-invalid");
  const context = { projectId: firestore.projectId, sourceSha: packet?.sourceSha ?? null,
    packetDigest: boundPacketDigest, adapterDigest };
  const results = [];
  // Do every observation, including after a failure. No later install is run.
  for (const { layer, name } of BOOTSTRAP_PREFLIGHTS) {
    let result;
    try {
      const adapter = adapters?.[layer];
      if (typeof adapter !== "function") refuse("bootstrap-adapter-unbound");
      const observation = await adapter({ firestore: readonly, input: packet });
      if (!observation || typeof observation.receiptDigest !== "string" || !/^[a-f0-9]{64}$/.test(observation.receiptDigest)) {
        refuse("bootstrap-receipt-invalid");
      }
      result = { layer, name, status: "PASS", receiptDigest: observation.receiptDigest };
    } catch (error) {
      const code = ["bootstrap-adapter-unbound", "bootstrap-write-forbidden", "bootstrap-receipt-invalid", "bootstrap-read-api-unsupported"].includes(error?.code)
        ? error.code : "bootstrap-preflight-refused";
      result = { layer, name, status: "FAIL", code };
    }
    results.push(result); emit(result);
  }
  const digest = createHash("sha256").update(JSON.stringify({ context, results })).digest("hex");
  return { kind: "rnp-bootstrap-emulator-preflight", schemaVersion: 1, context, passed: results.every(row => row.status === "PASS"),
    productionAuthority: false, results, digest };
}
