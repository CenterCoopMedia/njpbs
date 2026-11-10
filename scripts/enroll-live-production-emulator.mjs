#!/usr/bin/env node
// Synthetic emulator enrollment only. See the deployment configuration for studio pairing.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(new URL("../functions/package.json", import.meta.url));
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
    !process.env.GCLOUD_PROJECT?.startsWith("demo-")) throw new Error("Use only isolated demo-project Auth and Firestore emulators.");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const deviceId = process.argv[2];
if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId ?? "")) throw new Error("Supply a synthetic device ID.");
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const uid = `live_device_${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}`;
try { await getAuth(app).createUser({ uid }); }
catch (error) { if (error.code !== "auth/uid-already-exists") throw error; }
await getAuth(app).setCustomUserClaims(uid, { liveProductionDeviceId: deviceId });
await getFirestore(app).doc(`liveProductionDevices/${deviceId}`).set({ active: true, authUid: uid });
console.log(JSON.stringify({ deviceId, authUid: uid, enrolled: true }));
