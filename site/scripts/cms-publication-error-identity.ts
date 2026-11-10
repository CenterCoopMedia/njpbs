import { FirebaseError as SiteFirebaseError } from "firebase-admin/app";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";

const SAFE_EXTERNAL_ERROR_CODES = new Set([
  "ABORTED",
  "ALREADY_EXISTS",
  "CANCELLED",
  "DATA_LOSS",
  "DEADLINE_EXCEEDED",
  "EACCES",
  "ECONNRESET",
  "ENOENT",
  "ENOTFOUND",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
  "FAILED_PRECONDITION",
  "INTERNAL",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "OUT_OF_RANGE",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "UNIMPLEMENTED",
  "UNKNOWN",
]);
const SAFE_SYSTEM_ERROR_CODES = new Set([
  "EACCES",
  "ECONNRESET",
  "ENOENT",
  "ENOTFOUND",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
]);
const SAFE_FIREBASE_ERROR_CODE = /^(?:app|firestore)\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GRPC_STATUS_NAMES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;
const SAFE_FIREBASE_GRPC_CODES = new Set(
  GRPC_STATUS_NAMES.slice(1).map((code) => code.toLowerCase().replaceAll("_", "-")),
);

function safeGrpcErrorCode(code: unknown): string | null {
  if (
    typeof code === "number" &&
    Number.isInteger(code) &&
    code > 0 &&
    code < GRPC_STATUS_NAMES.length
  ) {
    return GRPC_STATUS_NAMES[code] ?? null;
  }
  if (
    typeof code === "string" &&
    SAFE_EXTERNAL_ERROR_CODES.has(code.toUpperCase())
  ) {
    return code.toUpperCase();
  }
  return null;
}

export function safeExternalErrorIdentity(error: unknown): string | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const provider = error as Record<string, unknown>;
  const code = provider.code;
  const constructorName = Object.getPrototypeOf(error)?.constructor?.name;
  if (constructorName === "GoogleError") {
    const safeCode = safeGrpcErrorCode(code);
    return safeCode ? `name GoogleError, code ${safeCode}` : null;
  }
  if (
    error instanceof SiteFirebaseError ||
    error instanceof firebaseAdminRuntime.FirebaseError
  ) {
    const normalizedCode = typeof code === "string" ? code.toLowerCase() : "";
    const safeCode = SAFE_FIREBASE_ERROR_CODE.test(normalizedCode) ||
        SAFE_FIREBASE_GRPC_CODES.has(normalizedCode)
      ? normalizedCode
      : safeGrpcErrorCode(code);
    return safeCode ? `name FirebaseError, code ${safeCode}` : null;
  }
  if (
    typeof code === "string" &&
    SAFE_SYSTEM_ERROR_CODES.has(code.toUpperCase())
  ) {
    return `code ${code.toUpperCase()}`;
  }
  return null;
}

class GoogleError extends Error {
  constructor(readonly code: string) {
    super("The CMS publication build child failed");
    this.name = "GoogleError";
  }
}

/** Accept only the canonical projection used by the publication stage. */
export function cmsPublicationErrorFromIdentity(identity: string): Error {
  const fallback = new Error("The CMS publication build child failed");
  const match = /^(?:name (FirebaseError|GoogleError), )?code ([A-Za-z0-9/_-]{1,128})$/.exec(identity);
  if (!match) return fallback;
  const error = match[1] === "FirebaseError"
    ? new SiteFirebaseError({ code: match[2], message: fallback.message })
    : match[1] === "GoogleError"
    ? new GoogleError(match[2])
    : Object.assign(fallback, { code: match[2] });
  return safeExternalErrorIdentity(error) === identity ? error : new Error(fallback.message);
}

