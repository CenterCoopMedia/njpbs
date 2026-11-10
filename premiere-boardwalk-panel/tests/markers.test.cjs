"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const { validateMarkers, toClipMarkers, mergeClipMarkers } = require("../markers.js");
const marker = (startMs, endMs = startMs) => ({ startMs, endMs, name: "Interview", comment: "Keep this answer", type: "Comment", color: 3 });

test("range round-tripping preserves markers outside and crossing either boundary", () => {
  const source = { inMs: 10000, outMs: 20000 };
  const existing = [marker(0), marker(9000, 11000), marker(10000), marker(18000, 21000), marker(20000)];
  assert.deepEqual(toClipMarkers(existing, source), [marker(0)]);
  assert.deepEqual(mergeClipMarkers(existing, [marker(2000, 3000)], source),
    [marker(0), marker(9000, 11000), marker(12000, 13000), marker(18000, 21000), marker(20000)]);
  assert.throws(() => mergeClipMarkers(existing, [marker(9000, 11000)], source), /beyond/);
});

test("full source round-trip keeps source-relative time and supports clearing all markers", () => {
  const existing = [marker(0), marker(12345, 15000)];
  assert.deepEqual(toClipMarkers(existing, {}), existing);
  assert.deepEqual(mergeClipMarkers(existing, existing, {}), existing);
  assert.deepEqual(mergeClipMarkers(existing, [], {}), []);
});

test("marker bounds reject invalid time, unsupported host marker types and excessive UTF-8", () => {
  for (const value of [{ ...marker(0), startMs: -1 }, marker(5, 4), { ...marker(0), type: "Cart" },
    { ...marker(0), color: 8 }, { ...marker(0), name: "x".repeat(201) }, { ...marker(0), comment: "x".repeat(1001) }]) {
    assert.throws(() => validateMarkers([value]));
  }
  assert.throws(() => validateMarkers(Array.from({ length: 101 }, () => marker(0))), /100 markers/);
  assert.throws(() => validateMarkers(Array.from({ length: 30 }, () => ({ ...marker(0), comment: "\u4e00".repeat(1000) }))), /64 KiB/);
});

test("WebLink markers cannot be saved or replace a native clip's link metadata", async () => {
  // Adobe exposes getUrl/getTarget but no corresponding restore actions.
  // https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/marker
  const webLink = { ...marker(0), type: "WebLink" };
  assert.throws(() => validateMarkers([webLink]), /WebLink/);
  for (const type of ["Comment", "Chapter", "Segmentation"]) {
    assert.deepEqual(validateMarkers([{ ...marker(0), type }]), [{ ...marker(0), type }]);
  }
  const nativeLink = { getType: () => "WebLink", getUrl: () => "https://example.test/story", getTarget: () => "_blank" };
  let existing = [nativeLink];
  let nativeWrites = 0;
  const project = {
    lockedAccess: callback => callback(),
    executeTransaction() { nativeWrites++; throw new Error("Unexpected native write"); },
  };
  const adobe = { Markers: { getMarkers: async () => ({ getMarkers: () => existing }) } };
  const filename = require.resolve("../host.js");
  const nativeRequire = createRequire(filename);
  const hostModule = { exports: {} };
  vm.runInNewContext(readFileSync(filename, "utf8"), {
    module: hostModule,
    require: name => name === "premierepro" ? adobe : name === "uxp" ? { storage: { localFileSystem: {} } } : nativeRequire(name),
  }, { filename });
  const selection = { project, clip: {} };
  await assert.rejects(hostModule.exports.readMarkers(selection), /WebLink/);
  await assert.rejects(hostModule.exports.replaceMarkers(selection, [marker(0)]), /WebLink/);
  await assert.rejects(hostModule.exports.replaceMarkers(selection, []), /WebLink/);
  assert.equal(existing[0].getUrl(), "https://example.test/story");
  assert.equal(existing[0].getTarget(), "_blank");
  existing = [];
  await assert.rejects(hostModule.exports.replaceMarkers(selection, [webLink]), /WebLink/);
  assert.equal(nativeWrites, 0);
});
