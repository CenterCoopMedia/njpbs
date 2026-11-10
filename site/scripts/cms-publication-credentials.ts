import type { ServiceAccount } from "firebase-admin/app";

// Shared credential checks must not load either publication runtime.
export const FIREBASE_PROJECT_ID = "njpbs-site";
const MAX_FIREBASE_CREDENTIAL_BYTES = 64 * 1_024;

export class CmsPublicationSerializerOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationSerializerOperatorError";
  }
}

function operatorError(message: string): never {
  throw new CmsPublicationSerializerOperatorError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function assertProductionFirestoreRouting(
  environment: NodeJS.ProcessEnv,
): void {
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    operatorError("The Firestore emulator route is not allowed");
  }
}

export function parseCmsPublicationFirebaseServiceAccount(
  value: string,
  projectId: "njpbs-site" | "njpbs-site-dev" = FIREBASE_PROJECT_ID,
): ServiceAccount {
  if (Buffer.byteLength(value, "utf8") > MAX_FIREBASE_CREDENTIAL_BYTES) {
    operatorError("The Firebase credential input is invalid");
  }
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(value);
  } catch {
    operatorError("The Firebase credential input is invalid");
  }
  if (
    !plainObject(serviceAccount) ||
    serviceAccount.type !== "service_account" ||
    serviceAccount.project_id !== projectId ||
    typeof serviceAccount.client_email !== "string" ||
    serviceAccount.client_email.length < 3 ||
    typeof serviceAccount.private_key !== "string" ||
    serviceAccount.private_key.length < 32
  ) {
    operatorError("The Firebase credential input is invalid");
  }
  return {
    projectId,
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  };
}
