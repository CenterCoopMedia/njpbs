import assert from "node:assert/strict";
import test from "node:test";
import { faultText, networkFault, repeatNetworkFault } from "./lib/network-fault.mjs";

// The end of the renderer deploy of Nov. 25, 2026, account and worker names replaced.
const push = `Image does not exist remotely, pushing: registry.cloudflare.com/example/example-dev-renderer:b03eaed5
The push refers to repository [registry.cloudflare.com/example/example-dev-renderer]
5f70bf18a086: Pushing  410.2MB/1.2GB
write tcp 192.0.2.1:41234->192.0.2.2:443: write: connection reset by peer

✘ [ERROR] Docker command exited with code: 1

🪵  Logs were written to "/home/example/.config/.wrangler/logs/wrangler.log"`;

test("a lost connection is repeated and each repeat is printed", async () => {
  const failures = [Object.assign(new Error("containers push exited 1"), { output: push }),
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
    new DOMException("The operation was aborted due to timeout", "TimeoutError"), new Error("Cloudflare HTTP 503: null"),
    new Error("failed to copy: unexpected EOF"), new Error("net/http: TLS handshake timeout")];
  const count = failures.length, lines = [];
  assert.equal(await repeatNetworkFault("push", () => { if (failures.length) throw failures.shift(); return "done"; },
    { wait: () => {}, log: line => lines.push(line) }), "done");
  assert.equal(lines.length, count);
  assert.match(lines[0], /^push: write tcp .*connection reset by peer\nRepeat 1/);
});

test("a refused credential, a build error and a wrong request end at once", async () => {
  for (const text of ["✘ [ERROR] Authentication error [code: 10000]", "Cloudflare HTTP 403: []", "unauthorized: authentication required", "denied: requested access to the resource is denied",
    "ERROR: failed to solve: process \"/bin/sh -c npm ci\" did not complete successfully: exit code: 1", "SyntaxError: Unexpected end of JSON input", "Cloudflare HTTP 400: []"]) {
    let calls = 0;
    await assert.rejects(repeatNetworkFault("deploy", () => { calls += 1; throw new Error(text); }, { wait: () => assert.fail(text), log: () => {} }));
    assert.equal(calls, 1);
  }
});

test("only the end of the output decides", () => {
  assert.equal(networkFault(`npm warn ECONNRESET\n${"compiled\n".repeat(12)}Error: build failed`), null);
  assert.match(networkFault(faultText(Object.assign(new Error("exited 1"), { output: push }))), /connection reset by peer/);
});
