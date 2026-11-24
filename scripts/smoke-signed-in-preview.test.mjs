import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { abortCode, checkSignedInPreview, previewSmokeSettings, routePreviewSmokeAccess } from "./smoke-signed-in-preview.mjs";

const credential = { email: "preview@example.org", password: "fixture-password" };
const access = { "CF-Access-Client-Id": "preview.access", "CF-Access-Client-Secret": "fixture-secret" };
const target = { editor: "/content/post/smoke-fixture/edit", heading: "Private preview fixture" };
const env = {
  CMS_DEV_ADMIN_ORIGIN: "https://dev-admin.example.test",
  CMS_DEV_PREVIEW_ORIGIN: "https://dev-preview.example.test",
  CMS_PREVIEW_SMOKE_CREDENTIAL: JSON.stringify({ ...credential, adminAccess: access, previewAccess: access }),
  CMS_PREVIEW_SMOKE_TARGET: JSON.stringify(target),
};

test("sets distinct dev Access targets and keeps production on its fixed origins", () => {
  const dev = previewSmokeSettings("development", env);
  assert.deepEqual(dev.access, [[env.CMS_DEV_ADMIN_ORIGIN, access], [env.CMS_DEV_PREVIEW_ORIGIN, access]]);
  const production = previewSmokeSettings("production", env);
  assert.equal(production.admin, "https://admin.njpbs.org");
  assert.equal(production.preview, "https://preview.njpbs.org");
  assert.deepEqual(production.access, []);
  assert.throws(() => previewSmokeSettings("development", { ...env, CMS_DEV_PREVIEW_ORIGIN: production.preview }));
  assert.throws(() => previewSmokeSettings("development", { ...env, CMS_PREVIEW_SMOKE_CREDENTIAL: JSON.stringify(credential) }));
  assert.throws(() => previewSmokeSettings("production", {
    ...env, CMS_PREVIEW_SMOKE_TARGET: JSON.stringify({ ...target, editor: "/content/posts/smoke-fixture/edit" }),
  }));
  assert.throws(() => previewSmokeSettings("production", {
    ...env, CMS_PREVIEW_SMOKE_TARGET: JSON.stringify({ ...target, editor: "//another.example.org/content/post/fixture/edit" }),
  }));
});

test("adds Access headers on one origin and refuses to forward them on redirects", async () => {
  await routePreviewSmokeAccess({ async route(matches, handle) {
    assert.equal(matches(new URL("https://dev-preview.example.test/p/fixture/")), true);
    assert.equal(matches(new URL("https://dev-preview.example.test.other.example.org/p/fixture/")), false);
    const reply = { status: 302, async dispose() { reply.disposed = true; } };
    let forwarded;
    await handle({
      request: () => ({ headers: () => ({ origin: env.CMS_DEV_ADMIN_ORIGIN }) }),
      async fetch(options) { forwarded = options; return reply; },
      async fulfill(options) { assert.equal(options.response, reply); },
      async abort() { assert.fail("The redirect must be returned to the browser"); },
    });
    assert.deepEqual(forwarded, { headers: { origin: env.CMS_DEV_ADMIN_ORIGIN, ...access }, maxRedirects: 0 });
    assert.equal(reply.disposed, true);
  } }, env.CMS_DEV_PREVIEW_ORIGIN, access);
});

function fixtureBrowser(settings, { sessionStatus = 204, documentStatus = 200, headingVisible = true,
  sessionFailure, noDocument = false, progress = "building", later } = {}) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  const frame = {};
  const artifact = `${settings.preview}/p/abcdefghijklmnopqrst/smoke-fixture/`;
  const staffSession = `${settings.preview}/__cms-session`;
  const wait = (emitter, event, predicate, timeout) => new Promise((resolve, reject) => {
    // A wait for something the fixture never sends times out at once.
    if (timeout && ((event === "response" && emitter === context && noDocument) ||
        (event === "response" && emitter === page && sessionFailure))) {
      setTimeout(() => reject(new Error("Timeout exceeded")), 5);
    }
    const receive = value => {
      if (predicate && !predicate(value)) return;
      emitter.off(event, receive);
      resolve(value);
    };
    emitter.on(event, receive);
  });
  let popupUrl = "about:blank";
  const popup = {
    mainFrame: () => frame,
    url: () => popupUrl,
    locator(selector) {
      assert.equal(selector, "main.cms-preview-progress");
      return { first: () => ({ async getAttribute(name) { assert.equal(name, "data-progress"); return progress; } }) };
    },
    async waitForURL(matches) { assert.equal(matches(new URL(artifact)), true); },
    getByRole(role, options) {
      assert.equal(role, "heading");
      assert.deepEqual(options, { name: settings.heading, exact: true });
      return { first: () => ({ async waitFor() { if (!headingVisible) throw new Error("fixture heading missing"); } }) };
    },
  };
  const response = (url, status, method, navigation) => ({
    url: () => url, status: () => status, frame: () => frame,
    request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation, resourceType: () => navigation ? "document" : "fetch" }),
  });

  let location;
  let password = "";
  Object.assign(page, {
    url: () => location,
    async goto(url) { location = url; return { status: () => 200 }; },
    setDefaultTimeout() {},
    waitForResponse: (predicate, options) => wait(page, "response", predicate, options?.timeout),
    locator: selector => selector === "body"
      ? { async ariaSnapshot() { assert.equal(password, ""); } }
      : { getByRole: () => ({ async click() { assert.equal(password, credential.password); } }) },
    getByLabel: label => label === "Email" ? { async fill() {} } : {
      async waitFor() {},
      async elementHandle() {
        return { async fill(value) { password = value; }, async evaluate() { return true; }, async dispose() {} };
      },
    },
    getByRole: (_role, { name }) => ({
      async waitFor() {},
      async click() {
        assert.equal(name, "Preview");
        assert.equal(password, "");
        context.emit("page", popup);
        if (sessionFailure) page.emit("requestfailed", { url: () => staffSession, method: () => "POST", failure: () => ({ errorText: sessionFailure }) });
        else page.emit("response", response(staffSession, sessionStatus, "POST", false));
        // Admin can move the tab after the smoke has already seen a refused session.
        if (later) setTimeout(() => { if (later.url) popupUrl = later.url; if (later.progress) progress = later.progress; }, 300);
        if (noDocument) return;
        popupUrl = artifact;
        context.emit("response", response(artifact, documentStatus, "GET", true));
        if (documentStatus !== 200) context.emit("response", response(artifact, 200, "GET", true));
      },
    }),
  });
  Object.assign(context, { newPage: async () => page, waitForEvent: (event, options) => wait(context, event, options.predicate, options.timeout) });
  return { newContext: async () => context };
}

