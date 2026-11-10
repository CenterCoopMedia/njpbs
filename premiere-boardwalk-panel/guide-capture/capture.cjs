"use strict";
// Staff guide screenshots of the built Premiere panel.
//
// The panel is HTML, so sandboxed Chromium renders the real dist/ build. Only the
// platform boundaries are replaced, as in browser-tests/demand.test.cjs: UXP storage,
// the filesystem, Premiere, and the network. All CMS answers and file bytes come from
// the invented fixture in this folder. Other requests are refused. Chromium does not
// draw Premiere's native control chrome or host font, so these are example screens.
//
// Usage: npm --prefix premiere-boardwalk-panel run build
//        node premiere-boardwalk-panel/guide-capture/capture.cjs [output-folder]
const path = require("node:path");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const fixture = require("./fixture.cjs");

const root = path.resolve(__dirname, "../..");
const output = path.resolve(process.argv[2] || process.env.GUIDE_CAPTURE_OUTPUT || "./guide-capture-output");
const panelUrl = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
// Premiere's floating panel opens at 360 pixels wide; editors can make it taller or dock it
// wider. The library shots use a wider docked size to show the two-column layout.
const VIEWPORT = { width: 360, height: 800 };
const WIDE = { width: 640, height: 900 };
const TALL = { width: 360, height: 1060 };

// Runs in the page before the panel script. Everything here is browser-local.
function installHost(data) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(data.now); else super(...args); }
    static now() { return data.now; }
  }
  globalThis.Date = FrozenDate;

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const held = {};
  window.releaseDownload = () => held.release?.();
  window.selectedClipPath = "";
  window.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.example.org/")) {
      const endpoint = url.slice("https://api.example.org/".length);
      const body = JSON.parse(init.body || "{}");
      if (endpoint === "cmsStartPremierePairing") {
        if (data.pairing === "disabled") return json({ error: "Premiere sign-in is not enabled" }, 503);
        return json({ success: true, deviceCode: "D".repeat(43), userCode: data.userCode, expiresIn: 600, interval: 5,
          verificationUriComplete: `https://admin.njpbs.org/premiere/connect?code=${data.userCode}` });
      }
      if (endpoint === "cmsPollPremierePairing") return json({ success: true, status: "pending", interval: 5 });
      if (endpoint !== "cmsPremiereRequest") return json({ error: "No fixture" }, 404);
      const { operation, payload } = body;
      if (operation === "session") return json({ success: true, user: data.user, expiresAt: data.expiresAt, sourceId: "video-library" });
      if (operation === "cmsListSourceMedia") {
        if (payload.assetId) {
          const asset = data.assets.find(item => item.id === payload.assetId);
          return json({ success: true, records: [{ ...asset, markers: data.markers[asset.id] || [] }], hasMore: false, nextCursor: null });
        }
        const q = (payload.q || "").toLowerCase();
        const records = data.assets.filter(asset => asset.name.toLowerCase().startsWith(q));
        return json({ success: true, records, hasMore: false, nextCursor: null,
          posters: records.map(asset => ({ assetId: asset.id, url: `https://fixture.s3.us-east-2.amazonaws.com/posters/${asset.id}.jpg` })) });
      }
      if (operation === "cmsCreateSourceMediaRead") {
        return json({ success: true, access: { url: `https://fixture.s3.us-east-2.amazonaws.com/${payload.action}/${payload.assetId}` } });
      }
      return json({ error: `No fixture for ${operation}` }, 404);
    }
    if (url.startsWith("https://fixture.s3.us-east-2.amazonaws.com/download/")) {
      const asset = data.assets.find(item => url.endsWith(`/${item.id}`));
      const chunk = 1024 * 1024;
      let sent = 0;
      // Deliver part of the file, then wait so the transfer panel can be captured.
      const stream = new ReadableStream({
        async pull(controller) {
          if (sent >= asset.sizeBytes) { controller.close(); return; }
          if (sent >= asset.sizeBytes * 0.42 && !held.released) {
            await new Promise(resolve => { held.release = () => { held.released = true; resolve(); }; });
          }
          const size = Math.min(chunk, asset.sizeBytes - sent);
          sent += size;
          controller.enqueue(new Uint8Array(size));
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "video/quicktime" } });
    }
    throw new TypeError("Blocked by the guide capture fixture");
  };

  const cache = "D:/Media cache/Boardwalk";
  const folder = { nativePath: cache, name: "Boardwalk", isFolder: true, getEntries: async () => [],
    createFile: async name => ({ nativePath: `${cache}/${name}`, name }),
    getEntry: async name => ({ nativePath: `${cache}/${name}`, name }), renameEntry: async () => {} };
  const parent = { nativePath: "D:/Media cache", getEntries: async () => [folder], createFolder: async () => folder };
  const dataFolder = { getEntries: async () => [], createFile: async name => ({ name, write: async () => {} }), renameEntry: async () => {} };
  const project = { name: data.projectName, guid: "guide-project", getInsertionBin: async () => ({}), getRootItem: async () => ({}),
    importFiles: async () => true };
  const secret = data.connected ? new TextEncoder().encode(JSON.stringify({
    sessionToken: `pds_${"A".repeat(43)}`, user: data.user, expiresAt: data.expiresAt })) : null;
  window.require = name => {
    if (name === "uxp") return { host: { version: data.premiereVersion }, versions: { uxp: data.uxpVersion, plugin: "0.1.1" },
      entrypoints: { setup() {} }, shell: { openExternal: async () => {} },
      storage: {
        secureStorage: { getItem: async () => { if (!secret) throw new Error("No saved session"); return secret; },
          setItem: async () => {}, removeItem: async () => {} },
        localFileSystem: { getEntryForPersistentToken: async () => folder, getFolder: async () => parent,
          createPersistentToken: async () => "guide-cache-token", getFsUrl: entry => `file:/${entry.nativePath}`,
          getDataFolder: async () => dataFolder,
          getFileForOpening: async () => ({ name: data.returnFile, nativePath: `D:/Exports/${data.returnFile}`,
            getMetadata: async () => ({ size: 734003200, dateModified: "2026-08-20T14:30:00Z" }) }) },
      } };
    if (name === "premierepro") return { Project: { getActiveProject: async () => project },
      ProjectUtils: { getSelection: async () => ({ getItems: async () => [{
        getMediaFilePath: async () => window.selectedClipPath, isSequence: async () => false,
        isMergedClip: async () => false, isMulticamClip: async () => false }] }) },
      ClipProjectItem: { cast: clip => clip },
      Markers: { getMarkers: async () => ({ getMarkers: () => [] }) } };
    if (name === "os") return { platform: () => "win32" };
    if (name === "fs") return { open: async () => 1, write: async (_fd, _buffer, _offset, length) => ({ bytesWritten: length }), close: async () => {} };
    throw new Error(`Unexpected platform module: ${name}`);
  };
  if (data.connected) localStorage.setItem("boardwalk-cache-folder", "guide-cache-token");
}

