import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDependencies } from "./ensure-panel-browser-deps.mjs";
import { installBubblewrap, installChromiumDependencies } from "./install-hosted-deps.mjs";

test("ready or held runtime libraries make no APT request", () => {
  const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    return { status: 0, stdout: args.at(-1) === "libheld:amd64" ? "hold ok installed" : "install ok installed" };
  };
  assert.deepEqual(ensureRuntimeDependencies(["libready", "libheld", "libready"], run, () => {}), []);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([name]) => name === "dpkg-query"));
});

test("missing or partially installed libraries trigger one shared installation", () => {
  const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    if (name !== "dpkg-query") return { status: 0 };
    if (args.at(-1) === "libmissing:amd64") return { status: 1, stdout: "" };
    return { status: 0, stdout: args.at(-1) === "libpartial:amd64" ? "install reinstreq half-installed" : "install ok installed" };
  };
  assert.deepEqual(ensureRuntimeDependencies(["libready", "libmissing", "libpartial"], run, () => {}), ["libmissing", "libpartial"]);
  assert.deepEqual(calls.filter(([name]) => name !== "dpkg-query"), [
    [process.execPath, [fileURLToPath(new URL("./install-hosted-deps.mjs", import.meta.url)), "chromium",
      join(homedir(), ".cache/njpbs-ci-debs/chromium-1.65.0")]],
  ]);
});

test("query and shared installation failures stop the check", () => {
  for (const failure of ["query", "prepare"]) {
    const calls = [];
    const run = (name, args) => {
      calls.push([name, args]);
      return name === "dpkg-query"
        ? { status: failure === "query" ? 2 : 1, stdout: "" }
        : { status: 1 };
    };
    assert.throws(() => ensureRuntimeDependencies(["libmissing"], run, () => {}));
    assert.equal(calls.filter(([name]) => name !== "dpkg-query").length, failure === "query" ? 0 : 1);
  }
});

function cacheFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "hosted-deps-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function cachedDeb(directory) {
  const name = "example_1_amd64.deb";
  const bytes = Buffer.from("cached package");
  writeFileSync(join(directory, name), bytes);
  writeFileSync(join(directory, "sha256.json"), JSON.stringify({
    [name]: createHash("sha256").update(bytes).digest("hex"),
  }));
  return name;
}

test("an installed bubblewrap makes no download or privileged call", async (t) => {
  const calls = [];
  await installBubblewrap(cacheFixture(t), (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  }, () => assert.fail("download started"));
  assert.deepEqual(calls, [["bash", ["-c", "command -v bwrap"]]]);
});

test("a corrupt pinned bubblewrap cache is refused before installation", async (t) => {
  const directory = cacheFixture(t);
  writeFileSync(join(directory, "bubblewrap_0.9.0-1ubuntu0.3_amd64.deb"), "tampered");
  const calls = [];
  await assert.rejects(installBubblewrap(directory, (command, args) => {
    calls.push([command, args]);
    return { status: 1 };
  }, () => assert.fail("download started")), /checksum mismatch/);
  assert.ok(calls.every(([command]) => command === "bash"));
});

test("a valid Chromium cache uses dpkg without apt or download", (t) => {
  const directory = cacheFixture(t);
  const name = cachedDeb(directory);
  const calls = [];
  installChromiumDependencies(directory, (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  });
  assert.deepEqual(calls, [["sudo", ["dpkg", "-i", "--refuse-downgrade", join(directory, name)]]]);
});

test("a tampered Chromium cache never starts a privileged command", (t) => {
  const directory = cacheFixture(t);
  const name = cachedDeb(directory);
  writeFileSync(join(directory, name), "tampered");
  assert.throws(() => installChromiumDependencies(directory, () => assert.fail("process started")), /checksum mismatch/);
});

test("a Chromium cache miss retries update once and records downloaded packages", (t) => {
  const directory = cacheFixture(t);
  const calls = [];
  let updates = 0;
  installChromiumDependencies(directory, (command, args) => {
    calls.push([command, args]);
    if (args.includes("update")) return { status: ++updates === 1 ? 100 : 0 };
    if (args.includes("--download-only")) writeFileSync(join(directory, "example_1_amd64.deb"), "package");
    return { status: 0 };
  });
  assert.equal(updates, 2);
  assert.equal(calls.filter(([, args]) => args.includes("--download-only")).length, 1);
  assert.equal(calls.filter(([, args]) => args[0] === "dpkg").length, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(directory, "sha256.json"), "utf8"))), ["example_1_amd64.deb"]);
});

test("two failed metadata updates stop before downloading or installing", (t) => {
  const calls = [];
  assert.throws(() => installChromiumDependencies(cacheFixture(t), (command, args) => {
    calls.push([command, args]);
    return { status: 100 };
  }), /command failed/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, args]) => args.at(-1) === "update"));
});

test("invalid dependency plans cannot become privileged command arguments", () => {
  for (const packages of [[], ["--option"], ["libgood;command"], ["lib$(command)"], undefined]) {
    assert.throws(() => ensureRuntimeDependencies(packages, () => assert.fail("process started")));
  }
});
