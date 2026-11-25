import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const run = promisify(execFile);
let bin;
beforeEach(() => { bin = mkdtempSync(join(tmpdir(), "wait-status-")); });
afterEach(() => rmSync(bin, { recursive: true }));
// Answers each status in turn and repeats the last.
function curl(...statuses) {
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nn=$(cat "${bin}/n" 2>/dev/null || echo 0)\necho $((n+1)) > "${bin}/n"\nset -- ${statuses.join(" ")}\n[ "$n" -ge $# ] && n=$(($#-1))\nshift "$n"\nprintf %s "$1"\n`);
  chmodSync(join(bin, "curl"), 0o755);
}
const until = expected => run(process.execPath, ["scripts/release-wait-status.mjs", "until", "gate", expected, "https://example.org/gate"],
  { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

it.each(["401", "403"])("ends when an endpoint that must answer %s answers a success", async expected => {
  curl("200");
  await expect(until(expected)).rejects.toMatchObject({ stderr: expect.stringContaining(`answered HTTP 200, expected ${expected}`) });
});

it("keeps waiting through propagation to the expected refusal", async () => {
  curl("503", "403");
  await expect(until("403")).resolves.toBeTruthy();
});