test("requires staff session, first private document response and fixture heading", async () => {
  const settings = previewSmokeSettings("production", env);
  const atArtifact = { place: "preview", progress: null };
  assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings), settings), { ok: true, code: "signed_in_private_preview" });
  for (const [input, receipt] of [
    [{ sessionStatus: 403 }, { code: "preview_session_failed", missing: [],
      session: { status: 403 }, document: { status: 200 }, popup: atArtifact }],
    [{ documentStatus: 302 }, { code: "preview_document_failed", missing: [],
      session: { status: 204 }, document: { status: 302 }, popup: atArtifact }],
    [{ headingVisible: false }, { code: "preview_heading_missing", missing: [],
      session: { status: 204 }, document: { status: 200 }, popup: atArtifact }],
  ]) {
    assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings, input), settings), { ok: false, ...receipt });
  }
});

test("names the missing wait and where the preview tab settled", async () => {
  const settings = previewSmokeSettings("production", env);
  const check = input => checkSignedInPreview(fixtureBrowser(settings, input), settings);
  assert.deepEqual(await check({ noDocument: true, progress: "error" }), {
    ok: false, code: "private_preview_unavailable", missing: ["document"],
    session: { status: 204 }, document: null, popup: { place: "about:blank", progress: "error" },
  });
  assert.deepEqual(await check({ sessionFailure: "net::ERR_HTTP2_PROTOCOL_ERROR", noDocument: true, progress: "session-slow" }), {
    ok: false, code: "private_preview_unavailable", missing: ["document"],
    session: { failed: "net::ERR_HTTP2_PROTOCOL_ERROR" }, document: null, popup: { place: "about:blank", progress: "session-slow" },
  });
  // A refused session fails at once; the receipt waits for Admin's sign-in handoff.
  assert.deepEqual(await check({ sessionStatus: 401, noDocument: true, later: { url: `${settings.admin}/?staffSite=x` } }), {
    ok: false, code: "preview_session_failed", missing: ["document"],
    session: { status: 401 }, document: null, popup: { place: "admin", progress: null },
  });
  assert.deepEqual((await check({ noDocument: true, later: { progress: "updating" } })).popup, { place: "about:blank", progress: "updating" });
  // Unknown progress values, other hosts and raw failure text never reach the receipt.
  const receipt = await check({ sessionFailure: "net::ERR_FAILED https://secret.example/?token=x", noDocument: true,
    progress: "<b>draft title</b>", later: { url: "https://another.example.org/" } });
  assert.deepEqual([receipt.session, receipt.popup], [{ failed: "failed" }, { place: "other", progress: null }]);
});

test("aborts a failed Access fetch with the upstream failure class", async () => {
  assert.deepEqual(["getaddrinfo ENOTFOUND dev-preview.example.test", "connect ECONNREFUSED 192.0.2.1:443", "socket hang up",
    "Timeout 30000ms exceeded.", "unable to verify the first certificate"].map(message => abortCode(new Error(message))),
  ["namenotresolved", "connectionrefused", "connectionreset", "timedout", "failed"]);
  await routePreviewSmokeAccess({ async route(_matches, handle) {
    let aborted;
    await handle({
      request: () => ({ headers: () => ({}) }),
      async fetch() { throw new Error("getaddrinfo ENOTFOUND dev-preview.example.test"); },
      async fulfill() { assert.fail("A failed fetch is never fulfilled"); },
      async abort(code) { aborted = code; },
    });
    assert.equal(aborted, "namenotresolved");
  } }, env.CMS_DEV_PREVIEW_ORIGIN, access);
});
