import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Gate 1 of scripts/deploy-admin.sh proves a commit is reviewed by comparing it
// against origin/main. It never checked that origin is this repository, so on a
// checkout pointed at a fork or a scratch remote it proved the commit matched
// that remote's main and nothing about review (#557).
//
// The parsing is the part worth testing directly. The issue's own warning is
// that a naive string compare would refuse legitimate checkouts, which is worse
// than the hole: a deploy gate that cries wolf gets overridden by habit, and the
// override that silences it also silences the reviewed-code check. So the table
// below is mostly spellings that must be ACCEPTED.

const LIB = fileURLToPath(new URL("../../scripts/lib/canonical-repo.sh", import.meta.url));
const DEPLOY = fileURLToPath(new URL("../../scripts/deploy-admin.sh", import.meta.url));

// Run the real function from the real file. Sourcing it is why it lives in its
// own side-effect-free file rather than inside the deploy script.
function normalise(url) {
  const out = execFileSync(
    "bash",
    ["-c", 'source "$1"; canonical_repo_from_url "$2" || true', "_", LIB, url],
    { encoding: "utf8" },
  );
  return out.trim();
}

function redact(url) {
  const out = execFileSync(
    "bash",
    ["-c", 'source "$1"; redact_url_credentials "$2"', "_", LIB, url],
    { encoding: "utf8" },
  );
  return out.trim();
}

