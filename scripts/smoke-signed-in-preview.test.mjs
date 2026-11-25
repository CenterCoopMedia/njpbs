import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { abortCode, checkSignedInPreview, PREVIEW_HANG_BACKSTOP_MS, previewSmokeSettings, routePreviewSmokeAccess, STAGE_HANG_BACKSTOP_MS } from "./smoke-signed-in-preview.mjs";

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
  sessionFailure, noDocument = false, progress = "building", later, job, reader = false, jobStatus = 200, hasProgress = true,
  noPopup = false, editorAlert = false, signInStatus, editorError, documentFailure, stalled = false, disabledReason } = {}) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  const frame = {};
  const artifact = `${settings.preview}/p/abcdefghijklmnopqrst/smoke-fixture/`;
  const staffSession = `${settings.preview}/__cms-session`;
  // Like Playwright with its clock off: a wait for something that never comes never ends.
  const wait = (emitter, event, predicate) => new Promise(resolve => {
    const receive = value => {
      if (predicate && !predicate(value)) return;
      emitter.off(event, receive);
      resolve(value);
    };
    emitter.on(event, receive);
  });
  let popupUrl = "about:blank";
  const popup = Object.assign(new EventEmitter(), {
    mainFrame: () => frame,
    url: () => popupUrl,
    locator(selector) {
      assert.equal(selector, "main.cms-preview-progress");
      // data-state folds each failure into "error", as Admin writes it.
      const folded = ["refresh-failed", "session-slow", "updating"].includes(progress) ? "error" : progress;
      const node = { getAttribute: name => name === "data-progress" ? hasProgress ? progress : null : folded };
      return { evaluateAll: async read => read([node]) };
    },
    // A stalled stylesheet or image holds the document's load states open.
    waitForLoadState: state => { assert.equal(state, "domcontentloaded"); return stalled ? new Promise(() => {}) : Promise.resolve(); },
    async waitForURL(matches, options) { assert.equal(matches(new URL(artifact)), true); assert.deepEqual(options, { waitUntil: "commit" }); },
    getByRole(role, options) {
      assert.equal(role, "heading");
      assert.equal(options.name, settings.heading);
      assert.equal(options.exact, true);
      return { first: () => ({ waitFor: () => headingVisible ? Promise.resolve() : new Promise(() => {}) }), count: async () => headingVisible ? 1 : 0 };
    },
  });
  const response = (url, status, method, navigation, sent) => ({
    url: () => url, status: () => status, frame: () => frame,
    request: () => ({ url: () => url, method: () => method, postData: () => sent ? JSON.stringify(sent) : null, isNavigationRequest: () => navigation, resourceType: () => navigation ? "document" : "fetch" }),
  });

  let location;
  let password = "";
  Object.assign(page, {
    url: () => location,
    async goto(url) {
      location = url;
      return { status: () => 200 };
    },
    waitForResponse: predicate => wait(page, "response", predicate),
    locator: selector => selector === "body"
      ? { async ariaSnapshot() { assert.equal(password, ""); } }
      : { getByRole: () => ({ async click() {
        assert.equal(password, credential.password);
        if (signInStatus) page.emit("response", response("https://identity.example.test/v1/accounts:signInWithPassword", signInStatus, "POST", false));
      } }) },
    getByLabel: label => label === "Email" ? { async fill() {} } : {
      async waitFor() {},
      async elementHandle() {
        return { async fill(value) { password = value; }, async evaluate() { return true; }, async dispose() {} };
      },
    },
    getByText: pattern => ({ first: () => ({ waitFor: () =>
      editorError && pattern.test(editorError) ? Promise.resolve() : new Promise(() => {}) }) }),
    getByRole: (role, options) => role === "group" ? {
      evaluateAll: async read => read(disabledReason ? [{ getAttribute: () => `Preview unavailable: ${disabledReason}` }] : []),
    } : role === "alert" ? {
      filter({ hasText }) {
        assert.equal(hasText.test("Allow pop-ups for this CMS, then select Preview again. Your edits have not changed."), true);
        assert.equal(hasText.test("This draft has no preview yet."), false);
        return { first: () => ({ waitFor: () => editorAlert ? new Promise(resolve => setTimeout(resolve, 5)) : new Promise(() => {}) }) };
      },
    } : pageButton(options.name),
  });
  const pageButton = name => ({
      isDisabled: async () => Boolean(disabledReason),
      waitFor: () => (signInStatus && name !== "Preview") || (editorError && name === "Preview") ? new Promise(() => {}) : Promise.resolve(),
      async click() {
        assert.equal(name, "Preview");
        assert.equal(password, "");
        if (noPopup) return;
        context.emit("page", popup);
        if (sessionFailure) page.emit("requestfailed", { url: () => staffSession, method: () => "POST", failure: () => ({ errorText: sessionFailure }) });
        else page.emit("response", response(staffSession, sessionStatus, "POST", false));
        // Admin can move the tab after the smoke has already seen a refused session.
        if (later) setTimeout(() => { if (later.url) popupUrl = later.url; if (later.progress) progress = later.progress; }, 300);
        if (job) {
          const reply = reader
            ? response("https://dev-cms-api.example.test/api/cms/v2/reader", jobStatus, "POST", false, { version: 2, action: "request", endpoint: "cmsPreviewStatus", body: {} })
            : response("https://dev-cms-api.example.test/cmsPreviewStatus", jobStatus, "POST", false);
          page.emit("response", { ...reply, json: async () => job });
        }
        if (documentFailure) {
          context.emit("requestfailed", { url: () => artifact, isNavigationRequest: () => true, resourceType: () => "document",
            failure: () => ({ errorText: documentFailure }) });
          return;
        }
        if (noDocument) return;
        popupUrl = artifact;
        context.emit("response", response(artifact, documentStatus, "GET", true));
        if (documentStatus !== 200) context.emit("response", response(artifact, 200, "GET", true));
      },
  });
  Object.assign(context, { newPage: async () => page, waitForEvent: (event, options) => wait(context, event, options?.predicate),
    setDefaultTimeout(value) { assert.equal(value, 0); } });
  return { newContext: async () => context };
}

