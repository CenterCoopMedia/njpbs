import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const launcher = fileURLToPath(new URL("./cms-debug-browser.sh", import.meta.url));

test("browser launcher keeps MCP input separate from the configured credential pipe", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-launcher-"));
  try {
    writeFileSync(join(directory, "pass"), `#!/usr/bin/python3
import sys
assert sys.argv[1:] == ['show', '--', 'example/service/credential']
assert sys.stdin.read() == ''
print('fixture-credential')
`, { mode: 0o700 });
    writeFileSync(join(directory, "node"), `#!/usr/bin/python3
import json, os, sys
credential = os.read(3, 4096).decode().strip()
rpc = sys.stdin.read()
print(json.dumps({'separate': credential == 'fixture-credential', 'rpc': rpc == 'rpc-control'}))
`, { mode: 0o700 });
    const result = spawnSync("bash", [launcher], {
      encoding: "utf8", input: "rpc-control", timeout: 5_000,
      env: { PATH: `${directory}:/usr/bin:/bin`, CMS_DEBUG_BROWSER_CREDENTIAL_REF: "example/service/credential" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { separate: true, rpc: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("browser launcher refuses an absent credential reference before starting a process", () => {
  const result = spawnSync("bash", [launcher], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Configure CMS_DEBUG_BROWSER_CREDENTIAL_REF/);
});
