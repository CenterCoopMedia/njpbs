import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(testDirectory, "..");
const readmePath = join(siteRoot, "snippets", "legacy-redirects", "README.md");
const libraryPath = join(siteRoot, "snippets", "legacy-redirects", "runbook-lib.sh");
const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "legacy-redirects-runbook-"));
  temporaryDirectories.push(directory);
  return directory;
}

function extractDelimitedBlock(readme: string, delimiter: "DEPLOY" | "ROLLBACK"): string {
  const match = readme.match(
    new RegExp(`bash <<'${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}(?:\\n|$)`),
  );
  if (!match) throw new Error(`Missing ${delimiter} Bash block`);
  return match[1];
}

function extractSnippetAbsenceFilter(block: string): string {
  const match = block.match(
    /jq -e --arg name "\$SNIPPET_NAME" '\n([\s\S]*?)\n' (?:\\\n  )?"\$DEPLOY_DIR\/snippets\.before\.json"/,
  );
  if (!match) throw new Error("Missing Snippets absence filter");
  return match[1];
}

function runConfigurationGuard(delimiter: "DEPLOY" | "ROLLBACK", zoneId?: string) {
  const directory = makeTemporaryDirectory();
  const operations = join(directory, "operations");
  const startup = join(directory, "startup.sh");
  writeFileSync(operations, "");
  writeFileSync(startup, String.raw`
git() { printf 'git\n' >> "$GUARD_OPERATIONS"; return 97; }
mktemp() { printf 'mktemp\n' >> "$GUARD_OPERATIONS"; return 97; }
curl() { printf 'curl\n' >> "$GUARD_OPERATIONS"; return 97; }
npx() { printf 'npx\n' >> "$GUARD_OPERATIONS"; return 97; }
node() { printf 'node\n' >> "$GUARD_OPERATIONS"; return 97; }
`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    BASH_ENV: startup,
    GUARD_OPERATIONS: operations,
    CLOUDFLARE_API_TOKEN: "synthetic-fixture-token",
    APPROVED_SOURCE_SHA: "a".repeat(40),
    DEPLOY_DIR: directory,
  };
  delete env.CLOUDFLARE_ZONE_ID;
  if (zoneId !== undefined) env.CLOUDFLARE_ZONE_ID = zoneId;
  const block = extractDelimitedBlock(readFileSync(readmePath, "utf8"), delimiter);
  const result = spawnSync("bash", ["-c", block], {
    cwd: siteRoot,
    encoding: "utf8",
    env,
  });
  return { result, operations: readFileSync(operations, "utf8") };
}

