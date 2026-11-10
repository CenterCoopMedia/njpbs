"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { clearTracked, clearMessage } = require("../cache.js");

// UXP folder entries over a real temporary folder. Windows refuses to delete a
// file that Premiere holds open; Linux does not, so the boundary simulates it.
async function cache(t, names, refuse = {}) {
  const folder = await fs.mkdtemp(path.join(tmpdir(), "premiere-cache-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  for (const name of names) await fs.writeFile(path.join(folder, name), name);
  const entries = names.map(name => ({ name, isFile: true, nativePath: path.join(folder, name),
    async delete() { if (refuse[name]) throw refuse[name]; await fs.unlink(path.join(folder, name)); } }));
  return { folder, entries };
}
const key = value => value.replace(/\\/g, "/");
const busy = Object.assign(new Error("EBUSY: resource busy or locked, unlink"), { code: "EBUSY" });

test("clearing keeps files Premiere still uses, removes the rest and says which were kept", async t => {
  const names = ["a.mp4", "b.mp4", "c.mp4", "other.mov"];
  const { folder, entries } = await cache(t, names, { "a.mp4": busy, "c.mp4": new Error("resource busy or locked") });
  const mappings = Object.fromEntries(names.slice(0, 3).map(name => [key(path.join(folder, name)), { assetId: name }]));
  const saved = [];
  const result = await clearTracked({ entries, mappings, key, save: value => saved.push(JSON.stringify(value)) });

  assert.deepEqual(result, { removed: 1, kept: ["a.mp4", "c.mp4"] });
  assert.deepEqual((await fs.readdir(folder)).sort(), ["a.mp4", "c.mp4", "other.mov"]);
  assert.deepEqual(Object.keys(JSON.parse(saved.at(-1))).map(name => path.basename(name)), ["a.mp4", "c.mp4"]);
  assert.equal(clearMessage(result), "Removed 1 downloaded file. Premiere is still using 2 files, so the panel kept them: " +
    "a.mp4, c.mp4. Close the projects that use them, or restart Premiere. Then clear again. Other cache files were kept.");
});

test("other delete failures still stop the action", async t => {
  const { folder, entries } = await cache(t, ["a.mp4"], { "a.mp4": Object.assign(new Error("EACCES: permission denied, unlink locked.mp4"), { code: "EACCES" }) });
  const mappings = { [key(path.join(folder, "a.mp4"))]: {} };
  await assert.rejects(clearTracked({ entries, mappings, key, save() {} }), /permission denied/);
  assert.equal(Object.keys(mappings).length, 1);
});