async function webp(page, png) {
  // Chromium's own encoder, so the capture needs no image package.
  const encoded = await page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext("2d").drawImage(image, 0, 0);
    return canvas.toDataURL("image/webp", 0.88);
  }, `data:image/png;base64,${png.toString("base64")}`);
  return Buffer.from(encoded.split(",")[1], "base64");
}

async function openPanel(browser, overrides = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, reducedMotion: "reduce",
    locale: "en-US", timezoneId: "America/New_York", colorScheme: "dark" });
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:" || url.protocol === "data:") return route.continue();
    const poster = url.hostname === "fixture.s3.us-east-2.amazonaws.com" && url.pathname.match(/^\/posters\/(.+)\.jpg$/);
    if (poster) {
      const asset = fixture.assets.find(item => item.id === poster[1]);
      return route.fulfill({ contentType: "image/jpeg", body: await readFile(path.join(root, asset.poster)) });
    }
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(installHost, { ...fixture, ...overrides });
  await page.goto(panelUrl);
  await page.getByText(fixture.projectName, { exact: true }).waitFor();
  return { context, page, errors };
}

async function postersLoaded(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("#assets img.asset-poster")].every(image => !image.hidden && image.complete && image.naturalWidth > 0));
}

async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true });
  const shots = [];
  async function shot(page, file, state) {
    // Clear pointer hover and focus rings left by the fixture's own clicks.
    await page.getByRole("heading", { name: "Boardwalk", exact: true }).hover();
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => document.fonts.ready);
    const viewport = page.viewportSize();
    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    const body = await webp(page, png);
    await writeFile(path.join(output, file), body);
    shots.push({ file, state, viewport, bytes: body.length });
  }
  try {
    {
      const { context, page, errors } = await openPanel(browser, { connected: false, pairing: "disabled" });
      await page.getByRole("button", { name: "Connect Boardwalk" }).waitFor();
      await shot(page, "premiere-panel-connect.webp", "Not connected: Connect Boardwalk.");
      await page.getByRole("button", { name: "Connect Boardwalk" }).click();
      await page.getByText("Premiere sign-in is not enabled").waitFor();
      await shot(page, "premiere-panel-not-enabled.webp", "Connect Boardwalk while desktop sign-in is turned off.");
      if (errors.length) throw new Error(errors.join("\n"));
      await context.close();
    }
    {
      const { context, page, errors } = await openPanel(browser, { connected: false });
      await page.getByRole("button", { name: "Connect Boardwalk" }).click();
      if (await page.getByRole("textbox", { name: "Connection code", exact: true }).inputValue() !== fixture.userCode) throw new Error("Connection code mismatch");
      await shot(page, "premiere-panel-pairing.webp", "Selectable connection code beside Copy code, optional-hyphen hint and browser approval wait.");
      if (errors.length) throw new Error(errors.join("\n"));
      await context.close();
    }
    {
      const { context, page, errors } = await openPanel(browser, { connected: true });
      await page.setViewportSize(WIDE);
      await page.getByText(`${fixture.assets.length} videos loaded`).waitFor();
      await postersLoaded(page);
      await shot(page, "premiere-panel-library.webp", "Connected library with posters, name search and import hint.");

      for (const asset of fixture.assets.slice(1, 3)) {
        await page.getByRole("checkbox", { name: `Select ${asset.name} for import` }).check();
      }
      await page.getByText("2 videos selected").waitFor();
      await page.locator(".asset-card.selected").first().evaluate(element => element.scrollIntoView({ block: "start" }));
      await shot(page, "premiere-panel-batch.webp", "Two videos selected; batch dock with Format and Download and import selected.");
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await page.setViewportSize(TALL);

      const featured = fixture.assets[0];
      await page.getByRole("button", { name: new RegExp(`^${featured.name}`) }).click();
      await page.getByText(`${fixture.markers[featured.id].length} markers stored in Boardwalk`).waitFor();
      await page.locator("#detail-poster").and(page.locator(":visible")).waitFor();
      await page.getByLabel("Media to download").selectOption("clip");
      await page.getByLabel("In (seconds)").fill("18");
      await page.getByLabel("Out (seconds)").fill("46.5");
      await page.locator("#content").evaluate(element => { element.scrollTop = 0; });
      await shot(page, "premiere-panel-detail.webp", "Video details with Import format, Media to download set to In/out range, and range fields.");

      await page.setViewportSize(VIEWPORT);
      await page.getByRole("heading", { name: "Source markers" }).evaluate(element => element.scrollIntoView({ block: "start" }));
      await shot(page, "premiere-panel-markers.webp", "Source markers list with Apply, Read and the replace confirmation.");

      await page.getByLabel("Media to download").selectOption("source");
      await page.getByRole("button", { name: "Download and import" }).click();
      await page.locator("#transfer-status").filter({ hasText: " of " }).waitFor();
      await page.locator("#content").evaluate(element => { element.scrollTop = 0; });
      await shot(page, "premiere-panel-transfer.webp", "Full original download in progress with Stop transfer.");
      await page.evaluate(() => window.releaseDownload());
      await page.getByText(`Imported ${featured.name} into ${fixture.projectName}.`).waitFor();
      await page.locator("#content").evaluate(element => { element.scrollTop = 0; });
      await shot(page, "premiere-panel-imported.webp", "Import finished; the message names the video and the Premiere project.");

      // Link the downloaded clip as the source of a returned video.
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find(name => name.startsWith("boardwalk-sources-"));
        window.selectedClipPath = Object.keys(JSON.parse(localStorage.getItem(key)))[0];
      });
      await page.getByRole("button", { name: "Return" }).click();
      await page.getByRole("button", { name: "Choose video" }).click();
      await page.getByText(fixture.returnFile, { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Name (required)" }).fill(fixture.returnName);
      await page.getByLabel("Description").fill(fixture.returnDescription);
      await page.getByLabel("Credit").fill(fixture.returnCredit);
      await page.getByRole("textbox", { name: "Tags (comma separated)" }).fill(fixture.returnTags);
      await page.getByRole("button", { name: "Link selected Premiere clip" }).click();
      await page.getByText(`${featured.id} / full source`).waitFor();
      await page.locator("#content").evaluate(element => { element.scrollTop = 0; });
      await shot(page, "premiere-panel-return.webp", "Return tab with the exported file, required name and optional details.");
      await page.getByRole("button", { name: "Upload new asset" }).evaluate(element => element.scrollIntoView({ block: "end" }));
      await shot(page, "premiere-panel-return-source.webp", "Return tab source link, marker option, rights note and Upload new asset.");

      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByRole("button", { name: "Choose cache folder" }).click();
      await page.getByText("D:/Media cache/Boardwalk", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Report a problem" }).click();
      await page.getByLabel(/What happened/).waitFor();
      await page.locator("#content").evaluate(element => { element.scrollTop = 0; });
      await shot(page, "premiere-panel-settings.webp", "Settings with the connected account, Sign out and the open problem report form.");
      await page.getByRole("heading", { name: "Media cache" }).evaluate(element => element.scrollIntoView({ block: "start" }));
      await shot(page, "premiere-panel-cache.webp", "Settings media cache folder, clear confirmation and Premiere connection tools.");
      if (errors.length) throw new Error(errors.join("\n"));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify({ deviceScaleFactor: 2, output: path.relative(root, output), shots }, null, 2)}\n`);
}

module.exports = { openPanel, webp };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
