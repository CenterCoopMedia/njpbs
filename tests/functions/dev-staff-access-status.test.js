import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const express = require("express");
const http = require("node:http");
const https = require("node:https");
let server;
let admin;
let db;
let authProxy;
let authFailure = false;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;

beforeAll(async () => {
  vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  // Keep the real Auth emulator behind a network fault fixture. The SDK and
  // Function stay real when a backend permission/configuration error occurs.
  authProxy = createServer(async (req, res) => {
    if (req.url === "/jwks-unavailable") {
      res.writeHead(503);
      res.end("Fixture service unavailable");
      return;
    }
    if (authFailure) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "PERMISSION_DENIED" } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(`http://${authHost}${req.url}`, {
      method: req.method, headers: { "content-type": "application/json",
        ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(await response.text());
  });
  await new Promise(resolve => authProxy.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", `127.0.0.1:${authProxy.address().port}`);
  ({ admin, db } = require("./lib/firebase"));
  const { getStaffAccessStatus } = require("./dev-staff-access-status");
  await db.doc("system/dev-test-readiness").get();
  const app = express();
  app.use(express.json());
  app.post("/status", getStaffAccessStatus);
  server = await new Promise(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

afterAll(async () => {
  await new Promise(resolve => server?.close(resolve));
  const { getApps, deleteApp } = require("firebase-admin/app");
  await Promise.all(getApps().map(deleteApp));
  await new Promise(resolve => authProxy?.close(resolve));
  vi.unstubAllEnvs();
});

it.each([
  ["missing", true, null, 403],
  ["inactive", true, { active: false, role: "admin" }, 403],
  ["unverified", false, { active: true, role: "admin" }, 403],
  ["mismatched", true, { active: true, role: "admin", email: "someone-else@example.test" }, 403],
  ["no-grants", true, { active: true }, 403],
  ["unknown-role", true, { active: true, role: "unknown" }, 403],
  ["unknown-grant", true, { active: true, grants: [{ role: "unknown" }] }, 403],
  ["misplaced-admin", true, { active: true, grants: [{ role: "admin" }] }, 403],
  ["ready", true, { active: true, role: "admin" }, 200],
  ["staff", true, { active: true, grants: [{ role: "staff" }] }, 200],
  ["editor", true, { active: true, grants: [{ role: "editor", sections: ["news"] }] }, 200],
])("admits only provisioned verified matching dev staff: %s", async (name, verified, profile, status) => {
  const email = `dev-status-${name}@example.test`;
  const password = "fixture-password";
  const user = await admin.auth().createUser({ email, password, emailVerified: verified });
  try {
    if (profile) await db.doc(`users/${user.uid}`).set({ email, ...profile });
    const auth = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fixture`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const token = (await auth.json()).idToken;
    expect(typeof token).toBe("string");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-njpbs-cms-edge": "local-cms-edge-only" }, body: "{}",
    });
    const body = await response.json();
    expect(response.status).toBe(status);
    if (status === 200) expect(body.request.state).toBe("ready");
    else {
      expect(body.request).toBeUndefined();
      expect(body.error).toBe("Development access must be provisioned by an administrator");
    }
  } finally {
    await db.doc(`users/${user.uid}`).delete();
    await admin.auth().deleteUser(user.uid);
  }
});

it.each([undefined, "Bearer invalid-token"])("returns 401 for invalid authentication: %s", async (authorization) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
    method: "POST", headers: { ...(authorization ? { authorization } : {}),
      "content-type": "application/json", "x-njpbs-cms-edge": "local-cms-edge-only" }, body: "{}",
  });
  expect(response.status).toBe(401);
  expect((await response.json()).request).toBeUndefined();
});

it("keeps backend Auth errors retryable and invalid App Check tokens client errors", async () => {
  const email = "dev-status-network@example.test";
  const password = "fixture-password";
  const user = await admin.auth().createUser({ email, password, emailVerified: true });
  try {
    await db.doc(`users/${user.uid}`).set({ email, active: true, role: "admin" });
    const auth = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fixture`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const token = (await auth.json()).idToken;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json",
      "x-njpbs-cms-edge": "local-cms-edge-only" };
    authFailure = true;
    const failed = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
      method: "POST", headers, body: "{}",
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Staff access status is unavailable. Try again." });
    authFailure = false;
    const invalidAppCheck = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
      method: "POST", headers: { ...headers, "x-firebase-appcheck": "invalid-token" }, body: "{}",
    });
    expect(invalidAppCheck.status).toBe(401);
    const requestSpy = vi.spyOn(https, "request").mockImplementation((options, callback) => {
      expect(options.hostname).toBe("firebaseappcheck.googleapis.com");
      return http.request({ hostname: "127.0.0.1", port: authProxy.address().port,
        path: "/jwks-unavailable", method: "GET" }, callback);
    });
    try {
      const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
      const appCheckToken = [encode({ alg: "RS256", kid: "fixture" }), encode({
        aud: [`projects/${db.projectId}`], iss: "https://firebaseappcheck.googleapis.com/fixture",
        sub: "fixture-app", exp: Math.floor(Date.now() / 1000) + 60,
      }), "ZmFrZQ"].join(".");
      const unavailableAppCheck = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
        method: "POST", headers: { ...headers, "x-firebase-appcheck": appCheckToken }, body: "{}",
      });
      expect(unavailableAppCheck.status).toBe(500);
      expect(await unavailableAppCheck.json()).toEqual({ error: "Staff access status is unavailable. Try again." });
    } finally {
      requestSpy.mockRestore();
    }
    const recovered = await fetch(`http://127.0.0.1:${server.address().port}/status`, {
      method: "POST", headers, body: "{}",
    });
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).request.state).toBe("ready");
  } finally {
    authFailure = false;
    await db.doc(`users/${user.uid}`).delete();
    await admin.auth().deleteUser(user.uid);
  }
});
