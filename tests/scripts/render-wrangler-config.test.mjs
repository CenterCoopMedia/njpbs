import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = join(root, "scripts/render-wrangler-config.mjs");
const kv = "a".repeat(32);
const baseEnv = { PATH: dirname(process.execPath) + ":/usr/bin:/bin" };
const inputs = {
  SHADOW_POST_REVISIONS_KV_NAMESPACE_ID: kv,
  RATE_LIMIT_KV_NAMESPACE_ID: "b".repeat(32),
  CRAWL_RATE_LIMIT_NAMESPACE_ID: "123456",
  REPORT_INTAKE_URL: "https://intake.fixture.test/api/report",
};
const generated = dir => readdirSync(dir).filter(name => name.startsWith(".wrangler-rendered-"));
function render(template, env = {}, extra = []) {
  return spawnSync(process.execPath, [script, "--config", template, ...extra], {
    cwd: root, env: { ...baseEnv, ...env }, encoding: "utf8", timeout: 5000,
  });
}
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "wrangler-render-"));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("refuses missing, empty, template and malformed inputs before creating output", () => fixture(dir => {
  const template = join(dir, "worker.jsonc");
  const cases = {
    SHADOW_POST_REVISIONS_KV_NAMESPACE_ID: [undefined, "", "REPLACE_ME", "${NAMESPACE}", "0".repeat(32), "a".repeat(31), "A".repeat(32)],
    RATE_LIMIT_KV_NAMESPACE_ID: [undefined, "", "template-value", "0".repeat(32), "1"],
    CRAWL_RATE_LIMIT_NAMESPACE_ID: [undefined, "", "REPLACE_ME", "0", "-1", "1.5", "0123", kv],
    REPORT_INTAKE_URL: [undefined, "", "https://intake.example.org/api/report", "http://intake.fixture.test/api/report",
      "https://user:pass@intake.fixture.test/api/report", "https://intake.fixture.test:8443/api/report",
      "https://intake.fixture.test/api/report?canary=hidden", "https://intake.fixture.test/api/report#hidden",
      "https://intake.fixture.test/elsewhere", "https://placeholder.fixture.test/api/report"],
  };
  for (const [name, values] of Object.entries(cases)) {
    writeFileSync(template, JSON.stringify({ vars: { input: "${" + name + "}" } }));
    for (const value of values) {
      const result = render(template, value === undefined ? {} : { [name]: value });
      assert.equal(result.status, 1, `${name}: refusal`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /rendering refused/);
      assert.ok(result.stderr.includes(name), "Identify only the rejected input name");
      if (value && value.length > 4) assert.ok(!result.stderr.includes(value));
      assert.deepEqual(generated(dir), []);
    }
  }
}));

it("refuses unknown placeholders, invalid profiles, malformed config and unsupported arguments", () => fixture(dir => {
  const template = join(dir, "worker.jsonc");
  for (const source of ['{"x":"${UNRECOGNIZED_INPUT}"}', '{"x":"${broken}"}', '{"x":"REPLACE_ME"}', '{broken']) {
    writeFileSync(template, source);
    assert.equal(render(template, { UNRECOGNIZED_INPUT: "private-canary" }).status, 1);
  }
  writeFileSync(template, '{"canary":"private-config-canary",broken}');
  const malformed = render(template);
  assert.equal(malformed.status, 1);
  assert.ok(!malformed.stderr.includes("private-config-canary"));
  writeFileSync(template, '{"env":{"kv":{}}}');
  for (const argv of [["--env", "missing"], ["--env", "../kv"], ["--env"], ["--unknown", "x"], ["--config", template]]) {
    assert.equal(render(template, {}, argv).status, 1);
  }
  assert.deepEqual(generated(dir), []);
}));

it("selects only the requested JSONC profile and preserves relative paths and the template", () => fixture(dir => {
  const template = join(dir, "worker.jsonc");
  const source = `{
    // A relative entry and optional resource.
    "main": "./entry.ts", "assets": {"directory":"./client"},
    "env": {"kv":{"kv_namespaces":[{"binding":"CACHE","id":"\${SHADOW_POST_REVISIONS_KV_NAMESPACE_ID}"}]},
      "other":{"vars":{"x":"\${UNRECOGNIZED_INPUT}"}}}
  }`;
  writeFileSync(template, source);
  for (const environment of [undefined, "kv"]) {
    const result = render(template, environment ? inputs : {}, environment ? ["--env", environment] : []);
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim();
    assert.equal(dirname(output), dir);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(config.main, "./entry.ts");
    assert.equal(config.assets.directory, "./client");
    if (environment) {
      assert.deepEqual(Object.keys(config.env), ["kv"]);
      assert.equal(config.env.kv.kv_namespaces[0].id, kv);
    } else assert.equal(config.env, undefined);
    assert.equal(readFileSync(template, "utf8"), source);
    rmSync(output);
  }
  assert.equal(render(template, {}, ["--env", "kv"]).status, 1);
  assert.deepEqual(generated(dir), []);
}));

