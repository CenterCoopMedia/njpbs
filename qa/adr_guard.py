#!/usr/bin/env python3
"""Numbering guard for the architecture decision records in docs/decisions/.

Usage: python3 qa/adr_guard.py [decisions-dir]   (default: docs/decisions)
       python3 qa/adr_guard.py --selftest        (run the embedded unit tests)

ADRs are numbered, one file per decision, with a README that indexes them. Two
things drift silently and a human review tends to miss both: two files claiming
the same number, and a new ADR that
never gets added to the README index. This guard catches them.

What it flags (high = fails CI; low = advisory, printed but non-fatal):

  HIGH
  - duplicate: two ADR files share the same NNNN number;
  - filename:  a file in the folder is not named NNNN-kebab-title.md;
  - heading:   the file's first heading is not '# NNNN. <title>', or its number
               does not match the filename;
  - index:     an ADR file is not linked from README.md, or README.md links a
               filename that does not exist (lychee catches the dangling link
               offline, but not a real ADR that was never indexed).

  LOW
  - gap:       a hole in the otherwise-contiguous number sequence (legitimate
               for a withdrawn proposal, so it is advisory only).

Exit code is 1 when there is a high-severity finding and 0 when there is none,
matching the qa/audit_dist.py convention so it can gate a command chain in CI.

Only the *number* is checked for alignment, never the title text: the index
legitimately shortens titles, so comparing wording would false-positive.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

# NNNN-kebab-title.md — four-digit number, then lowercase-alphanumeric words
# joined by single hyphens, then .md. Rejects underscores, caps, double hyphens.
ADR_FILENAME_RE = re.compile(r"^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
# First-line title: '# NNNN. <something>'.
HEADING_RE = re.compile(r"^#\s+(\d{4})\.\s+\S")
# A markdown link target pointing at an ADR file, e.g. ](0005-foo.md) or ](./0005-foo.md).
INDEX_LINK_RE = re.compile(r"\]\((?:\./)?(\d{4}-[a-z0-9-]+\.md)\)")

DEFAULT_DIR = "docs/decisions"


@dataclass(frozen=True)
class Finding:
    sev: str  # "high" | "low"
    file: str
    kind: str  # "duplicate" | "filename" | "heading" | "index" | "gap"
    detail: str


def _first_h1(path: Path) -> str | None:
    """Return the first level-1 heading line ('# ...'), or None if there is none."""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.rstrip()
        if stripped.startswith("# "):
            return stripped
    return None


def scan_adrs(decisions_dir: str | Path) -> list[Finding]:
    """Scan an ADR directory and return the list of findings (empty == clean).

    Pure over the filesystem: reads the directory, returns findings, prints
    nothing. The caller decides how to report and what exit code to use.
    """
    d = Path(decisions_dir)
    findings: list[Finding] = []

    # Candidate ADRs: every .md in the folder except the index README.
    md_files = sorted(p for p in d.glob("*.md") if p.name.lower() != "readme.md")

    by_number: dict[str, list[str]] = {}
    valid_names: set[str] = set()
    for p in md_files:
        m = ADR_FILENAME_RE.match(p.name)
        if not m:
            findings.append(
                Finding("high", p.name, "filename",
                        "not named NNNN-kebab-title.md (four-digit number, "
                        "lowercase hyphen-separated words, .md)")
            )
            continue
        num = m.group(1)
        valid_names.add(p.name)
        by_number.setdefault(num, []).append(p.name)

        heading = _first_h1(p)
        if heading is None:
            findings.append(Finding("high", p.name, "heading", "no level-1 '# ...' heading found"))
        else:
            hm = HEADING_RE.match(heading)
            if not hm:
                findings.append(
                    Finding("high", p.name, "heading",
                            f"first heading is not '# NNNN. <title>': {heading!r}")
                )
            elif hm.group(1) != num:
                findings.append(
                    Finding("high", p.name, "heading",
                            f"heading number {hm.group(1)} does not match filename number {num}")
                )

    # Duplicate numbers: one finding per colliding file.
    for num, names in by_number.items():
        if len(names) > 1:
            joined = ", ".join(sorted(names))
            for name in sorted(names):
                findings.append(
                    Finding("high", name, "duplicate",
                            f"ADR number {num} is claimed by {len(names)} files: {joined}")
                )

    # Index drift: README must link every real ADR, and link only real ADRs.
    readme = d / "README.md"
    if not readme.exists():
        findings.append(Finding("high", "README.md", "index", "decisions index README.md is missing"))
        referenced: set[str] = set()
    else:
        referenced = set(INDEX_LINK_RE.findall(readme.read_text(encoding="utf-8")))
    for name in sorted(valid_names - referenced):
        findings.append(Finding("high", name, "index", "ADR file is not linked from the README index"))
    for name in sorted(referenced - valid_names):
        findings.append(Finding("high", name, "index", "README index links a file that does not exist"))

    # Advisory: a hole in the otherwise-contiguous sequence.
    unique_nums = sorted({int(n) for n in by_number})
    if unique_nums:
        missing = [f"{n:04d}" for n in range(unique_nums[0], unique_nums[-1] + 1)
                   if n not in unique_nums]
        if missing:
            findings.append(Finding("low", "-", "gap", f"numbering gap(s): {', '.join(missing)} not present"))

    return findings


# --------------------------------------------------------------------------- #
# Reporting / CLI
# --------------------------------------------------------------------------- #

def _report(findings: list[Finding]) -> int:
    highs = [f for f in findings if f.sev == "high"]
    lows = [f for f in findings if f.sev == "low"]
    for label, group in (("HIGH", highs), ("LOW", lows)):
        if not group:
            continue
        print(f"{label}:")
        for f in group:
            where = f.file if f.file != "-" else "(folder)"
            print(f"  [{f.kind}] {where}: {f.detail}")
    if not findings:
        print("ADR guard: clean.")
    else:
        print(f"\nADR guard: {len(highs)} high, {len(lows)} low.")
    return 1 if highs else 0


def main(argv: list[str]) -> int:
    args = [a for a in argv if not a.startswith("--")]
    target = args[0] if args else DEFAULT_DIR
    if not Path(target).is_dir():
        print(f"ADR guard: directory not found: {target}", file=sys.stderr)
        return 1
    return _report(scan_adrs(target))


# --------------------------------------------------------------------------- #
# Embedded self-test (stdlib only): python3 qa/adr_guard.py --selftest
# --------------------------------------------------------------------------- #

def _selftest() -> int:
    import tempfile
    import textwrap
    import unittest

    def write_adr(d: Path, name: str, heading: str, body: str = "Body.") -> None:
        (d / name).write_text(f"# {heading}\n\n{body}\n", encoding="utf-8")

    def write_index(d: Path, links: list[str]) -> None:
        lines = ["# Architecture decision records", "", "## Index", ""]
        lines += [f"- [{n}]({n})" for n in links]
        (d / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def kinds(findings: list[Finding], sev: str | None = None) -> list[str]:
        return [f.kind for f in findings if sev is None or f.sev == sev]

    class SelfTest(unittest.TestCase):
        def setUp(self) -> None:
            self._tmp = tempfile.TemporaryDirectory()
            self.d = Path(self._tmp.name)

        def tearDown(self) -> None:
            self._tmp.cleanup()

        def test_clean_dir_has_no_findings(self) -> None:
            write_adr(self.d, "0001-first.md", "0001. First")
            write_adr(self.d, "0002-second.md", "0002. Second")
            write_index(self.d, ["0001-first.md", "0002-second.md"])
            self.assertEqual(scan_adrs(self.d), [])

        def test_duplicate_number_is_high(self) -> None:
            write_adr(self.d, "0005-alpha.md", "0005. Alpha")
            write_adr(self.d, "0005-beta.md", "0005. Beta")
            write_index(self.d, ["0005-alpha.md", "0005-beta.md"])
            f = scan_adrs(self.d)
            dups = [x for x in f if x.kind == "duplicate"]
            self.assertEqual({x.file for x in dups}, {"0005-alpha.md", "0005-beta.md"})
            self.assertTrue(all(x.sev == "high" for x in dups))

        def test_malformed_filename_is_high(self) -> None:
            write_adr(self.d, "5-no-pad.md", "0005. Unpadded")
            write_index(self.d, [])
            self.assertIn("filename", kinds(scan_adrs(self.d), "high"))

        def test_heading_number_mismatch_is_high(self) -> None:
            write_adr(self.d, "0003-x.md", "0009. Wrong number")
            write_index(self.d, ["0003-x.md"])
            self.assertIn("heading", kinds(scan_adrs(self.d), "high"))

        def test_missing_heading_is_high(self) -> None:
            (self.d / "0004-y.md").write_text("No heading here.\n", encoding="utf-8")
            write_index(self.d, ["0004-y.md"])
            self.assertIn("heading", kinds(scan_adrs(self.d), "high"))

        def test_file_missing_from_index_is_high(self) -> None:
            write_adr(self.d, "0001-a.md", "0001. A")
            write_adr(self.d, "0002-b.md", "0002. B")
            write_index(self.d, ["0001-a.md"])  # 0002 not indexed
            idx = [x for x in scan_adrs(self.d) if x.kind == "index"]
            self.assertTrue(any(x.file == "0002-b.md" and x.sev == "high" for x in idx))

        def test_dangling_index_entry_is_high(self) -> None:
            write_adr(self.d, "0001-a.md", "0001. A")
            write_index(self.d, ["0001-a.md", "0002-ghost.md"])  # ghost has no file
            idx = [x for x in scan_adrs(self.d) if x.kind == "index"]
            self.assertTrue(any(x.file == "0002-ghost.md" and x.sev == "high" for x in idx))

        def test_numbering_gap_is_low_not_high(self) -> None:
            write_adr(self.d, "0001-a.md", "0001. A")
            write_adr(self.d, "0003-c.md", "0003. C")  # 0002 missing
            write_index(self.d, ["0001-a.md", "0003-c.md"])
            f = scan_adrs(self.d)
            self.assertIn("gap", kinds(f, "low"))
            self.assertEqual(kinds(f, "high"), [])

    suite = unittest.TestLoader().loadTestsFromTestCase(SelfTest)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    raise SystemExit(main(sys.argv[1:]))
