// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("the locked SDK emits same-uid sign-ins and refreshes only through token events, with cached claim reads", async () => {
  // The Node SDK captures fetch at import time. Install the synthetic boundary
  // first in a fresh process, so it can neither make network calls nor affect
  // another test's SDK instance.
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
    const uid = "synthetic-staff";
    const now = Math.floor(Date.now() / 1000);
    let authTime = now - 10, sequence = 0, requests = 0, refreshRequests = 0;
    const token = () => "header." + Buffer.from(JSON.stringify({ sub: uid, auth_time: authTime,
      iat: now, exp: now + 3600, email_verified: true, sequence: ++sequence,
      firebase: { sign_in_provider: "password", identities: {} } })).toString("base64url") + ".signature";
    globalThis.fetch = async input => {
      requests += 1;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname === "identitytoolkit.googleapis.com" && url.pathname.endsWith("accounts:signInWithPassword")) {
        authTime += 1;
        return Response.json({ localId: uid, email: "staff@example.test", idToken: token(),
          refreshToken: "synthetic-refresh", expiresIn: "3600" });
      }
      if (url.hostname === "identitytoolkit.googleapis.com" && url.pathname.endsWith("accounts:lookup")) {
        return Response.json({ users: [{ localId: uid, email: "staff@example.test", emailVerified: true,
          createdAt: String(now * 1000), lastLoginAt: String(authTime * 1000) }] });
      }
      if (url.hostname === "securetoken.googleapis.com" && url.pathname === "/v1/token") {
        refreshRequests += 1;
        return Response.json({ user_id: uid, access_token: token(), refresh_token: "synthetic-refresh", expires_in: "3600" });
      }
      throw new Error("Unexpected synthetic SDK request: " + url.origin + url.pathname);
    };
    const { deleteApp, initializeApp } = await import("firebase/app");
    const { initializeAuth, inMemoryPersistence, onAuthStateChanged, onIdTokenChanged,
      signInWithEmailAndPassword } = await import("firebase/auth");
    const app = initializeApp({ apiKey: "synthetic-key", projectId: "synthetic-session-events" }, "session-events-test");
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    let authEvents = 0, tokenEvents = 0;
    const unsubscribeAuth = onAuthStateChanged(auth, user => { if (user) authEvents += 1; });
    const unsubscribeToken = onIdTokenChanged(auth, user => { if (user) tokenEvents += 1; });
    try {
      await auth.authStateReady();
      await signInWithEmailAndPassword(auth, "staff@example.test", "synthetic-password");
      const firstTime = (await auth.currentUser.getIdTokenResult()).claims.auth_time;
      await signInWithEmailAndPassword(auth, "staff@example.test", "synthetic-password");
      const requestsAfterSignIn = requests;
      const secondTime = (await auth.currentUser.getIdTokenResult()).claims.auth_time;
      const signedIn = { firstTime, secondTime, authEvents, tokenEvents, requestsAfterSignIn, requestsAfterRead: requests };
      await auth.currentUser.getIdToken(true);
      const requestsAfterRefresh = requests;
      const refreshedTime = (await auth.currentUser.getIdTokenResult()).claims.auth_time;
      console.log(JSON.stringify({ signedIn, refreshed: { authTime: refreshedTime, authEvents,
        tokenEvents, requestsAfterRefresh, requestsAfterRead: requests, refreshRequests } }));
    } finally {
      unsubscribeAuth(); unsubscribeToken(); await deleteApp(app);
    }
  `]);
  const { signedIn, refreshed } = JSON.parse(stdout);
  expect(typeof signedIn.secondTime).toBe("number");
  expect(signedIn.secondTime).not.toBe(signedIn.firstTime);
  expect(signedIn).toMatchObject({ authEvents: 1, tokenEvents: 2, requestsAfterRead: signedIn.requestsAfterSignIn });
  expect(refreshed).toMatchObject({ authTime: signedIn.secondTime, authEvents: 1,
    tokenEvents: 3, requestsAfterRead: refreshed.requestsAfterRefresh, refreshRequests: 1 });
});
