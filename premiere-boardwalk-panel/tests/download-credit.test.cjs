"use strict";

const { fireEvent, getQueriesForElement, waitFor } = require("@testing-library/dom");
const { JSDOM } = require("jsdom");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, resolve } = require("node:path");
const { afterEach, beforeEach, it, mock } = require("node:test");

const panel = resolve(__dirname, "..");
let dom;
let screen;
let originalGlobals;
const session = { sessionToken: `pds_${"A".repeat(43)}`, user: { uid: "fixture-editor", displayName: "Test editor" },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
const asset = (id) => ({ id, name: `Camera ${id}`, originalName: `${id}.mp4`, sizeBytes: 4,
  credit: null, viewingCopy: { durationSeconds: 90 }, version: 1, markers: [] });
let downloaded;
let imported;
let reads;
let intervals;
let creditFor;
let authorizedUntil;
let clockSkew;

beforeEach(async () => {
  dom = new JSDOM(readFileSync(resolve(panel, "index.html"), "utf8"), { url: "https://panel.example.test/" });
  originalGlobals = new Map(["window", "document", "localStorage", "navigator"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of originalGlobals.keys()) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  screen = getQueriesForElement(document.body);
  downloaded = []; imported = []; reads = []; intervals = [];
  creditFor = id => `Current credit for ${id}`;
  authorizedUntil = 0;
  clockSkew = 0;
  localStorage.clear();
  localStorage.setItem("boardwalk-cache-folder", "fixture-cache-token");
  const nativeInterval = globalThis.setInterval;
  mock.method(globalThis, "setInterval", (...args) => {
    const timer = nativeInterval(...args); intervals.push(timer); return timer;
  });
  mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://fixture.s3.us-east-2.amazonaws.com/")) {
      if (Date.now() - clockSkew >= authorizedUntil) return new Response(null, { status: 403 });
      downloaded.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    const { operation, payload } = JSON.parse(String(init?.body));
    if (operation === "session") return Response.json(session);
    if (operation === "cmsSubmitPremiereReport") return Response.json({ success: true, accepted: true });
    if (operation === "cmsListSourceMedia") return Response.json({
      records: payload.assetId ? [asset(payload.assetId)] : [asset("first"), asset("second")],
      hasMore: false, nextCursor: null, posters: ["first", "second"].map(assetId => ({ assetId,
        url: `https://fixture.s3.us-east-2.amazonaws.com/${assetId}.png` })),
    });
    if (operation === "cmsCreateSourceMediaRead" && payload.action === "download") {
      reads.push(payload.assetId);
      authorizedUntil = Date.now() - clockSkew + 300_000;
      return Response.json({ access: { credit: creditFor(payload.assetId),
        expiresAt: new Date(authorizedUntil).toISOString(),
        url: `https://fixture.s3.us-east-2.amazonaws.com/${payload.assetId}.mp4` } });
    }
    throw new Error(`Unexpected request: ${operation}`);
  });
  // Load the real panel and its modules. Substitute only UXP, Premiere, disk and HTTP.
  const entry = (name) => ({ name, nativePath: `C:/fixture-cache/${name}`, delete: async () => {} });
  const folder = { nativePath: "C:/fixture-cache", getEntries: async () => [],
    createFile: async (name) => entry(name), getEntry: async (name) => entry(name), renameEntry: async () => {} };
  const project = { name: "Fixture project", guid: "fixture-project", getInsertionBin: async () => ({}),
    importFiles: async (paths) => { imported.push(...paths); return true; } };
  const boundaries = {
    uxp: { entrypoints: { setup() {} }, storage: {
      secureStorage: { getItem: async () => new TextEncoder().encode(JSON.stringify(session)) },
      localFileSystem: { getEntryForPersistentToken: async () => folder, getFsUrl: (file) => `file:/${file.nativePath}`,
        getDataFolder: async () => ({ getEntries: async () => [] }) },
    } },
    premierepro: { Project: { getActiveProject: async () => project } },
    fs: { open: async () => 1, write: async (_fd, _buffer, _offset, length) => ({ bytesWritten: length }), close: async () => {} },
  };
  const modules = new Map();
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const require = (name) => name in boundaries ? boundaries[name]
      : name.startsWith(".") && name.endsWith(".js") ? load(resolve(dirname(filename), name)) : createRequire(filename)(name);
    new Function("require", "module", "exports", readFileSync(filename, "utf8"))(require, module, module.exports);
    return module.exports;
  }
  load(resolve(panel, "index.js"));
  await screen.findByText("2 videos loaded");
  await waitFor(() => assert.notEqual(screen.getByRole("button", { name: /Camera first/ }).getAttribute("aria-disabled"), "true"));
});
afterEach(() => {
  for (const timer of intervals) clearInterval(timer);
  dom.window.close();
  mock.restoreAll();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

it("shows current credit and downloads only after a single import is accepted", async () => {
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  assert.equal((await screen.findByText("Current credit for first")).closest("[hidden]"), null);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(imported, []);
  assert.equal(document.activeElement.textContent, "Cancel download");
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  await waitFor(() => assert.equal(imported.length, 1));
  assert.deepEqual(reads, ["first"]);
  assert.deepEqual(downloaded, ["https://fixture.s3.us-east-2.amazonaws.com/first.mp4"]);
});

it("asks for each credited batch item and stops before downloading a canceled item", async () => {
  for (const name of ["first", "second"]) fireEvent.click(screen.getByLabelText(`Select Camera ${name} for import`));
  fireEvent.click(screen.getByRole("button", { name: "Download and import selected" }));
  assert.equal((await screen.findByText("Current credit for first")).closest("[hidden]"), null);
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  assert.equal((await screen.findByText("Current credit for second")).closest("[hidden]"), null);
  assert.equal(imported.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
  await screen.findByText(/1 of 2 imported\. Stopped at Camera second/);
  assert.equal(imported.length, 1);
  assert.deepEqual(downloaded, ["https://fixture.s3.us-east-2.amazonaws.com/first.mp4"]);
  assert.deepEqual(reads, ["first", "second"]);
});

it("stops a transfer while its credit warning is open without downloading", async () => {
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  await screen.findByText("Current credit for first");
  fireEvent.click(screen.getByRole("button", { name: "Stop transfer" }));
  await waitFor(() => assert.equal(document.getElementById("transfer").hidden, true));
  assert.deepEqual(downloaded, []);
  assert.deepEqual(imported, []);
});

it("imports an uncredited original without a warning or extra authorization request", async () => {
  creditFor = () => "  ";
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  await waitFor(() => assert.equal(imported.length, 1));
  assert.equal(screen.queryByRole("group", { name: "On-screen credit required" }), null);
  assert.deepEqual(reads, ["first"]);
});

it("renews an expired link and asks again if the credit changed during confirmation", async () => {
  let now = Date.now();
  mock.method(Date, "now", () => now);
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  await screen.findByText("Current credit for first");
  now += 300_001;
  creditFor = () => "Updated pool credit";
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  await screen.findByText("Updated pool credit");
  assert.deepEqual(reads, ["first", "first"]);
  assert.deepEqual(downloaded, []);
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  await waitFor(() => assert.equal(imported.length, 1));
});

it("bounds renewal when both credit confirmations outlive their links", async () => {
  let now = Date.now();
  mock.method(Date, "now", () => now);
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  await screen.findByText("Current credit for first");
  now += 300_001;
  creditFor = () => "Updated pool credit";
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  await screen.findByText("Updated pool credit");
  now += 300_001;
  fireEvent.click(screen.getByRole("button", { name: "Continue download" }));
  await screen.findByText("The download link expired. Try again.");
  assert.deepEqual(reads, ["first", "first"]);
  assert.deepEqual(downloaded, []);
  assert.deepEqual(imported, []);
});

it("imports with a fast client clock without renewing a fresh link", async () => {
  clockSkew = 600_000;
  const now = Date.now() + clockSkew;
  mock.method(Date, "now", () => now);
  creditFor = () => null;
  fireEvent.click(screen.getByRole("button", { name: /Camera first/ }));
  fireEvent.click(screen.getByRole("button", { name: "Download and import", exact: true }));
  await waitFor(() => assert.equal(imported.length, 1));
  assert.deepEqual(reads, ["first"]);
});
