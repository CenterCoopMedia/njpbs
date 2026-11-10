import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = readFileSync(new URL("../workflows/cms-staging-deploy.yml", import.meta.url), "utf8");
const block = source.split("      - name: Verify the report relay\n")[1].split("\n      - ")[0];
const step = { run: block.split("        run: |\n")[1].replace(/^          /gm, "") };
const expected = { id: 1234567890, username: "example_report_bot" };

function verify(options = {}) {
  const preload = `
    const calls = [];
    const options = ${JSON.stringify(options)};
    globalThis.fetch = async (input) => {
      const method = new URL(input).pathname.split('/').at(-1);
      calls.push(method);
      const responses = {
        getMe: { id: options.wrongIdentity ? 1234567891 : ${expected.id}, username: '${expected.username}' },
        getWebhookInfo: { url: options.webhook ? 'https://hooks.example.org/' : '' },
        getChat: { id: 42, type: options.publicChat ? 'group' : 'private' },
      };
      if (!Object.hasOwn(responses, method)) throw new Error('Unexpected relay method');
      return Response.json({ ok: true, result: responses[method] });
    };
    process.on('exit', () => process.stdout.write(JSON.stringify(calls)));
  `;
  return spawnSync("bash", ["-c", step.run], {
    encoding: "utf8", timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
      CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN: "1234567890:" + "a".repeat(35),
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "42",
      CMS_BUG_REPORT_TELEGRAM_BOT_ID: options.missingIdentity ? "" : String(expected.id),
      CMS_BUG_REPORT_TELEGRAM_BOT_USERNAME: expected.username,
    },
  });
}

test("report relay verifies configured identity, polling, and private recipient without sending", () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["getMe", "getWebhookInfo", "getChat"]);
});

for (const [name, options, methods] of [
  ["missing configured identity", { missingIdentity: true }, []],
  ["wrong bot identity", { wrongIdentity: true }, ["getMe"]],
  ["active webhook", { webhook: true }, ["getMe", "getWebhookInfo"]],
  ["public recipient", { publicChat: true }, ["getMe", "getWebhookInfo", "getChat"]],
]) {
  test(`report relay refuses ${name}`, () => {
    const result = verify(options);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), methods);
  });
}