test("requires staff session, first private document response and fixture heading", async () => {
  const settings = previewSmokeSettings("production", env);
  const atArtifact = { place: "preview", progress: null };
  assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings), settings), { ok: true, code: "signed_in_private_preview" });
  for (const [input, receipt] of [
    [{ sessionStatus: 403 }, { code: "preview_session_failed", missing: [],
      session: { status: 403 }, job: null, document: { status: 200 }, popup: atArtifact }],
    [{ documentStatus: 302 }, { code: "preview_document_failed", missing: [],
      session: { status: 204 }, job: null, document: { status: 302 }, popup: atArtifact }],
    [{ headingVisible: false }, { code: "preview_heading_missing", missing: [],
      session: { status: 204 }, job: null, document: { status: 200 }, popup: atArtifact }],
  ]) {
    assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings, input), settings), { ok: false, ...receipt });
  }
});

test("ends on a refused sign-in and an editor that cannot load its record", async () => {
  const settings = previewSmokeSettings("production", env);
  assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings, { signInStatus: 400 }), settings), { ok: false, code: "staff_sign_in_failed" });
  for (const editorError of ["You do not have permission to edit this record.", "Deleted records cannot be edited here."]) {
    assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings, { editorError }), settings), { ok: false, code: "editor_unavailable" });
  }
});

test("names a disabled Preview control at once", async () => {
  const settings = previewSmokeSettings("production", env);
  for (const [disabledReason, reason] of [["Wait for a saved page to load before previewing.", "page_not_saved"],
    ["Wait for a saved record to load before previewing.", "record_not_saved"],
    ["Your access does not allow saving these changes for preview.", "save_not_allowed"],
    ["Draft title at /x", "unlisted"]]) {
    assert.deepEqual(await checkSignedInPreview(fixtureBrowser(settings, { disabledReason }), settings),
      { ok: false, code: "preview_control_disabled", reason });
  }
});