describe("deploy-admin origin identity (#557)", () => {
  it.each([
    ["CenterCoopMedia/njpbs", "1442374012", true],
    ["CenterCoopMedia/njpbs", "99", false],
  ])("requires the configured repository ID before fetching reviewed main: %s / %s", (repository, id, allowed) => {
    const gate = readFileSync(DEPLOY, "utf8").match(/^gate_reviewed_code\(\) \{[\s\S]*?^\}/m)[0];
    const harness = `source "$1"
    die() { printf '%s\\n' "$1" >&2; exit 1; }
    gh() { printf '%s\\n' "$FIXTURE_REPOSITORY_ID"; }
    git() {
      case "$*" in
        "status --porcelain") ;;
        "ls-remote --get-url origin") printf 'https://github.com/%s.git\\n' "$FIXTURE_REPOSITORY" ;;
        "fetch --quiet origin main") printf 'fetch admitted\\n' ;;
        "rev-parse --verify --quiet origin/main"|"merge-base --is-ancestor HEAD origin/main") ;;
        "rev-parse HEAD"|"rev-parse origin/main") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;;
        *) exit 89 ;;
      esac
    }
    CANONICAL_REPO="$CANONICAL_GITHUB_REPOSITORY"
    CANONICAL_REPO_ID="$CANONICAL_GITHUB_REPOSITORY_ID"
    ${gate}
    configured_repository_identity || exit 1
    gate_reviewed_code`;
    const result = spawnSync("bash", ["-c", harness, "_", LIB], { encoding: "utf8",
      env: { PATH: process.env.PATH, CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012", FIXTURE_REPOSITORY: repository, FIXTURE_REPOSITORY_ID: id } });
    expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
    expect(result.stdout.includes("fetch admitted")).toBe(allowed);
  });

  it.each([
    ["git@github.com:CenterCoopMedia/njpbs.git", "scp-like ssh, the git default"],
    ["git@github.com:CenterCoopMedia/njpbs", "scp-like without .git"],
    ["ssh://git@github.com/CenterCoopMedia/njpbs.git", "ssh url form"],
    ["https://github.com/CenterCoopMedia/njpbs.git", "https with .git"],
    ["https://github.com/CenterCoopMedia/njpbs", "https without .git"],
    ["https://github.com/CenterCoopMedia/njpbs/", "trailing slash"],
    ["https://github.com/CenterCoopMedia/njpbs.git/", "slash after .git"],
    ["github.com:CenterCoopMedia/njpbs.git", "scp-like with no user"],
    ["https://fixture-owner@github.com/CenterCoopMedia/njpbs.git", "https with a username"],
    ["https://x-access-token:ghs_tok@github.com/CenterCoopMedia/njpbs.git", "token in the url"],
    ["git://github.com/CenterCoopMedia/njpbs.git", "git protocol"],
    ["https://www.github.com/CenterCoopMedia/njpbs.git", "www host"],
    ["https://github.com/CenterCoopMedia/NJPBS.git", "mixed case, one repo on GitHub"],
    ["git@github.com:CENTERCOOPMEDIA/NJPBS.git", "upper case scp-like"],
  ])("accepts %s (%s)", (url) => {
    expect(
      normalise(url),
      `${url} is a legitimate spelling of the canonical repository, and ` +
        "refusing it would be the false refusal this whole function exists to " +
        "avoid.",
    ).toBe("centercoopmedia/njpbs");
  });

  // Two different refusals, and the parser distinguishes them. A real GitHub
  // repository that is not this one gets named, and the gate refuses on the
  // comparison. Anything the parser cannot identify as a GitHub repository at
  // all returns empty, and the gate refuses on that instead, with a different
  // message. Asserting the exact name in the first group is what proves the
  // parser is not just failing indiscriminately.
  it.each([
    ["git@github.com:someone/njpbs-site.git", "a fork under another owner", "someone/njpbs-site"],
    [
      "https://github.com/CenterCoopMedia/njpbs-scratch.git",
      "a differently named repo",
      "centercoopmedia/njpbs-scratch",
    ],
  ])("names %s as a real but different repository (%s)", (url, _label, expected) => {
    expect(normalise(url)).toBe(expected);
    expect(normalise(url)).not.toBe("centercoopmedia/njpbs");
  });

  it.each([
    ["https://gitlab.com/CenterCoopMedia/njpbs.git", "another host entirely"],
    ["https://github.example.com/CenterCoopMedia/njpbs.git", "a lookalike host"],
    ["/srv/mirrors/njpbs-site.git", "a local mirror path"],
    ["file:///srv/mirrors/njpbs-site.git", "a file url"],
    ["", "no remote at all"],
  ])("cannot identify %s at all (%s)", (url) => {
    // Empty, not merely "something else": the gate reads an empty answer as
    // "cannot identify this remote", and a parser that returned garbage here
    // would satisfy a not.toBe check while telling the gate nothing.
    expect(
      normalise(url),
      `${url} is not identifiable as a GitHub repository, so the parser has to ` +
        "say so by returning nothing rather than by returning a different string.",
    ).toBe("");
  });

  it("distinguishes a lookalike host from github.com", () => {
    // The check that matters most: an attacker-controlled host whose path is
    // identical. Host matching is what separates these, not the path.
    expect(normalise("https://github.com.evil.test/CenterCoopMedia/njpbs.git")).toBe("");
    expect(normalise("https://notgithub.com/CenterCoopMedia/njpbs.git")).toBe("");
  });

  it.each([
    // git reads file://host/path as the LOCAL path /path and ignores the host,
    // so this fetches from /CenterCoopMedia/njpbs.git on the deploying machine.
    ["file://github.com/CenterCoopMedia/njpbs.git", "file url that names github.com"],
    // ext:: runs a command of the remote's choosing, whatever the URL spells.
    ["ext::sh -c echo%20https://github.com/CenterCoopMedia/njpbs.git", "ext helper"],
    ["ftp://github.com/CenterCoopMedia/njpbs.git", "a transport git does not speak"],
    ["madeup://github.com/CenterCoopMedia/njpbs.git", "an unknown scheme"],
  ])("refuses %s because the scheme decides where git fetches (%s)", (url) => {
    // The host check proves nothing unless the transport actually fetches from
    // the host it names, so the scheme is allowlisted before the host is read.
    expect(
      normalise(url),
      `${url} does not fetch from github.com despite naming it, so reading it ` +
        "as the canonical repository would hand the gate a remote it never checked.",
    ).toBe("");
  });

  it.each([
    ["https://evil.test/@github.com/CenterCoopMedia/njpbs.git", "https, @ opens the path"],
    ["https://evil.test/path@github.com/CenterCoopMedia/njpbs.git", "https, @ inside the path"],
    ["https://evil.test/a/b@github.com/CenterCoopMedia/njpbs.git", "https, @ deep in the path"],
    ["ssh://git@evil.test/@github.com/CenterCoopMedia/njpbs.git", "ssh url with real userinfo too"],
    ["git@evil.test:@github.com/CenterCoopMedia/njpbs.git", "scp-like"],
    ["git@evil.test:path@github.com/CenterCoopMedia/njpbs.git", "scp-like, @ inside the path"],
    ["https://evil.test?@github.com/CenterCoopMedia/njpbs.git", "query string opens the tail"],
    ["https://evil.test#@github.com/CenterCoopMedia/njpbs.git", "fragment opens the tail"],
  ])("reads the host from the authority, not a later @: %s (%s)", (url) => {
    // git fetches every one of these from evil.test. A parser that strips to
    // the LAST @ in the whole URL reads "github.com" out of the path and hands
    // the gate an attacker-controlled origin/main, which is exactly the hole
    // the origin check exists to close.
    expect(
      normalise(url),
      `${url} is fetched from evil.test. Normalising it to the canonical ` +
        "repository would let an attacker-controlled remote satisfy gate 1.",
    ).toBe("");
  });

  it.each([
    ["https://github.com:443/CenterCoopMedia/njpbs.git", "explicit https port"],
    ["ssh://git@github.com:22/CenterCoopMedia/njpbs.git", "explicit ssh port"],
    // Hostnames are case insensitive. git fetches this from the real GitHub, so
    // refusing it would be the gate crying wolf about a legitimate checkout.
    ["https://GITHUB.com/CenterCoopMedia/njpbs.git", "upper case host"],
    ["git@GitHub.com:CenterCoopMedia/njpbs.git", "mixed case host, scp-like"],
  ])("still accepts %s (%s)", (url) => {
    expect(normalise(url)).toBe("centercoopmedia/njpbs");
  });

  it("keeps a token in a remote url out of the refusal message", () => {
    // The refusal names the offending remote, which is what makes it
    // actionable, and that text goes to a terminal scrollback or a CI log. A
    // remote can carry a live credential in its userinfo.
    const tokened = "https://x-access-token:ghs_liveSecretValue@github.com/someone/repo.git";
    const shown = redact(tokened);
    expect(shown).not.toContain("ghs_liveSecretValue");
    expect(shown).not.toContain("x-access-token");
    // Still says which host and repository, or the message stops being useful.
    expect(shown).toContain("github.com/someone/repo.git");
  });

  it("leaves a credential-free url readable", () => {
    expect(redact("https://github.com/CenterCoopMedia/njpbs.git")).toBe(
      "https://github.com/CenterCoopMedia/njpbs.git",
    );
    expect(redact("/srv/mirrors/njpbs-site.git")).toBe("/srv/mirrors/njpbs-site.git");
  });

  it("does not let redaction turn an impostor url into the canonical one", () => {
    // The refusal for this url has to show evil.test, because that is the whole
    // reason it is being refused. Cutting at the first @ anywhere would print
    // https://***@github.com/CenterCoopMedia/njpbs.git, which reads to an
    // operator as the canonical repository being rejected for no reason.
    const impostor = "https://evil.test/@github.com/CenterCoopMedia/njpbs.git";
    expect(redact(impostor)).toContain("evil.test");
    expect(redact(impostor)).toBe(impostor);
  });

  it("removes a password containing an @ whole", () => {
    // The userinfo ends at the LAST @ inside the authority, so half a password
    // does not survive into the log.
    const shown = redact("https://user:p@ssw0rd@github.com/CenterCoopMedia/njpbs.git");
    expect(shown).not.toContain("ssw0rd");
    expect(shown).toBe("https://***@github.com/CenterCoopMedia/njpbs.git");
  });

  it("wires the check into gate 1 rather than leaving it unused", () => {
    // The parsing above can be perfect and still prove nothing if the gate does
    // not call it, so pin the wiring too.
    const script = readFileSync(DEPLOY, "utf8");
    expect(script).toContain("source \"$repo_root/scripts/lib/canonical-repo.sh\"");
    expect(script).toContain('readonly CANONICAL_REPO="${CANONICAL_GITHUB_REPOSITORY:?Configure the canonical repository}"');
    expect(script).toContain('origin_repo="$(canonical_repo_from_url "$origin_url" || true)"');
    // ls-remote --get-url applies url.<base>.insteadOf rewrites; remote get-url
    // does not, and would refuse an ordinary multi-account checkout.
    expect(script).toContain('git ls-remote --get-url origin');
    // The raw URL must never reach the message; only the redacted one.
    expect(script).toContain('origin_shown="$(redact_url_credentials "$origin_url")"');
    expect(script).not.toMatch(/die "[^"]*\$origin_url/);

    // The refusal has to sit ahead of the fetch it protects: checking after
    // would already have trusted the wrong remote. Both indices are checked for
    // -1 first, or a revert would make the ordering compare pass vacuously.
    const callIndex = script.indexOf("canonical_repo_from_url");
    const fetchIndex = script.indexOf("git fetch --quiet origin main");
    expect(callIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(fetchIndex);
  });
});
