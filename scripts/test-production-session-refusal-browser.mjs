#!/usr/bin/env node
// Offline proof of the live method. Every browser request is fulfilled or
// aborted locally; the dev fetch is also fake. No credential or network needed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkProductionSessionRefusal } from "./check-production-session-refusal.mjs";

const require = createRequire(new URL("../admin/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const now = Date.now();
const seconds = Math.floor(now / 1000);
const token = ["fixture", Buffer.from(JSON.stringify({
  aud: "njpbs-site", iss: "https://securetoken.google.com/njpbs-site", sub: "staff-fixture",
  iat: seconds, exp: seconds + 3600,
})).toString("base64url"), "fixture"].join(".");
const credential = { email: "staff@example.org", password: "fake-password" };
const seen = [];
let cleanupChecked = false;
const result = await checkProductionSessionRefusal({
  now: () => now,
  readCredential: async () => credential,
  readAccess: async () => ({ "CF-Access-Client-Id": "fixture.access", "CF-Access-Client-Secret": "fake-access-secret" }),
  chromium: {
    launch: async options => {
      assert.equal(options.chromiumSandbox, true);
      assert.equal(options.args.includes("--no-sandbox"), false);
      const browser = await chromium.launch(options);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await newContext(options);
        await context.route("**/*", async route => {
          const url = route.request().url();
          if (url === "https://admin.njpbs.org/") {
            seen.push("login-form");
            return route.fulfill({ contentType: "text/html", body: `<!doctype html>
              <form><label>Email<input type="email"></label><label>Password<input type="password"></label>
              <input type="hidden" name="csrf" value="keep-fixture"><button>Sign in</button></form>
              <script>document.querySelector('form').onsubmit = async event => {
                event.preventDefault();
                await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-public-key', {
                  method: 'POST', body: JSON.stringify({ email: document.querySelector('[type=email]').value,
                    password: document.querySelector('[type=password]').value })
                });
                fetch('https://api.njpbs.org/registerStaffProfile', { method: 'POST' }).catch(() => {});
              };</script>` });
          }
          if (url.startsWith("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?")) {
            seen.push("firebase-sign-in");
            assert.deepEqual(JSON.parse(route.request().postData()), credential);
            return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "https://admin.njpbs.org" },
              body: JSON.stringify({ idToken: token, localId: "staff-fixture" }) });
          }
          // Never fall through to a real network, even if the method regresses.
          seen.push("unexpected-network");
          await route.abort();
        });
        return context;
      };
      const close = browser.close.bind(browser);
      browser.close = async () => {
        // A fake server response deliberately leaves the sign-in form present.
        // Verify cleanup of only the originally typed password before teardown.
        try {
          const page = browser.contexts()[0]?.pages()[0];
          if (page) {
            assert.equal(await page.getByLabel("Password", { exact: true }).inputValue(), "");
            assert.equal(await page.locator('[type=hidden]').inputValue(), "keep-fixture");
            cleanupChecked = true;
          }
        } finally { await close(); }
      };
      return browser;
    },
  },
  fetchImpl: async (url, init) => {
    assert.equal(url, "https://dev-public.example.org/__cms-session");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(cleanupChecked, true);
    seen.push("dev-probe");
    return new Response(null, { status: 401, headers: {
      "access-control-allow-origin": "https://dev-admin.example.org", "access-control-allow-credentials": "true",
      "cache-control": "private, no-store",
      "set-cookie": "CF_Authorization=fake-access-cookie; Path=/; Secure; HttpOnly",
    } });
  },
});
assert.deepEqual(result, { status: 401, route: "https://dev-public.example.org/__cms-session", refused: true,
  audienceMismatch: "production_token_refused_by_dev" });
assert.deepEqual(seen, ["login-form", "firebase-sign-in", "dev-probe"]);
assert.equal(cleanupChecked, true);
console.log("PASS: sandboxed Chromium, fake sign-in, password-only cleanup, production write denial, dev refusal.");
