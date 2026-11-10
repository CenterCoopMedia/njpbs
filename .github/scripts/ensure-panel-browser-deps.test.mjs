import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureRuntimeDependencies } from "./ensure-panel-browser-deps.mjs";

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

test("only missing or partially installed libraries are requested once", () => {
  const calls = [];
  const run = (name, args) => {
    calls.push([name, args]);
    if (name === "sudo") return { status: 0 };
    if (args.at(-1) === "libmissing:amd64") return { status: 1, stdout: "" };
    return { status: 0, stdout: args.at(-1) === "libpartial:amd64" ? "install reinstreq half-installed" : "install ok installed" };
  };
  assert.deepEqual(ensureRuntimeDependencies(["libready", "libmissing", "libpartial"], run, () => {}), ["libmissing", "libpartial"]);
  assert.deepEqual(calls.filter(([name]) => name === "sudo"), [
    ["sudo", ["apt-get", "-o", "Acquire::Retries=0", "update"]],
    ["sudo", ["apt-get", "-o", "Acquire::Retries=0", "install", "-y", "--no-install-recommends", "libmissing", "libpartial"]],
  ]);
});

test("query and update failures stop without retries or installs", () => {
  for (const failure of ["query", "update"]) {
    const calls = [];
    const run = (name, args) => {
      calls.push([name, args]);
      return name === "dpkg-query"
        ? { status: failure === "query" ? 2 : 1, stdout: "" }
        : { status: 1 };
    };
    assert.throws(() => ensureRuntimeDependencies(["libmissing"], run, () => {}));
    assert.equal(calls.filter(([name]) => name === "sudo").length, failure === "query" ? 0 : 1);
  }
});

test("invalid dependency plans cannot become privileged command arguments", () => {
  for (const packages of [[], ["--option"], ["libgood;command"], ["lib$(command)"], undefined]) {
    assert.throws(() => ensureRuntimeDependencies(packages, () => assert.fail("process started")));
  }
});
