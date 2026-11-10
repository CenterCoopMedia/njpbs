"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const panelAssets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/index.js", ["index.js", "text/javascript; charset=utf-8"]],
  ["/index.css", ["index.css", "text/css; charset=utf-8"]],
  ["/brand/tokens.css", ["brand/tokens.css", "text/css; charset=utf-8"]],
  ["/brand/njpbs-horizontal-white.svg", ["brand/njpbs-horizontal-white.svg", "image/svg+xml"]],
]);
async function panelUrl(t) {
  const root = path.resolve(__dirname, "../dist");
  const server = createServer(async (request, response) => {
    const asset = panelAssets.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!asset) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(path.join(root, asset[0]));
      response.writeHead(200, { "content-type": asset[1], "cache-control": "no-store" }).end(body);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/index.html`;
}

async function openPanel(t, beforeResponse = async () => {}) {
  const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); t.diagnostic(error.stack); });
  const originalReads = [];
  const downloaded = [];
  const posterReads = [];
  const detailReads = [];
  const asset = id => ({ id, name: `Camera ${id}`, originalName: `${id}.mp4`, description: `Interview ${id}`,
    sizeBytes: 4, rightsStatus: "pending", viewingCopy: { durationSeconds: 90 }, version: 1 });
  await page.route("https://api.example.org/**", async route => {
    const { operation, payload } = route.request().postDataJSON();
    if (operation === "cmsListSourceMedia" && payload.assetId) detailReads.push(payload.assetId);
    if (await beforeResponse(operation, payload, route)) return;
    let body;
    if (operation === "session") body = { user: { uid: "test-editor", displayName: "Test editor" }, expiresAt: new Date(Date.now() + 86400000).toISOString() };
    else if (operation === "cmsListSourceMedia") {
      if (payload.assetId) {
        body = { records: [{ ...asset(payload.assetId), markers: [] }], hasMore: false, nextCursor: null };
      } else {
        assert.equal(payload.posters, true);
        const ids = payload.q ? ["first", "second", "third"].filter(id => asset(id).name.toLowerCase().startsWith(payload.q.toLowerCase()))
          : payload.cursor ? ["third"] : ["first", "second"];
        body = { records: ids.map(asset), hasMore: !payload.q && !payload.cursor, nextCursor: payload.q || payload.cursor ? null : "next",
          posters: ids.map(id => ({ assetId: id, url: `https://fixture.s3.us-east-2.amazonaws.com/posters/${id}.png` })) };
      }
    } else {
      assert.equal(operation, "cmsCreateSourceMediaRead");
      assert.equal(payload.action, "download");
      originalReads.push(payload.assetId);
      body = { access: { url: `https://fixture.s3.us-east-2.amazonaws.com/originals/${payload.assetId}.mp4` } };
    }
    await route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } });
  });
  await page.route("https://fixture.s3.us-east-2.amazonaws.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/posters/")) {
      posterReads.push(url.pathname);
      await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO7cAAAAASUVORK5CYII=", "base64") });
    } else {
      downloaded.push(url.pathname);
      await route.fulfill({ contentType: "video/mp4", body: Buffer.from([1, 2, 3, 4]), headers: { "access-control-allow-origin": "*" } });
    }
  });
  // Only platform boundaries are substituted: UXP storage/filesystem and Premiere.
  await page.addInitScript(() => {
    const session = { sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "test-editor", displayName: "Test editor" }, expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const folder = { nativePath: "C:/fixture-cache", getEntries: async () => [],
      createFile: async name => ({ nativePath: `C:/fixture-cache/${name}`, name }),
      getEntry: async name => ({ nativePath: `C:/fixture-cache/${name}`, name }), renameEntry: async () => {} };
    const diagnosticFile = name => ({ name, isFile: true,
      getMetadata: async () => ({ size: (localStorage.getItem(`fixture-file:${name}`) || "").length, dateModified: new Date().toISOString() }),
      read: async () => {
        const text = localStorage.getItem(`fixture-file:${name}`);
        if (window.holdJournalRead) {
          window.holdJournalRead = false;
          await new Promise(resolve => { window.finishJournalRead = resolve; });
        }
        return text;
      },
      write: async text => localStorage.setItem(`fixture-file:${name}`, text),
      delete: async () => localStorage.removeItem(`fixture-file:${name}`),
    });
    const dataFolder = {
      getEntries: async () => Object.keys(localStorage).filter(key => key.startsWith("fixture-file:")).map(key => diagnosticFile(key.slice(13))),
      createFile: async name => diagnosticFile(name),
      renameEntry: async (entry, name) => { await diagnosticFile(name).write(await entry.read()); await entry.delete(); },
    };
    window.importedPaths = [];
    const project = { name: "Fixture project", guid: "fixture-project", getInsertionBin: async () => ({}),
      importFiles: async paths => {
        if (window.failImport) throw new Error("Cannot import C:/private/Confidential-interview.mov");
        window.importedPaths.push(...paths); return true;
      } };
    window.require = name => {
      if (name === "uxp") return { entrypoints: { setup() {} }, shell: { openExternal: async () => {} }, storage: {
        secureStorage: { getItem: async () => new TextEncoder().encode(JSON.stringify(session)),
          setItem: async () => { if (window.holdSessionSave) await new Promise(resolve => { window.finishSessionSave = resolve; }); },
          removeItem: async () => { if (window.failForget) throw new Error("Could not remove the saved credential"); } },
        localFileSystem: { getEntryForPersistentToken: async () => folder, getFsUrl: entry => `file:/${entry.nativePath}`,
          getDataFolder: async () => dataFolder,
          getFileForOpening: async () => ({ name: "export.mp4", nativePath: "C:/fixture/export.mp4",
            getMetadata: async () => ({ size: 4, dateModified: "2026-10-03T00:00:00Z" }) }) },
      } };
      if (name === "premierepro") return { Project: { getActiveProject: async () => project },
        ProjectUtils: { getSelection: async () => ({ getItems: async () => [{
          getMediaFilePath: async () => window.selectedClipPath, isSequence: async () => false,
          isMergedClip: async () => false, isMulticamClip: async () => false,
        }] }) }, ClipProjectItem: { cast: clip => clip },
        Markers: { getMarkers: async () => {
          if (window.failMarkerRead) throw new Error("Native marker read failed");
          return { getMarkers: () => (window.fixtureMarkers || []).map(data => ({
            getType: () => data.type, getName: () => data.name, getComments: () => data.comment,
            getColorIndex: () => data.color, getStart: () => ({ seconds: data.startMs / 1000 }),
            getDuration: () => ({ seconds: (data.endMs - data.startMs) / 1000 }),
          })) };
        } } };
      if (name === "os") return { platform: () => "win32" };
      if (name === "fs") return { open: async path => {
        if (!path.startsWith("file:/")) throw new Error("Unimplemented method: open");
        return 1;
      }, write: async (_fd, _buffer, _offset, length) => ({ bytesWritten: length }), close: async () => {} };
      throw new Error(`Unexpected platform module: ${name}`);
    };
    localStorage.setItem("boardwalk-cache-folder", "fixture-cache-token");
  });
  await page.goto(await panelUrl(t));
  try { await page.locator("#library-status").filter({ hasText: "2 videos loaded" }).waitFor({ timeout: 5000 }); }
  catch (error) { t.diagnostic(await page.locator("body").innerText()); throw error; }
  return { page, errors, originalReads, downloaded, posterReads, detailReads };
}

