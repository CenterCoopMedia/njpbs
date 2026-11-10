import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../workflows/firebase-ci.yml", import.meta.url), "utf8");
const parallelSteps = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)]
  .map((match) => match[1].replace(/^          /gm, ""))
  .filter((command) => command.includes("_pid=$!"));

// Replace only external processes. A file-event barrier proves overlap without
// depending on runner speed or creating CPU load.
const processStub = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]) + " " + args.join(" ");
const directory = process.env.PROBE_DIRECTORY;
const record = (event) => fs.appendFileSync(path.join(directory, "events"), JSON.stringify({ command, event }) + "\\n");
const first = command === process.env.FIRST_COMMAND;
const second = command === process.env.SECOND_COMMAND;
(async () => {
  record("start");
  if (first || second) {
    const own = first ? "first" : "second";
    const other = path.join(directory, first ? "second" : "first");
    fs.writeFileSync(path.join(directory, own), "started");
    await new Promise((resolve) => {
      const watcher = fs.watch(directory, () => {
        if (fs.existsSync(other)) { watcher.close(); resolve(); }
      });
      if (fs.existsSync(other)) { watcher.close(); resolve(); }
    });
  }
  record("end");
  if (args[0] === "rev-parse") console.log("a".repeat(40));
  process.exitCode = command === process.env.FAIL_COMMAND ? 23 : 0;
})();
`;

async function probe(command, first, second, fail = "") {
  const directory = mkdtempSync(join(tmpdir(), "firebase-parallel-"));
  for (const name of ["npm", "node", "git"]) {
    writeFileSync(join(directory, name), processStub, { mode: 0o700 });
  }
  const child = spawn("bash", ["-euo", "pipefail", "-c", command], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      PROBE_DIRECTORY: directory,
      FIRST_COMMAND: first,
      SECOND_COMMAND: second,
      FAIL_COMMAND: fail,
    },
  });
  let timer;
  try {
    const status = await new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        process.kill(-child.pid, "SIGKILL");
        reject(new Error("Parallel commands did not both start or finish"));
      }, 10_000);
      child.on("error", reject);
      child.on("exit", resolve);
    });
    const events = readFileSync(join(directory, "events"), "utf8").trim().split("\n").map(JSON.parse);
    return { status, events };
  } finally {
    clearTimeout(timer);
    // Also clean up a child if a regression makes the shell exit before wait.
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

const pairs = [
  {
    name: "Workspace and component installs",
    first: "npm ci --ignore-scripts",
    second: "npm ci --prefix premiere-boardwalk-panel --ignore-scripts",
    secondNext: "npm ci --prefix preview-renderer --ignore-scripts",
    secondLast: "npm ci --prefix site --ignore-scripts",
  },
  {
    name: "Renderer and publisher checks",
    first: "npm --prefix preview-renderer run check",
    firstNext: "npm run test:preview-renderer",
    firstLast: `node scripts/check-prepared-worker.mjs dev-preview-renderer ${"a".repeat(40)}`,
    second: "npm --prefix publisher run check",
    secondNext: "npm run test:cloud-publisher",
    secondLast: "node publisher/node_modules/wrangler/bin/wrangler.js deploy --config publisher/wrangler.alerts.jsonc --dry-run",
  },
  {
    name: "Functions dependency installs",
    first: "npm ci --ignore-scripts",
    second: "npm ci --prefix site --ignore-scripts",
  },
];

test("every parallel CI group starts both branches, waits, and propagates either failure", async () => {
  assert.equal(parallelSteps.length, pairs.length);
  for (const [index, { name, first, second, firstNext, secondNext, firstLast = first, secondLast = second }] of pairs.entries()) {
    for (const fail of ["", first, second]) {
      const { status, events } = await probe(parallelSteps[index], first, second, fail);
      assert.equal(status, fail ? 23 : 0, `${name}: ${fail || "success"}`);
      assert.deepEqual(new Set(events.slice(0, 2).map(({ command, event }) => `${event}: ${command}`)),
        new Set([`start: ${first}`, `start: ${second}`]), name);
      for (const command of [fail === first ? first : firstLast, fail === second ? second : secondLast]) {
        assert.ok(events.some((event) => event.command === command && event.event === "end"), `${name}: waits for ${command}`);
      }
      const next = fail === first ? firstNext : fail === second ? secondNext : undefined;
      if (next) assert.ok(!events.some((event) => event.command === next), `${name}: stops the failed branch`);
    }
  }
});