it("renders every repository template to an ignored file with the expected binding values", () => {
  for (const [name, extra] of [["workers/wrangler.shadow-posts.jsonc", []], ["workers/wrangler.shadow-posts.jsonc", ["--env", "kv"]],
    ["site/worker/wrangler.toml", []], ["crawl-worker/wrangler.jsonc", []]]) {
    const template = join(root, name), before = readFileSync(template, "utf8");
    const result = render(template, inputs, extra);
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim();
    try {
      assert.equal(dirname(output), dirname(template));
      assert.equal(statSync(output).mode & 0o777, 0o600);
      assert.equal(spawnSync("git", ["check-ignore", "--quiet", output], { cwd: root }).status, 0);
      const body = readFileSync(output, "utf8");
      assert.doesNotMatch(body, /\$\{|REPLACE_ME/);
      if (name.endsWith(".toml")) {
        assert.ok(body.includes(`id = "${inputs.RATE_LIMIT_KV_NAMESPACE_ID}"`));
        assert.ok(body.includes(`INTAKE_URL = "${inputs.REPORT_INTAKE_URL}"`));
        assert.equal(render(template, inputs, ["--env", "kv"]).status, 1);
      } else {
        const config = JSON.parse(body);
        if (name.startsWith("crawl")) assert.equal(config.ratelimits[0].namespace_id, inputs.CRAWL_RATE_LIMIT_NAMESPACE_ID);
        else if (extra.length) assert.equal(config.env.kv.kv_namespaces[0].id, kv);
        else assert.equal(config.env, undefined);
      }
      assert.equal(readFileSync(template, "utf8"), before);
    } finally { rmSync(output, { force: true }); }
  }
});

function fakeWrangler(dir) {
  const marker = join(dir, "call.json");
  writeFileSync(join(dir, "npx"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), config = args[args.indexOf('--config') + 1];
if (!args.includes('deploy') || !config || !fs.existsSync(config)) process.exit(99);
fs.writeFileSync(process.env.MARKER, JSON.stringify({ args, config, body: fs.readFileSync(config, 'utf8') }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`, { mode: 0o755 });
  return { PATH: dir + ":" + baseEnv.PATH, MARKER: marker };
}

it("runs the documented Bash deployment block with a fake CLI and cleans up on success and failure", () => fixture(dir => {
  const doc = readFileSync(join(root, "docs/config/wrangler-rendering.md"), "utf8");
  const block = doc.match(/```bash\n([\s\S]*?)```/)[1];
  const fake = fakeWrangler(dir);
  for (const status of [0, 7]) {
    const result = spawnSync("bash", ["-c", block], { cwd: root, encoding: "utf8",
      env: { ...fake, ...inputs, FAKE_EXIT: String(status) }, timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
    const call = JSON.parse(readFileSync(fake.MARKER, "utf8"));
    assert.equal(JSON.parse(call.body).ratelimits[0].namespace_id, inputs.CRAWL_RATE_LIMIT_NAMESPACE_ID);
    assert.equal(existsSync(call.config), false);
    assert.equal(result.stdout, "");
  }
  rmSync(fake.MARKER);
  const missing = spawnSync("bash", ["-c", block], { cwd: root, encoding: "utf8", env: fake, timeout: 5000 });
  assert.equal(missing.status, 1);
  assert.equal(existsSync(fake.MARKER), false, "Refuse before the deploy process");
}));

it("passes a rendered default config through the real shadow workflow command and removes it", () => fixture(dir => {
  const workflow = readFileSync(join(root, ".github/workflows/shadow-posts-dev-deploy.yml"), "utf8");
  const section = workflow.split("- name: Deploy the dev shadow Post Worker")[1].split("- name:")[0];
  const block = section.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");
  const fake = fakeWrangler(dir);
  for (const status of [0, 9]) {
    const result = spawnSync("bash", ["-c", block], { cwd: root, encoding: "utf8", timeout: 5000,
      env: { ...fake, SHADOW_POSTS_ENABLED: "false", SHADOW_POST_SLUGS: "", FAKE_EXIT: String(status) } });
    assert.equal(result.status, status, result.stderr);
    const call = JSON.parse(readFileSync(fake.MARKER, "utf8"));
    assert.equal(JSON.parse(call.body).env, undefined);
    assert.equal(existsSync(call.config), false);
    assert.deepEqual(call.args.slice(-4), ["--var", "SHADOW_POSTS_ENABLED:false", "--var", "SHADOW_POST_SLUGS:"]);
  }
}));
