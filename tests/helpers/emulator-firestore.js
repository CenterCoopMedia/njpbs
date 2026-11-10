import { createHash } from "node:crypto";
import { afterAll } from "vitest";
import { getApps, initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const ownedApps = new Map();

export function isolatedFirestore(namespace) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host ?? "")) {
    throw new Error("A local Firestore emulator is required");
  }
  const name = `fixture:${namespace}`;
  const projectId = `demo-njpbs-${createHash("sha256").update(namespace).digest("hex").slice(0, 12)}`;
  const app = getApps().find(value => value.name === name) ?? initializeApp({ projectId }, name);
  ownedApps.set(name, app);
  return getFirestore(app);
}

export async function clearEmulatorFirestore(input, init, firestore, fetchFn = fetch) {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.host !== process.env.FIRESTORE_EMULATOR_HOST || init?.method !== "DELETE" ||
      !/^\/emulator\/v1\/projects\/[^/]+\/databases\/[^/]+\/documents$/.test(url.pathname)) {
    throw new Error("Only a local Firestore emulator reset is allowed");
  }
  if (firestore) {
    url.pathname = url.pathname.replace(/\/projects\/[^/]+\//, `/projects/${encodeURIComponent(firestore.projectId)}/`);
  }
  const response = await fetchFn(url.href, init);
  if (!response.ok) throw new Error(`Firestore emulator reset failed (${response.status})`);
  return response;
}

afterAll(async () => {
  const live = new Set(getApps());
  await Promise.all([...ownedApps.values()].filter(app => live.has(app)).map(app => deleteApp(app)));
  ownedApps.clear();
});