test("names the missing wait and where the preview tab settled", async () => {
  const settings = previewSmokeSettings("production", env);
  // The fixture's waits never time out, so each case ends on its event or on the hang backstop given here.
  const check = (input, limits) => checkSignedInPreview(fixtureBrowser(settings, input), settings, limits);
  const timeoutText = "Preview build did not finish within 45 minutes";
  // Only the hang backstop ends the wait while the job is still building.
  assert.deepEqual(await check({ noDocument: true, job: { status: "building" } }, { previewMs: 20 }), {
    ok: false, code: "private_preview_unavailable", missing: ["document"],
    session: { status: 204 }, job: { status: "building" }, document: null, popup: { place: "about:blank", progress: "building" },
  });
  // A long wait says what it waits for.
  const said = [];
  await check({ noDocument: true, job: { status: "building" } }, { previewMs: 100, noteMs: 20, note: text => said.push(text) });
  assert.match(said[0], /^Still waiting: private_preview_unavailable, \{.*"job":\{"status":"building"\}/);
  // A failed older job alone does not end the wait; Admin's terminal state does, and the receipt names the job error.
  assert.deepEqual(await check({ noDocument: true, job: { status: "failed", error: timeoutText, previewUrl: null },
    progress: "waiting", later: { progress: "error" } }), {
    ok: false, code: "preview_admin_stopped", missing: ["document"],
    session: { status: 204 }, job: { status: "failed", error: "preview_build_timeout" }, document: null,
    popup: { place: "about:blank", progress: "error" },
  });
  // The typed reason names a refresh; a reader-routed status reply is the same job.
  assert.deepEqual((await check({ noDocument: true, progress: "refresh-failed", reader: true, job: { status: "failed",
    failureReason: "preview_context_refreshing", error: "Previews are refreshing after a recent publish. Try again in a minute." } })).job,
  { status: "failed", error: "preview_context_refreshing" });
  assert.deepEqual((await check({ noDocument: true, progress: "error", job: { status: "failed", error: "Preview build failed" } })).job,
    { status: "failed", error: "preview_build_failed" });
  assert.deepEqual((await check({ noDocument: true, progress: "updating", reader: true, jobStatus: 503,
    job: { error: "Preview renderer is updating; try again shortly", code: "preview-renderer-updating" } })).job,
  { http: 503, code: "preview-renderer-updating" });
  // Admin stopping in the tab (for example while the renderer updates) also ends the wait.
  assert.deepEqual(await check({ noDocument: true, progress: "updating" }), {
    ok: false, code: "preview_admin_stopped", missing: ["document"],
    session: { status: 204 }, job: null, document: null, popup: { place: "about:blank", progress: "updating" },
  });
  // An Admin build without data-progress still ends it through data-state.
  assert.deepEqual((await check({ noDocument: true, hasProgress: false, progress: "updating" })).code, "preview_admin_stopped");
  // A blocked popup leaves only the editor's own error.
  assert.deepEqual(await check({ noPopup: true, editorAlert: true }), {
    ok: false, code: "preview_admin_stopped", missing: ["popup", "session", "document"], session: null, job: null, document: null, popup: null,
  });
  // The browser's own failure of the session request ends the wait: nothing else in this fixture can.
  assert.deepEqual(await check({ sessionFailure: "net::ERR_HTTP2_PROTOCOL_ERROR", noDocument: true, progress: "session-slow" }), {
    ok: false, code: "preview_session_failed", missing: ["document"],
    session: { failed: "net::ERR_HTTP2_PROTOCOL_ERROR" }, job: null, document: null, popup: { place: "about:blank", progress: "session-slow" },
  });
  // Admin aborts its session request after the preview operation fails; the preview error wins.
  assert.deepEqual(await check({ sessionFailure: "net::ERR_ABORTED", noDocument: true, progress: "error",
    job: { status: "failed", error: timeoutText } }), {
    ok: false, code: "preview_admin_stopped", missing: ["document"],
    session: { failed: "net::ERR_ABORTED" }, job: { status: "failed", error: "preview_build_timeout" }, document: null,
    popup: { place: "about:blank", progress: "error" },
  });
  // A failed document navigation ends the wait at once, and the job's last status stays in the receipt.
  assert.deepEqual(await check({ documentFailure: "net::ERR_CONNECTION_RESET", noDocument: true }), {
    ok: false, code: "preview_document_failed", missing: [], session: { status: 204 }, job: null,
    document: { failed: "net::ERR_CONNECTION_RESET" }, popup: { place: "about:blank", progress: "building" },
  });
  // The visible heading passes while the document's other resources are still open.
  assert.deepEqual(await check({ stalled: true }), { ok: true, code: "signed_in_private_preview" });
  // A refused session fails at once; the receipt waits for Admin's sign-in handoff.
  assert.deepEqual(await check({ sessionStatus: 401, noDocument: true, later: { url: `${settings.admin}/?staffSite=x` } }), {
    ok: false, code: "preview_session_failed", missing: ["document"],
    session: { status: 401 }, job: null, document: null, popup: { place: "admin", progress: null },
  });
  // Unknown progress values, other hosts and raw failure text never reach the receipt.
  const receipt = await check({ sessionFailure: "net::ERR_FAILED https://secret.example/?token=x", noDocument: true,
    progress: "<b>draft title</b>", later: { url: "https://another.example.org/" }, job: { status: "building", error: "Draft title at /x" } });
  assert.deepEqual([receipt.session, receipt.job, receipt.popup],
    [{ failed: "failed" }, { status: "building", error: "unlisted" }, { place: "other", progress: null }]);
});

test("keeps each hang backstop past the server's build limit and inside its step", () => {
  const { PREVIEW_BUILD_TIMEOUT_MS, PREVIEW_BUILD_TIMEOUT_ERROR } = createRequire(import.meta.url)("../functions/lib/preview-build-policy.js");
  assert.ok(PREVIEW_HANG_BACKSTOP_MS > 2 * PREVIEW_BUILD_TIMEOUT_MS);
  assert.ok(readFileSync(new URL("./smoke-signed-in-preview.mjs", import.meta.url), "utf8").includes(`["${PREVIEW_BUILD_TIMEOUT_ERROR}"`));
  const total = PREVIEW_HANG_BACKSTOP_MS + 2 * STAGE_HANG_BACKSTOP_MS;
  for (const file of ["cms-staging-deploy.yml", "cms-dev-deploy.yml"]) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const step = source.slice(source.indexOf("- name: Smoke-test one signed-in private preview"));
    assert.ok(Number(step.match(/timeout-minutes: (\d+)/)[1]) * 60_000 > total, file);
  }
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