function runSnippetAbsenceFilter(filter: string, payload: unknown) {
  return spawnSync("jq", ["-e", "--arg", "name", "legacy_redirects_260_test", filter], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
}

function runRulesRead(options: {
  body: string;
  curlExit: number;
  httpStatus: string;
}) {
  const receiptDirectory = makeTemporaryDirectory();
  const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
API_BASE=https://api.cloudflare.test/zones/example/snippets

cf_api() {
  local output=
  shift 2
  while (( $# )); do
    case "$1" in
      --output)
        output=$2
        shift 2
        ;;
      --write-out)
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  printf '%s' "$MOCK_BODY" > "$output"
  printf '%s' "$MOCK_HTTP_STATUS"
  return "$MOCK_CURL_EXIT"
}

read_snippet_rules rules.before
`;
  const result = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      MOCK_BODY: options.body,
      MOCK_CURL_EXIT: String(options.curlExit),
      MOCK_HTTP_STATUS: options.httpStatus,
      RECEIPT_DIRECTORY: receiptDirectory,
      RUNBOOK_LIBRARY: libraryPath,
    },
  });
  return { receiptDirectory, result };
}

function writeRulesReceipt(
  directory: string,
  prefix: string,
  state: "absent" | "present",
  rules: Record<string, unknown>[] = [],
) {
  const absentBody = JSON.stringify({
    success: false,
    errors: [{ code: 10003, message: "entrypoint missing" }],
  });
  const presentBody = JSON.stringify({ success: true, result: rules });
  writeFileSync(join(directory, `${prefix}.json`), state === "absent" ? absentBody : presentBody);
  writeFileSync(join(directory, `${prefix}.http-status`), state === "absent" ? "404\n" : "200\n");
  writeFileSync(join(directory, `${prefix}.state`), `${state}\n`);
  writeFileSync(
    join(directory, `${prefix}.payload.json`),
    canonicalJson(state === "absent" ? [] : rules),
  );
  writeFileSync(
    join(directory, `${prefix}.canonical.json`),
    canonicalJson(
      state === "absent"
        ? []
        : rules.map(({ id: _id, last_updated: _lastUpdated, ...rule }) => rule),
    ),
  );
}

function canonicalJson(value: unknown): string {
  const result = spawnSync("jq", ["-S", "."], {
    encoding: "utf8",
    input: JSON.stringify(value),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("legacy redirect Snippet runbook", () => {
  for (const delimiter of ["DEPLOY", "ROLLBACK"] as const) {
    it.each([undefined, "", "not-a-zone", "a".repeat(31), "g".repeat(32)])(
      `${delimiter} rejects an absent or invalid deployment zone before external commands (%s)`,
      (zoneId) => {
        const { result, operations } = runConfigurationGuard(delimiter, zoneId);
        expect(result.status).not.toBe(0);
        expect(operations).toBe("");
      },
    );

    it(`${delimiter} admits a synthetic zone and reaches the offline preflight boundary`, () => {
      const { result, operations } = runConfigurationGuard(delimiter, "a".repeat(32));
      expect(result.status).not.toBe(0);
      expect(operations).toBe(delimiter === "DEPLOY" ? "mktemp\n" : "git\n");
    });
  }

  it("keeps a successful rules list as a present entrypoint", () => {
    const rule = {
      enabled: true,
      id: "server-rule-id",
      last_updated: "2026-08-24T00:00:00Z",
      snippet_name: "existing",
    };
    const body = JSON.stringify({
      success: true,
      result: [rule],
    });
    const { receiptDirectory, result } = runRulesRead({
      body,
      curlExit: 0,
      httpStatus: "200",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(receiptDirectory, "rules.before.json"), "utf8")).toBe(body);
    expect(readFileSync(join(receiptDirectory, "rules.before.http-status"), "utf8")).toBe(
      "200\n",
    );
    expect(readFileSync(join(receiptDirectory, "rules.before.state"), "utf8")).toBe(
      "present\n",
    );
    expect(
      JSON.parse(readFileSync(join(receiptDirectory, "rules.before.payload.json"), "utf8")),
    ).toEqual([rule]);
    expect(
      JSON.parse(readFileSync(join(receiptDirectory, "rules.before.canonical.json"), "utf8")),
    ).toEqual([{ enabled: true, snippet_name: "existing" }]);
  });

  it("accepts only the authorized 404 and code 10003 absence", () => {
    const body = JSON.stringify({
      success: false,
      errors: [{ code: 10003, message: "entrypoint missing" }],
    });
    const { receiptDirectory, result } = runRulesRead({
      body,
      curlExit: 22,
      httpStatus: "404",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(receiptDirectory, "rules.before.json"), "utf8")).toBe(body);
    expect(readFileSync(join(receiptDirectory, "rules.before.http-status"), "utf8")).toBe(
      "404\n",
    );
    expect(readFileSync(join(receiptDirectory, "rules.before.state"), "utf8")).toBe(
      "absent\n",
    );
    expect(readFileSync(join(receiptDirectory, "rules.before.canonical.json"), "utf8")).toBe(
      "[]\n",
    );
  });

  it.each([
    ["the wrong Cloudflare code", "404", 22, { success: false, errors: [{ code: 10000 }] }],
    [
      "more than the one absence error",
      "404",
      22,
      { success: false, errors: [{ code: 10003 }, { code: 10000 }] },
    ],
    ["the right code with the wrong status", "403", 22, { success: false, errors: [{ code: 10003 }] }],
    ["a transport failure", "000", 7, ""],
    ["an unsuccessful HTTP 200 body", "200", 0, { success: false, errors: [{ code: 10003 }] }],
  ])("rejects %s and keeps the raw status receipt", (_name, httpStatus, curlExit, payload) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const { receiptDirectory, result } = runRulesRead({ body, curlExit, httpStatus });

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(receiptDirectory, "rules.before.json"), "utf8")).toBe(body);
    expect(readFileSync(join(receiptDirectory, "rules.before.http-status"), "utf8")).toBe(
      `${httpStatus}\n`,
    );
    expect(existsSync(join(receiptDirectory, "rules.before.state"))).toBe(false);
    expect(existsSync(join(receiptDirectory, "rules.before.payload.json"))).toBe(false);
    expect(existsSync(join(receiptDirectory, "rules.before.canonical.json"))).toBe(false);
  });

  it("detects absent and present-empty entrypoints as different concurrency states", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "absent");
    writeRulesReceipt(receiptDirectory, "rules.pre-activate", "present");
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.pre-activate
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).not.toBe(0);
  });

  it("accepts matching saved rule states", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "absent");
    writeRulesReceipt(receiptDirectory, "rules.current", "absent");
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.current
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a saved state with an inconsistent HTTP status", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "absent");
    writeRulesReceipt(receiptDirectory, "rules.current", "absent");
    writeFileSync(join(receiptDirectory, "rules.before.http-status"), "200\n");
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.current
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).not.toBe(0);
  });

  it("ignores only server-managed rule fields during concurrency comparison", () => {
    const receiptDirectory = makeTemporaryDirectory();
    const semanticRule = {
      description: "Existing rule",
      enabled: true,
      expression: "http.host eq \"example.com\"",
      snippet_name: "existing",
    };
    writeRulesReceipt(receiptDirectory, "rules.before", "present", [
      { id: "before-id", last_updated: "2026-08-24T00:00:00Z", ...semanticRule },
    ]);
    writeRulesReceipt(receiptDirectory, "rules.current", "present", [
      { id: "current-id", last_updated: "2026-08-25T00:00:00Z", ...semanticRule },
    ]);
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.current
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a semantic rule change during concurrency comparison", () => {
    const receiptDirectory = makeTemporaryDirectory();
    const semanticRule = {
      description: "Existing rule",
      enabled: true,
      expression: "http.host eq \"example.com\"",
      snippet_name: "existing",
    };
    writeRulesReceipt(receiptDirectory, "rules.before", "present", [semanticRule]);
    writeRulesReceipt(receiptDirectory, "rules.current", "present", [
      { ...semanticRule, expression: "http.host eq \"changed.example.com\"" },
    ]);
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.current
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).not.toBe(0);
  });

  it("rejects a payload receipt that differs from the raw response", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "present", [
      { enabled: true, snippet_name: "existing" },
    ]);
    writeRulesReceipt(receiptDirectory, "rules.current", "present", [
      { enabled: true, snippet_name: "existing" },
    ]);
    writeFileSync(join(receiptDirectory, "rules.before.payload.json"), "[]\n");
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
compare_saved_rules rules.before rules.current
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).not.toBe(0);
  });

  it("cannot mask an invalid saved receipt when comparison runs in a conditional", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "absent");
    writeRulesReceipt(receiptDirectory, "rules.current", "absent");
    writeFileSync(
      join(receiptDirectory, "rules.before.json"),
      JSON.stringify({ success: false, errors: [{ code: 10000 }] }),
    );
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
if compare_saved_rules rules.before rules.current > /dev/null; then
  exit 0
fi
exit 42
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).toBe(42);
  });

  it.each([
    ["absent", "DELETE"],
    ["present", "PUT"],
  ] as const)("restores an originally %s entrypoint with %s", (state, expectedMethod) => {
    const receiptDirectory = makeTemporaryDirectory();
    const savedRules =
      state === "present"
        ? [
            {
              description: "Existing rule",
              enabled: true,
              expression: "http.host eq \"example.com\"",
              id: "rule-id",
              last_updated: "2026-08-24T00:00:00Z",
              snippet_name: "existing",
            },
          ]
        : [];
    writeRulesReceipt(receiptDirectory, "rules.before", state, savedRules);
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
API_BASE=https://api.cloudflare.test/zones/example/snippets

cf_api_receipt() {
  printf '%s %s %s\n' "$1" "$2" "$3" > "$DEPLOY_DIR/mock-api-call"
  printf '{"success":true,"result":{}}\n' > "$DEPLOY_DIR/$3.json"
  printf '200\n' > "$DEPLOY_DIR/$3.http-status"
}

restore_snippet_rules rules.before rules.rollback
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(receiptDirectory, "mock-api-call"), "utf8")).toBe(
      `${expectedMethod} https://api.cloudflare.test/zones/example/snippets/snippet_rules rules.rollback\n`,
    );
    expect(existsSync(join(receiptDirectory, "rules.rollback.body.json"))).toBe(
      state === "present",
    );
    if (state === "present") {
      expect(
        JSON.parse(readFileSync(join(receiptDirectory, "rules.rollback.body.json"), "utf8")),
      ).toEqual({ rules: savedRules });
    }
  });

  it("rejects a restore with an unsuccessful API body", () => {
    const receiptDirectory = makeTemporaryDirectory();
    writeRulesReceipt(receiptDirectory, "rules.before", "absent");
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
API_BASE=https://api.cloudflare.test/zones/example/snippets
cf_api_receipt() {
  printf '{"success":false,"errors":[{"code":10000}]}\n' > "$DEPLOY_DIR/$3.json"
  printf '200\n' > "$DEPLOY_DIR/$3.http-status"
}
restore_snippet_rules rules.before rules.rollback
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status).not.toBe(0);
  });

  it("preserves existing payload fields while replacing the issue 260 rule", () => {
    const receiptDirectory = makeTemporaryDirectory();
    const existingRule = {
      description: "Keep this rule",
      enabled: false,
      expression: "http.host eq \"example.com\"",
      id: "existing-id",
      last_updated: "2026-08-24T00:00:00Z",
      snippet_name: "existing",
    };
    writeRulesReceipt(receiptDirectory, "rules.before", "present", [
      existingRule,
      {
        description: "NJ PBS legacy URL map (#260)",
        enabled: true,
        expression: "true",
        id: "old-id",
        last_updated: "2026-08-23T00:00:00Z",
        snippet_name: "legacy_redirects_260_old",
      },
    ]);
    const harness = String.raw`
set -euo pipefail
source "$RUNBOOK_LIBRARY"
DEPLOY_DIR="$RECEIPT_DIRECTORY"
prepare_snippet_rules rules.before rules.after rules.expected \
  "NJ PBS legacy URL map (#260)" legacy_redirects_260_new
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        RECEIPT_DIRECTORY: receiptDirectory,
        RUNBOOK_LIBRARY: libraryPath,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(readFileSync(join(receiptDirectory, "rules.after.body.json"), "utf8")),
    ).toEqual({
      rules: [
        existingRule,
        {
          description: "NJ PBS legacy URL map (#260)",
          enabled: true,
          expression: "http.host eq \"njpbs.org\"",
          snippet_name: "legacy_redirects_260_new",
        },
      ],
    });
  });

  it("keeps the documented deployment and rollback blocks syntactically valid", () => {
    const readme = readFileSync(readmePath, "utf8");
    const library = readFileSync(libraryPath, "utf8");
    const deploy = extractDelimitedBlock(readme, "DEPLOY");
    const rollback = extractDelimitedBlock(readme, "ROLLBACK");

    for (const block of [deploy, rollback]) {
      const result = spawnSync("bash", ["-n"], { encoding: "utf8", input: block });
      expect(result.status, result.stderr).toBe(0);
      expect(block).toContain("source snippets/legacy-redirects/runbook-lib.sh");
    }
    expect(deploy).toContain("compare_saved_rules rules.before rules.pre-activate");
    expect(deploy).toContain("prepare_snippet_rules rules.before rules.after rules.expected");
    expect(rollback).toContain("compare_saved_rules rules.expected rules.rollback-current");
    expect(rollback).toContain("restore_snippet_rules rules.before rules.rollback");
    expect(library).toContain('cf_api_receipt DELETE "$API_BASE/snippet_rules"');
  });

  it.each(["DEPLOY", "ROLLBACK"] as const)(
    "accepts only an empty or target-free Snippets list in the %s block",
    (delimiter) => {
      const block = extractDelimitedBlock(readFileSync(readmePath, "utf8"), delimiter);
      const filter = extractSnippetAbsenceFilter(block);
      const accepted = [
        { success: true, result: null },
        { success: true, result: [] },
        { success: true, result: [{ snippet_name: "another_snippet" }] },
      ];
      const rejected = [
        { success: true },
        { success: false, result: null },
        { success: true, result: [{ snippet_name: "legacy_redirects_260_test" }] },
        { success: true, result: {} },
        { success: true, result: [{}] },
        { success: true, result: [{ snippet_name: 123 }] },
      ];

      for (const payload of accepted) {
        const result = runSnippetAbsenceFilter(filter, payload);
        expect(result.status, result.stderr).toBe(0);
      }
      for (const payload of rejected) {
        expect(runSnippetAbsenceFilter(filter, payload).status).not.toBe(0);
      }
    },
  );
});