test("marker details load only on selection and stale or failed reads cannot clear a clip", async t => {
  let release;
  t.after(() => release?.());
  let firstEntered;
  const waiting = new Promise(resolve => { firstEntered = resolve; });
  const { page, errors, originalReads, downloaded, detailReads } = await openPanel(t, async (operation, payload, route) => {
    if (operation !== "cmsListSourceMedia" || !payload.assetId) return;
    if (payload.assetId === "first") {
      await new Promise(resolve => { release = resolve; firstEntered(); });
      await route.fulfill({ json: { records: [{ id: "first", name: "Camera first", version: 3,
        markers: [{ startMs: 1000, endMs: 2000, name: "First marker", comment: "", type: "Comment", color: 0 }] }] },
        headers: { "access-control-allow-origin": "*" } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Media asset not found" }, headers: { "access-control-allow-origin": "*" } });
    }
    return true;
  });
  assert.deepEqual(detailReads, [], "the initial library does not fetch per-row details");
  await page.getByRole("button", { name: /Camera first/ }).click();
  await waiting;
  assert.equal(await page.locator("#marker-loading").isVisible(), true);
  assert.equal(await page.locator("#apply-markers").getAttribute("aria-disabled"), "true");
  assert.equal(await page.getByRole("button", { name: "Back to library" }).isEnabled(), true);
  await page.locator("#import").click();
  await page.waitForFunction(() => window.importedPaths.length === 1);
  await page.waitForFunction(() => document.querySelector('#back').getAttribute('aria-disabled') !== 'true');
  assert.equal(await page.locator("#marker-loading").isVisible(), true, "import finishes while marker metadata is still pending");
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.getByRole("button", { name: /Camera second/ }).click();
  await page.locator("#marker-count").filter({ hasText: "Reopen the video to retry" }).waitFor();
  const response = page.waitForResponse(result => result.request().postDataJSON()?.payload?.assetId === "first");
  release();
  await (await response).finished();
  assert.equal(await page.locator("#asset-name").textContent(), "Camera second");
  assert.equal(await page.locator("#marker-list").textContent(), "");
  assert.equal(await page.locator("#read-markers").getAttribute("aria-disabled"), "true");
  assert.equal(await page.locator("#marker-loading").isVisible(), false);
  assert.deepEqual(detailReads, ["first", "second"]);
  assert.deepEqual(originalReads, ["first"]);
  assert.deepEqual(downloaded, ["/originals/first.mp4"]);
  assert.deepEqual(errors, []);
});

test("revocation during a detail read immediately returns to the connection surface", async t => {
  const { page, errors } = await openPanel(t, async (operation, payload, route) => {
    if (operation === "cmsListSourceMedia" && payload.assetId) {
      await route.fulfill({ status: 401, json: { error: "Session revoked" }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
  });
  await page.getByRole("button", { name: /Camera first/ }).click();
  await page.locator("#connection").waitFor();
  assert.equal(await page.locator("#asset-detail").isVisible(), false);
  assert.equal(await page.locator("#account-name").textContent(), "Not connected.");
  assert.equal(await page.locator("#message").textContent(), "Your Boardwalk connection ended. Connect again.");
  assert.equal(await page.locator("#marker-loading").isVisible(), false);
  assert.deepEqual(errors, []);
});

for (const recovery of ["library", "report"]) {
  test(`a temporary startup failure recovers retained reports through ${recovery} without reloading`, async t => {
    let unavailable = false;
    const manual = [];
    const automatic = [];
    const { page, errors } = await openPanel(t, async (operation, payload, route) => {
      const headers = { "access-control-allow-origin": "*" };
      if (operation === "session" && unavailable) {
        await route.fulfill({ status: 503, headers, json: { error: "Session check unavailable" } });
        return true;
      }
      if (operation !== "cmsSubmitPremiereReport") return;
      if (payload.mode === "automatic") {
        automatic.push(payload);
        await route.fulfill({ headers, json: { success: true, mode: "automatic", accepted: true } });
      } else {
        manual.push(payload);
        await route.fulfill({ headers, status: manual.length === 1 ? 503 : 200,
          json: manual.length === 1 ? { error: "Reports unavailable" }
            : { success: true, mode: "manual", report: { id: "br_" + "b".repeat(32) } } });
      }
      return true;
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Report a problem", exact: true }).click();
    const description = "The selected video would not import.";
    await page.locator("#report-description").fill(description);
    await page.getByRole("button", { name: "Send report", exact: true }).click();
    await page.getByRole("button", { name: "Retry report", exact: true }).waitFor();
    unavailable = true;
    await page.reload();
    await page.locator("#message").filter({ hasText: "Session check unavailable" }).waitFor();
    assert.equal(await page.locator("#report-description").inputValue(), "", "unvalidated credentials do not reveal the journal");
    unavailable = false;
    if (recovery === "library") {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.locator("#library-status").filter({ hasText: "2 videos loaded" }).waitFor();
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    if (recovery === "report") await page.getByRole("button", { name: "Report a problem", exact: true }).click();
    await page.getByRole("button", { name: "Retry report", exact: true }).waitFor();
    assert.equal(await page.locator("#report-description").inputValue(), description);
    await page.getByRole("button", { name: "Retry report", exact: true }).click();
    await page.locator("#report-status").filter({ hasText: "Report received" }).waitFor();
    assert.deepEqual(manual[1], manual[0], "recovery retries the persisted request rather than creating another report");
    assert.ok(automatic.some(report => report.events.some(event => event.operation === "auth.restore" && event.outcome === "failure" && event.status === 503)),
      "the recovered account receives the sanitized startup failure diagnostic");
    await page.getByRole("button", { name: "Library", exact: true }).click();
    if (recovery === "report") await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.evaluate(() => { window.failImport = true; });
    await page.getByLabel("Select Camera first for import").check();
    await page.getByRole("button", { name: "Download and import selected", exact: true }).click();
    await page.locator("#message").filter({ hasText: "0 of 1 imported" }).waitFor();
    assert.ok(automatic.some(report => report.events.some(event => event.operation === "media.import" && event.outcome === "failure")),
      "diagnostics resume after session recovery");
    assert.deepEqual(errors, []);
  });
}

for (const boundary of ["credential write", "journal read"]) {
  test(`sign-out during a held ${boundary} keeps the account private and preserves the current form`, async t => {
    let unavailable = false;
    const { page, errors } = await openPanel(t, async (operation, _payload, route) => {
      const headers = { "access-control-allow-origin": "*" };
      if (route.request().url().endsWith("/cmsRevokePremiereSession")) {
        await route.fulfill({ headers, json: { success: true } });
        return true;
      }
      if (operation === "session" && unavailable || operation === "cmsSubmitPremiereReport") {
        await route.fulfill({ status: 503, headers, json: { error: "Temporarily unavailable" } });
        return true;
      }
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Report a problem", exact: true }).click();
    await page.locator("#report-description").fill("The selected video would not import.");
    await page.getByRole("button", { name: "Send report", exact: true }).click();
    await page.getByRole("button", { name: "Retry report", exact: true }).waitFor();
    unavailable = true;
    await page.reload();
    await page.locator("#message").filter({ hasText: "Temporarily unavailable" }).waitFor();
    unavailable = false;
    await page.evaluate(boundary => {
      window.holdSessionSave = boundary === "credential write";
      window.holdJournalRead = boundary === "journal read";
    }, boundary);
    await page.getByRole("textbox", { name: "Find by name" }).fill("Camera second");
    await page.waitForFunction(() => window.finishSessionSave || window.finishJournalRead || document.getElementById("library-status").textContent === "1 video loaded");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.locator("#message").filter({ hasText: "Signed out of Boardwalk" }).waitFor();
    const draft = "A new report written after signing out.";
    if (boundary === "journal read") {
      await page.getByRole("button", { name: "Report a problem", exact: true }).click();
      await page.locator("#report-description").fill(draft);
    }
    await page.evaluate(async () => {
      window.finishSessionSave?.(); window.finishJournalRead?.();
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    await page.waitForFunction(() => !document.getElementById("library-loading").hasAttribute("data-active"));
    assert.equal(await page.locator("#account-name").textContent(), "Not connected.");
    assert.equal(await page.locator("#report-description").inputValue(), boundary === "journal read" ? draft : "");
    assert.equal(await page.locator("#report-form").isVisible(), boundary === "journal read");
    assert.deepEqual(errors, []);
  });
}

test("a credential deletion failure cannot leave the revoked account's report visible", async t => {
  const { page, errors } = await openPanel(t, async (operation, _payload, route) => {
    const headers = { "access-control-allow-origin": "*" };
    if (operation === "cmsSubmitPremiereReport") {
      await route.fulfill({ headers, status: 503, json: { error: "Reports unavailable" } });
    } else if (route.request().url().endsWith("/cmsRevokePremiereSession")) {
      await route.fulfill({ headers, json: { success: true } });
    } else return;
    return true;
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem", exact: true }).click();
  await page.locator("#report-description").fill("The selected video would not import.");
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.getByRole("button", { name: "Retry report", exact: true }).waitFor();
  await page.evaluate(() => { window.failForget = true; });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator("#message").filter({ hasText: "Could not remove the saved credential" }).waitFor();
  assert.equal(await page.locator("#account-name").textContent(), "Not connected.");
  assert.equal(await page.locator("#report-description").inputValue(), "");
  assert.equal(await page.locator("#report-form").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("revocation discards buffered startup diagnostics before the same account pairs again", async t => {
  let status = 200;
  const automatic = [];
  const manual = [];
  const { page, errors } = await openPanel(t, async (operation, payload, route) => {
    const headers = { "access-control-allow-origin": "*" };
    const endpoint = route.request().url().split("/").pop();
    if (endpoint === "cmsStartPremierePairing") {
      await route.fulfill({ headers, json: { userCode: "TEST1234", deviceCode: "test-device-code", expiresIn: 90, interval: 5 } });
    } else if (endpoint === "cmsPollPremierePairing") {
      await route.fulfill({ headers, json: { status: "approved", sessionToken: `pds_${"B".repeat(43)}`,
        user: { uid: "test-editor", displayName: "Test editor" }, expiresAt: new Date(Date.now() + 86400000).toISOString() } });
    } else if (operation === "session" && status !== 200) {
      await route.fulfill({ headers, status, json: { error: status === 503 ? "Session check unavailable" : "Session revoked" } });
    } else if (operation === "cmsSubmitPremiereReport") {
      (payload.mode === "automatic" ? automatic : manual).push(payload);
      await route.fulfill({ headers, json: payload.mode === "automatic" ? { success: true, mode: "automatic", accepted: true }
        : { success: true, mode: "manual", report: { id: "br_" + "c".repeat(32) } } });
    } else return;
    return true;
  });
  status = 503;
  await page.reload();
  await page.locator("#message").filter({ hasText: "Session check unavailable" }).waitFor();
  status = 401;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator("#connection").waitFor();
  status = 200;
  await page.clock.install();
  await page.getByRole("button", { name: "Connect Boardwalk", exact: true }).click();
  await page.locator("#pairing").waitFor();
  await page.clock.runFor(5000);
  await page.locator("#library-status").filter({ hasText: "2 videos loaded" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem", exact: true }).click();
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.locator("#report-status").filter({ hasText: "Report received" }).waitFor();
  assert.deepEqual(automatic, [], "a revoked connection cannot carry its pending alert into a later session");
  assert.equal(manual.length, 1);
  assert.equal(manual[0].events.some(event => event.operation === "auth.restore" && event.status === 503), false);
  assert.deepEqual(errors, []);
});

test("revoked startup hides a saved manual report and retains it for an authorized reconnect", async t => {
  let revoked = false;
  const { page, errors } = await openPanel(t, async (operation, _payload, route) => {
    if (operation === "session" && revoked || operation === "cmsSubmitPremiereReport") {
      await route.fulfill({ status: operation === "session" ? 401 : 503,
        json: { error: operation === "session" ? "Session revoked" : "Reports unavailable" },
        headers: { "access-control-allow-origin": "*" } });
      return true;
    }
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem", exact: true }).click();
  const description = "The selected video would not import.";
  await page.locator("#report-description").fill(description);
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.getByRole("button", { name: "Retry report", exact: true }).waitFor();
  revoked = true;
  await page.reload();
  await page.locator("#message").filter({ hasText: "Session revoked" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.locator("#report-description").inputValue(), "");
  assert.equal(await page.locator("#report-form").isVisible(), false);
  revoked = false;
  await page.reload();
  await page.locator("#library-status").filter({ hasText: "2 videos loaded" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.locator("#report-description").inputValue(), description);
  assert.equal(await page.getByRole("button", { name: "Retry report", exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
});

test("browsing, details and batch selection fetch posters only; explicit import fetches selected originals", async t => {
  let releaseOlderSearch;
  t.after(() => releaseOlderSearch?.());
  const { page, errors, originalReads, downloaded, posterReads } = await openPanel(t, async (operation, payload) => {
    if (operation === "cmsListSourceMedia" && payload.q === "Cam") {
      await new Promise(resolve => { releaseOlderSearch = resolve; });
    }
  });
  await page.getByRole("button", { name: /Camera first/ }).click();
  await page.getByRole("heading", { name: "Camera first" }).waitFor();
  assert.equal(await page.locator("#detail-poster").getAttribute("src"), "https://fixture.s3.us-east-2.amazonaws.com/posters/first.png");
  assert.equal(await page.locator("#detail-poster").isVisible(), true);
  assert.deepEqual(originalReads, []);
  await page.getByRole("button", { name: "Back to library" }).click();
  const selectFirst = page.getByLabel("Select Camera first for import");
  await selectFirst.scrollIntoViewIfNeeded();
  const beforeSelection = await page.locator(".asset-card").first().boundingBox();
  const beforeScroll = await page.locator("#content").evaluate(element => element.scrollTop);
  await selectFirst.check();
  assert.deepEqual(await page.locator(".asset-card").first().boundingBox(), beforeSelection);
  assert.equal(await page.locator("#content").evaluate(element => element.scrollTop), beforeScroll);
  await page.getByRole("button", { name: "Load more" }).click();
  await page.getByLabel("Select Camera third for import").check();
  await page.locator("#selection-count").filter({ hasText: "2 videos selected" }).waitFor();
  assert.deepEqual(originalReads, []);
  assert.deepEqual(downloaded, []);
  assert.ok(posterReads.length > 0);
  await page.getByRole("button", { name: "Download and import selected", exact: true }).click();
  await page.locator("#message").filter({ hasText: "Imported 2 selected videos." }).waitFor();
  assert.deepEqual(originalReads, ["first", "third"]);
  assert.deepEqual(downloaded, ["/originals/first.mp4", "/originals/third.mp4"]);
  assert.equal(await page.evaluate(() => window.importedPaths.length), 2);
  assert.equal(await page.evaluate(() => document.activeElement.id), "tab-library");
  await page.getByRole("button", { name: /Camera second/ }).scrollIntoViewIfNeeded();
  const cardBeforeDetails = await page.getByRole("button", { name: /Camera second/ }).boundingBox();
  await page.getByRole("button", { name: /Camera second/ }).click();
  await page.getByRole("button", { name: "Back to library" }).click();
  const cardAfterDetails = await page.getByRole("button", { name: /Camera second/ }).boundingBox();
  assert.ok(Math.abs(cardAfterDetails.y - cardBeforeDetails.y) <= 1, "Back preserves the card position within fractional scroll rounding");
  const restoredScroll = await page.locator("#content").evaluate(element => element.scrollTop);
  assert.equal(await page.evaluate(() => document.activeElement.className), "asset");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Camera second" }).waitFor();
  await page.getByRole("button", { name: "Back to library" }).click();
  assert.equal(await page.locator("#content").evaluate(element => element.scrollTop), restoredScroll);
  assert.equal(await page.getByRole("button", { name: "Download and import selected", exact: true }).isDisabled(), true);
  assert.equal(await page.locator("#import-selected").getAttribute("tabindex"), "-1");
  const messageBeforeDisabledClick = await page.locator("#message").textContent();
  await page.locator("#import-selected").evaluate(element => element.click());
  assert.equal(await page.locator("#message").textContent(), messageBeforeDisabledClick);
  assert.equal(originalReads.length, 2);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "tab-settings");
  await page.locator("#tab-return").focus();
  await page.keyboard.down("Space");
  assert.equal(await page.locator("#view-settings").isVisible(), true);
  await page.keyboard.up("Space");
  await page.getByRole("heading", { name: "Return a finished video" }).waitFor();
  await page.locator("#tab-library").focus();
  await page.keyboard.down("Space");
  await page.locator("#tab-settings").focus();
  await page.keyboard.up("Space");
  assert.equal(await page.locator("#view-return").isVisible(), true, "moving focus cancels Space activation");
  await page.locator("#tab-library").focus();
  // Premiere can consume Space for playback and deliver only its keyup.
  await page.locator("#tab-library").dispatchEvent("keyup", { key: " ", code: "Space" });
  assert.equal(await page.locator("#view-return").isVisible(), true, "host playback must not also activate a panel action");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Find by name" });
  const olderRequest = page.waitForRequest(request => request.url().endsWith("/cmsPremiereRequest") && request.postDataJSON().payload.q === "Cam", { timeout: 3000 });
  await search.fill("Cam");
  await olderRequest;
  assert.equal(await search.isEnabled(), true, "search stays editable while its request is pending");
  assert.equal(await page.locator("#library-loading").isVisible(), true);
  const firstFrame = await page.locator("#library-loading > span").first().evaluate(dot => dot.style.opacity);
  await page.waitForFunction(previous => document.querySelector("#library-loading > span").style.opacity !== previous, firstFrame);
  await search.fill("Camera second");
  await page.locator("#library-status").filter({ hasText: /^1 video loaded$/ }).waitFor();
  assert.deepEqual(await page.locator(".asset strong").allTextContents(), ["Camera second"]);
  assert.equal(await page.evaluate(() => document.activeElement.id), "search");
  assert.equal(await page.locator("#library-loading").isVisible(), false, "a superseded request does not keep the indicator running");
  const olderResponse = page.waitForResponse(response => response.request().postDataJSON()?.payload?.q === "Cam");
  releaseOlderSearch();
  await olderResponse;
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await page.locator(".asset strong").allTextContents(), ["Camera second"], "a late response cannot replace a newer search");
  await search.fill("");
  await page.locator("#library-status").filter({ hasText: "2 videos loaded" }).waitFor();
  assert.deepEqual(await page.locator(".asset strong").allTextContents(), ["Camera first", "Camera second"]);
  assert.equal(originalReads.length, 2, "live search does not read video bytes");
  assert.deepEqual(errors, []);
});

test("a native import failure sends safe diagnostics and a manual retry keeps the same report", async t => {
  const automatic = [];
  const manual = [];
  const { page, errors } = await openPanel(t, async (operation, payload, route) => {
    if (operation !== "cmsSubmitPremiereReport") return;
    const headers = { "access-control-allow-origin": "*" };
    if (payload.mode === "automatic") {
      automatic.push(payload);
      await route.fulfill({ headers, json: { success: true, mode: "automatic", accepted: true, deduplicated: false, repeatCount: 1 } });
    } else {
      manual.push(payload);
      await route.fulfill({ headers, status: manual.length === 1 ? 503 : 200,
        json: manual.length === 1 ? { error: "Reporting is unavailable. Retry the same report." }
          : { success: true, mode: "manual", idempotent: true, report: { id: "br_" + "a".repeat(32) } } });
    }
    return true;
  });
  await page.evaluate(() => { window.failImport = true; });
  await page.getByLabel("Select Camera first for import").check();
  await page.getByRole("button", { name: "Download and import selected", exact: true }).click();
  await page.locator("#message").filter({ hasText: "0 of 1 imported" }).waitFor();
  assert.equal(await page.locator("#transfer-loading").isVisible(), false);
  await page.setViewportSize({ width: 320, height: 400 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Report a problem", exact: true }).click();
  const descriptionBounds = await page.locator("#report-description").boundingBox();
  const contentBounds = await page.locator("#content").boundingBox();
  assert.equal(await page.evaluate(() => document.activeElement.id), "report-description");
  assert.ok(descriptionBounds.y >= contentBounds.y && descriptionBounds.y + descriptionBounds.height <= contentBounds.y + contentBounds.height,
    "opening the report in a short dock reveals the focused description");
  await page.getByLabel("What happened?", { exact: false }).fill("The selected video would not import.");
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await page.locator("#report-status").filter({ hasText: "Reporting is unavailable" }).waitFor();
  assert.equal(await page.locator("#report-loading").isVisible(), false);
  assert.equal(await page.locator("#report-description").inputValue(), "The selected video would not import.");
  assert.equal(await page.locator("#report-description").evaluate(element => element.readOnly), true);
  await page.getByRole("button", { name: "Retry report", exact: true }).click();
  await page.locator("#report-status").filter({ hasText: "Report received" }).waitFor();
  assert.equal(automatic.length, 1, "nested catches and reporting failures do not duplicate the alert");
  assert.equal(automatic[0].events.at(-1).operation, "media.import");
  assert.doesNotMatch(JSON.stringify(automatic), /Confidential|private|pds_|s3\.|Camera|filename|Authorization/);
  assert.equal(manual.length, 2);
  assert.deepEqual(manual[1], manual[0]);
  assert.equal(await page.locator("#report-description").inputValue(), "");
  assert.deepEqual(errors, []);
});

for (const searchStarted of [true, false]) {
  test(`live search ${searchStarted ? "response waits for" : "debounce resumes after"} a batch import without losing its result`, { timeout: 20000 }, async t => {
    let releaseSearch;
    let releaseImport;
    let searchEntered;
    let importEntered;
    const searchPending = new Promise(resolve => { searchEntered = resolve; });
    const importPending = new Promise(resolve => { importEntered = resolve; });
    t.after(() => { releaseSearch?.(); releaseImport?.(); });
    const { page, errors, originalReads, downloaded } = await openPanel(t, async (operation, payload) => {
      if (searchStarted && operation === "cmsListSourceMedia" && payload.q === "Camera second" && !releaseSearch) {
        await new Promise(resolve => { releaseSearch = resolve; searchEntered(); });
      }
      if (operation === "cmsCreateSourceMediaRead" && !releaseImport) {
        await new Promise(resolve => { releaseImport = resolve; importEntered(); });
      }
    });
    await page.getByLabel("Select Camera first for import").check();
    await page.getByLabel("Select Camera second for import").check();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.getByRole("textbox", { name: "Find by name" }).fill("Camera second");
    if (searchStarted) {
      await page.clock.runFor(250);
      await searchPending;
    }
    await page.getByRole("button", { name: "Download and import selected", exact: true }).click();
    await importPending;
    assert.equal(await page.locator("#transfer-loading").isVisible(), true);
    if (searchStarted) {
      const response = page.waitForResponse(result => result.url().endsWith("/cmsPremiereRequest") && result.request().postDataJSON().payload.q === "Camera second");
      releaseSearch();
      await (await response).finished();
    } else {
      await page.clock.runFor(250);
    }
    assert.deepEqual(await page.locator(".asset strong").allTextContents(), ["Camera first", "Camera second"], "search must not replace the batch while its import is pending");
    assert.equal(await page.locator("#selection-count").textContent(), "2 videos selected");
    assert.equal(await page.getByLabel("Select Camera first for import").isChecked(), true);
    assert.equal(await page.getByLabel("Select Camera first for import").isDisabled(), true);
    assert.equal(await page.locator(".asset").first().getAttribute("aria-disabled"), "true");
    releaseImport();
    await page.locator("#library-status").filter({ hasText: /^1 video loaded$/ }).waitFor({ timeout: 5000 });
    assert.deepEqual(await page.locator(".asset strong").allTextContents(), ["Camera second"], "the pending query must resume after import without another input event");
    assert.equal(await page.locator("#message").textContent(), "Imported 2 selected videos.");
    assert.equal(await page.locator("#message").isVisible(), true, "automatic filtering must preserve the import result");
    assert.equal(await page.locator("#transfer-loading").isVisible(), false);
    assert.deepEqual(originalReads, ["first", "second"]);
    assert.deepEqual(downloaded, ["/originals/first.mp4", "/originals/second.mp4"]);
    assert.equal(await page.evaluate(() => window.importedPaths.length), 2);
    assert.deepEqual(errors, []);
  });
}

test("omitted page posters recover with bounded image-only requests and remain visible in details", async t => {
  const ids = ["third", "fourth", "fifth", "sixth", "seventh", "eighth"];
  let pending = 0;
  let peak = 0;
  const requested = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page, errors, originalReads, downloaded } = await openPanel(t, async (operation, payload, route) => {
    if (operation === "cmsListSourceMedia" && payload.cursor) {
      await route.fulfill({ json: { records: ids.map(id => ({ id, name: `Camera ${id}`, originalName: `${id}.mp4`,
        sizeBytes: 4, viewingCopy: { state: "ready", durationSeconds: 90 } })), posters: [], hasMore: false },
        headers: { "access-control-allow-origin": "*" } });
      return true;
    }
    if (operation === "cmsCreateSourceMediaRead" && payload.action === "poster") {
      requested.push(payload.assetId); pending++; peak = Math.max(peak, pending);
      await gate;
      await route.fulfill({ json: { access: { url: `https://fixture.s3.us-east-2.amazonaws.com/posters/${payload.assetId}.png` } },
        headers: { "access-control-allow-origin": "*" } });
      pending--;
      return true;
    }
  });
  await page.getByRole("button", { name: "Load more" }).click();
  await page.locator("#library-status").filter({ hasText: "8 videos loaded" }).waitFor();
  await page.getByRole("button", { name: /Camera third/ }).click();
  release();
  await page.waitForFunction(() => {
    const image = document.getElementById("detail-poster");
    return !image.hidden && image.complete && image.naturalWidth > 0;
  });
  assert.equal(await page.locator("#detail-poster").getAttribute("src"), "https://fixture.s3.us-east-2.amazonaws.com/posters/third.png");
  await page.getByRole("button", { name: "Back to library" }).click();
  await page.getByRole("button", { name: /Camera eighth/ }).scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const image = document.querySelector('img[data-asset-id="eighth"]');
    return !image.hidden && image.complete && image.naturalWidth > 0;
  });
  assert.deepEqual(requested.sort(), ids.sort());
  assert.ok(peak <= 3, "poster recovery has at most three requests in flight");
  assert.deepEqual(originalReads, []);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(errors, []);
});

test("a thumbnail read failure reports a library problem without claiming a video download", async t => {
  let receiveReport;
  const received = new Promise(resolve => { receiveReport = resolve; });
  const { page, errors, originalReads, downloaded } = await openPanel(t, async (operation, payload, route) => {
    if (operation === "cmsListSourceMedia") {
      await route.fulfill({ json: { records: ["first", "second"].map(id => ({ id, name: `Camera ${id}`,
        originalName: `${id}.mp4`, sizeBytes: 4, viewingCopy: { state: "ready", durationSeconds: 90 } })),
        posters: [], hasMore: false }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
    if (operation === "cmsCreateSourceMediaRead" && payload.action === "poster") {
      await route.fulfill(payload.assetId === "first"
        ? { status: 503, json: { error: "Thumbnail unavailable" }, headers: { "access-control-allow-origin": "*" } }
        : { json: { access: { url: "https://fixture.s3.us-east-2.amazonaws.com/posters/second.png" } }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
    if (operation === "cmsSubmitPremiereReport") {
      receiveReport(payload);
      await route.fulfill({ json: { success: true, mode: "automatic", accepted: true }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
  });
  const report = await received;
  assert.equal(report.mode, "automatic");
  assert.ok(report.events.some(event => event.operation === "library.list" && event.outcome === "failure" && event.status === 503));
  assert.equal(report.events.some(event => event.operation === "media.download"), false);
  await page.waitForFunction(() => {
    const image = document.querySelector('img[data-asset-id="second"]');
    return !image.hidden && image.complete && image.naturalWidth > 0;
  });
  assert.deepEqual(originalReads, []);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(errors, []);
});

test("source linking stays atomic on a marker read failure and permits WebLink sources without markers", async t => {
  const uploads = [];
  const { page, errors } = await openPanel(t, async (operation, payload, route) => {
    if (operation === "cmsStartSourceMediaUpload") {
      uploads.push(payload);
      await route.fulfill({ json: { asset: { name: `result ${uploads.length}` } }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
    if (operation === "cmsSubmitPremiereReport") {
      await route.fulfill({ json: { success: true, accepted: true }, headers: { "access-control-allow-origin": "*" } });
      return true;
    }
  });
  await page.getByLabel("Select Camera first for import").check();
  await page.getByLabel("Select Camera second for import").check();
  await page.locator("#import-selected").click();
  await page.locator("#message").filter({ hasText: "Imported 2 selected videos." }).waitFor();
  await page.locator("#tab-return").click();
  await page.locator("#choose-return").click();
  const marker = { startMs: 1000, endMs: 2000, name: "Clip A", comment: "Keep", type: "Chapter", color: 3 };
  await page.evaluate(value => { window.selectedClipPath = window.importedPaths[0]; window.fixtureMarkers = [value]; }, marker);
  await page.locator("#link-source").click();
  await page.locator("#return-source").filter({ hasText: "first / full source" }).waitFor();
  await page.locator("#return-markers").check();
  await page.evaluate(() => { window.selectedClipPath = window.importedPaths[1]; window.failMarkerRead = true; });
  await page.locator("#link-source").click();
  await page.locator("#message").filter({ hasText: "Native marker read failed" }).waitFor();
  assert.equal(await page.locator("#return-source").textContent(), "first / full source");
  await page.locator("#upload").click();
  await page.locator("#message").filter({ hasText: "Uploaded result 1." }).waitFor();
  assert.deepEqual(uploads[0].parentSource, { sourceId: "video-library", assetId: "first" });
  assert.deepEqual(uploads[0].metadata.markers, [marker]);
  await page.evaluate(() => { window.failMarkerRead = false; window.fixtureMarkers = [{ type: "WebLink" }]; });
  await page.locator("#link-source").click();
  await page.locator("#return-source").filter({ hasText: "second / full source / This clip has WebLink markers. Marker inclusion is unavailable." }).waitFor();
  assert.equal(await page.locator("#return-markers").isDisabled(), true);
  assert.equal(await page.locator("#return-markers").isChecked(), false);
  await page.locator("#upload").click();
  await page.locator("#message").filter({ hasText: "Uploaded result 2." }).waitFor();
  assert.deepEqual(uploads[1].parentSource, { sourceId: "video-library", assetId: "second" });
  assert.deepEqual(uploads[1].metadata.markers, []);
  assert.equal(await page.locator("#return-markers").isDisabled(), true);
  await page.evaluate(value => { window.selectedClipPath = window.importedPaths[0]; window.fixtureMarkers = [value]; }, marker);
  await page.locator("#link-source").click();
  await page.locator("#return-source").filter({ hasText: "first / full source" }).waitFor();
  assert.equal(await page.locator("#return-markers").isEnabled(), true);
  assert.equal(await page.locator("#return-markers").isChecked(), false);
  await page.locator("#return-markers").check();
  await page.locator("#clear-source").click();
  await page.locator("#return-source").filter({ hasText: "No source linked." }).waitFor();
  assert.equal(await page.locator("#return-markers").isChecked(), false);
  await page.locator("#upload").click();
  await page.locator("#message").filter({ hasText: "Uploaded result 3." }).waitFor();
  assert.equal(uploads[2].parentSource, undefined);
  assert.deepEqual(uploads[2].metadata.markers, []);
  assert.deepEqual(errors, []);
});
