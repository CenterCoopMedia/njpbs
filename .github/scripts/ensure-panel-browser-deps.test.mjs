import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
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
  let installed = false;
  const run = (name, args) => {
    calls.push([name, args]);
    if (name !== "dpkg-query") {
      installed = true;
      return { status: 0 };
    }
    if (installed) return { status: 0, stdout: "install ok installed" };
    if (args.at(-1) === "libmissing:amd64") return { status: 1, stdout: "" };
    return { status: 0, stdout: args.at(-1) === "libpartial:amd64" ? "install reinstreq half-installed" : "install ok installed" };
  };
  assert.deepEqual(ensureRuntimeDependencies(["libready", "libmissing", "libpartial"], run, () => {}), ["libmissing", "libpartial"]);
  assert.deepEqual(calls.filter(([name]) => name !== "dpkg-query"), [
    [process.execPath, [fileURLToPath(new URL("./install-hosted-deps.mjs", import.meta.url)), "chromium",
      join(homedir(), ".cache/njpbs-ci-debs/chromium-1.65.0")]],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === "dpkg-query").map(([, args]) => args.at(-1)), [
    "libready:amd64", "libmissing:amd64", "libpartial:amd64", "libmissing:amd64", "libpartial:amd64",
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

describe("runtime verification after seed installation", () => {
  test("a successful installer must report the names that remain missing", () => {
    const calls = [];
    let installed = false;
    const run = (command, args) => {
      calls.push([command, args]);
      if (command !== "dpkg-query") {
        installed = true;
        return { status: 0 };
      }
      return installed && args.at(-1) === "librecovered:amd64"
        ? { status: 0, stdout: "install ok installed" }
        : { status: 1, stdout: "" };
    };
    assert.throws(() => ensureRuntimeDependencies(["libmissing-a", "librecovered", "libmissing-b"], run, () => {}), {
      message: "Chromium runtime dependencies are still missing after installation: libmissing-a, libmissing-b",
    });
    assert.equal(calls.filter(([command]) => command !== "dpkg-query").length, 1);
    assert.deepEqual(calls.slice(-3).map(([, args]) => args.at(-1)), [
      "libmissing-a:amd64", "librecovered:amd64", "libmissing-b:amd64",
    ]);
  });

  test("a failed post-install query names the package and does not retry installation", () => {
    const calls = [];
    let installed = false;
    const run = (command, args) => {
      calls.push([command, args]);
      if (command !== "dpkg-query") {
        installed = true;
        return { status: 0 };
      }
      return installed ? { status: 2, stdout: "" } : { status: 1, stdout: "" };
    };
    assert.throws(() => ensureRuntimeDependencies(["libmissing"], run, () => {}), {
      message: "Cannot inspect dependency libmissing",
    });
    assert.equal(calls.filter(([command]) => command !== "dpkg-query").length, 1);
    assert.equal(calls.length, 3);
  });
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
  return {
    name,
    seed: {
      packagePlanSha256: createHash("sha256").update(readFileSync(new URL("./playwright-chromium-packages.txt", import.meta.url))).digest("hex"),
      manifestSha256: createHash("sha256").update(readFileSync(join(directory, "sha256.json"))).digest("hex"),
    },
  };
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

test("a valid Chromium cache uses dpkg without apt or download", async (t) => {
  const directory = cacheFixture(t);
  const { name, seed } = cachedDeb(directory);
  const calls = [];
  await installChromiumDependencies(directory, (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  }, () => assert.fail("download started"), seed);
  assert.deepEqual(calls, [["sudo", ["env", "DEBIAN_FRONTEND=noninteractive", "dpkg", "-i", "--refuse-downgrade",
    "--force-confdef", "--force-confold", join(directory, name)]]]);
});

test("a tampered Chromium cache never starts a privileged command", async (t) => {
  const directory = cacheFixture(t);
  const { name, seed } = cachedDeb(directory);
  writeFileSync(join(directory, name), "tampered");
  await assert.rejects(installChromiumDependencies(directory, () => assert.fail("process started"),
    () => assert.fail("download started"), seed), /checksum mismatch/);
  cachedDeb(directory);
  writeFileSync(join(directory, "sha256.json"), "{}");
  await assert.rejects(installChromiumDependencies(directory, () => assert.fail("process started"),
    () => assert.fail("download started"), seed), /manifest checksum mismatch/);
});

test("a Chromium cache miss verifies the GitHub seed before dpkg without apt", async (t) => {
  const source = cacheFixture(t);
  const { name, seed } = cachedDeb(source);
  const archive = spawnSync("tar", ["-czf", "-", "-C", source, "sha256.json", name]);
  assert.equal(archive.status, 0, archive.stderr.toString());
  Object.assign(seed, {
    downloadUrl: "https://example.org/chromium-seed.tar.gz",
    size: archive.stdout.length,
    sha256: createHash("sha256").update(archive.stdout).digest("hex"),
  });
  const directory = cacheFixture(t);
  const calls = [];
  await installChromiumDependencies(directory, (command, args) => {
    calls.push([command, args]);
    if (command === "tar") return spawnSync(command, args);
    assert.equal(command, "sudo");
    assert.ok(args.includes("dpkg"));
    return { status: 0 };
  }, async (url) => {
    assert.equal(url, seed.downloadUrl);
    return { ok: true, arrayBuffer: async () => archive.stdout };
  }, seed);
  assert.deepEqual(calls.map(([command]) => command), ["tar", "sudo"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(directory, "sha256.json"), "utf8"))), [name]);
});

test("a failed or corrupt Chromium download stops before extraction or installation", async (t) => {
  const { seed } = cachedDeb(cacheFixture(t));
  Object.assign(seed, { downloadUrl: "https://example.org/chromium-seed.tar.gz", size: 10, sha256: "0".repeat(64) });
  for (const response of [{ ok: false, status: 503 }, { ok: true, arrayBuffer: async () => Buffer.from("corrupt") }]) {
    await assert.rejects(installChromiumDependencies(cacheFixture(t), () => assert.fail("process started"),
      async () => response, seed), /download failed|checksum mismatch/);
  }
});

test("invalid dependency plans cannot become privileged command arguments", () => {
  for (const packages of [[], ["--option"], ["libgood;command"], ["lib$(command)"], undefined]) {
    assert.throws(() => ensureRuntimeDependencies(packages, () => assert.fail("process started")));
  }
});
