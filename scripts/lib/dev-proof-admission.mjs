import { createRequire } from "node:module";
import { isatty } from "node:tty";

const PROJECT = "njpbs-site-dev";
const require = createRequire(import.meta.url);

export function parseDevOperatorCredential(input) {
  let account;
  try {
    account = JSON.parse(input);
  } catch {
    throw new Error("dev_operator_credential_required");
  }
  if (
    account?.type !== "service_account" ||
    account.project_id !== PROJECT ||
    typeof account.client_email !== "string" ||
    !/^[a-z0-9-]+@njpbs-site-dev\.iam\.gserviceaccount\.com$/.test(
      account.client_email,
    ) ||
    typeof account.private_key !== "string" ||
    !account.private_key.startsWith("-----BEGIN PRIVATE KEY-----\n")
  ) {
    throw new Error("dev_operator_credential_required");
  }
  return account;
}

// The caller supplies the validated development operator account on fd 4.
// This client reads admission and the signed-in dev Editor profile only.
export async function openDevAdmission(stream) {
  if (
    isatty(4) ||
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_CONFIG
  ) {
    throw new Error("dev_operator_credential_required");
  }
  let input = "";
  const timeout = setTimeout(
    () => stream.destroy(new Error("credential_timeout")),
    10_000,
  );
  try {
    for await (const chunk of stream) {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 32_768)
        throw new Error("dev_operator_credential_required");
    }
  } finally {
    clearTimeout(timeout);
  }
  const account = parseDevOperatorCredential(input);
  const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const app = initializeApp(
    { projectId: PROJECT, credential: cert(account) },
    `dev-proof-${process.pid}`,
  );
  const db = getFirestore(app);
  return {
    read: async () => {
      try {
        const snapshot = await db.doc("system/noBuildPostAdmission").get();
        return snapshot.data();
      } catch {
        throw new Error("dev_admission_read_failed");
      }
    },
    readEditor: async (uid) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid ?? ""))
        throw new Error("ordinary_editor_required");
      try {
        const snapshot = await db.doc(`users/${uid}`).get();
        const value = snapshot.data();
        return value
          ? {
              active: value.active,
              role: value.role,
              grants: value.grants,
              email: value.email,
            }
          : null;
      } catch {
        throw new Error("dev_editor_profile_read_failed");
      }
    },
    close: () => deleteApp(app),
  };
}
