// The privacy scanner for Admin performance receipts (#1064).
//
// This is verification, not runtime behavior: the tests and the capture harness run it over an
// emitted receipt to prove no address, credential, identifier, or free text survived the
// sanitizer in admin/src/lib/perf-receipts.ts. It lives in its own module so the shipped Admin
// entry carries only the fail-closed sanitizer, not the checker that audits it.
import {
  OPERATION_CATEGORIES,
  PERF_MARKS,
  PERF_MEASURES,
  PERF_OUTCOMES,
  PERF_STATUS_CLASSES,
  ROUTE_CATEGORIES,
} from "./perf-receipts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const JWT = /eyJ[A-Za-z0-9_-]{4,}/;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{1,4}\b/i;
const OPAQUE_ID = /[A-Za-z0-9_-]{16,}/;
const SPACED_TEXT = /\s/;

// Everything a receipt is allowed to say in words. Anything else that is not a bare number is
// treated as suspect, which is what makes the scan a boundary rather than a spot check.
const SAFE_VALUES = new Set<string>([
  ...ROUTE_CATEGORIES,
  ...OPERATION_CATEGORIES,
  ...PERF_OUTCOMES,
  ...PERF_STATUS_CLASSES,
  ...Object.values(PERF_MARKS),
  ...Object.values(PERF_MEASURES),
]);

function unsafeString(value: string): boolean {
  if (SAFE_VALUES.has(value) || UUID.test(value)) return false;
  if (EMAIL.test(value) || JWT.test(value)) return true;
  if (IPV4.test(value) || IPV6.test(value)) return true;
  if (SPACED_TEXT.test(value)) return true;
  if (OPAQUE_ID.test(value)) return true;
  return value.includes("/") || value.includes("<");
}

// Returns the path of every value that looks like an address, a credential, an identifier, or
// free text, so a violation names itself instead of having to be eyeballed.
export function findUnsafePerfValues(value: unknown, path = ""): string[] {
  if (typeof value === "string") return unsafeString(value) ? [path] : [];
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findUnsafePerfValues(entry, path ? `${path}.${index}` : String(index)),
    );
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, entry]) =>
        findUnsafePerfValues(entry, path ? `${path}.${key}` : key),
    );
  }
  return [];
}
