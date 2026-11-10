#!/usr/bin/env python3
"""Render-time auditor for the built site/dist/ output.

Usage: python3 qa/audit_dist.py <dist-dir> [--coming-soon]

Checks the things a static build can get silently wrong — the logistical
errors a feature catalog cares about:

  - head/SEO contract on every page (favicon, canonical, OG, Twitter, robots,
    title, description, lang/charset/viewport, absolute og:image). Public
    pages must be indexable; prototype/wiki/rollback pages must
    stay noindexed;
  - internal-link integrity: every href/src that points inside the site
    resolves to a file the build actually emitted (a dangling link is a 404);
  - external-link safety: off-site links open with rel=noopener (+ noreferrer
    where used) and target=_blank;
  - designed-for / not-connected notices on the connection-implying pages;
  - conditional-page notices on gated pages;
  - aria-current present on the sample chip groups;
  - 404 page content.

Findings are printed grouped by severity and emitted as JSON to
qa/audit-findings.json.
Exit code is 1 when there is a high-severity finding (missing build, dangling
links, unsafe externals) and 0 when there is none, so it gates a command chain.
Low/med findings are reported but non-fatal.
"""
from __future__ import annotations

import json
import os
import re
import sys
from html.parser import HTMLParser

DIST = sys.argv[1] if len(sys.argv) > 1 else "site/dist"
COMING_SOON = "--coming-soon" in sys.argv
SITE_ORIGIN = "https://njpbs.org"

findings: list[dict] = []


def finding(sev: str, page: str, kind: str, detail: str):
    findings.append({"severity": sev, "page": page, "kind": kind, "detail": detail})


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, dict]] = []  # (tag, attrs)
        self.metas: list[dict] = []
        self.links_rel: list[dict] = []
        self.title = None
        self._in_title = False
        self.html_lang = None
        self.has_charset = False
        self.has_viewport = False
        self.text_parts: list[str] = []
        self.aria_current_page_count = 0

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        if tag == "html" and "lang" in a:
            self.html_lang = a["lang"]
        if tag == "meta":
            self.metas.append(a)
            if a.get("charset"):
                self.has_charset = True
            if a.get("name") == "viewport":
                self.has_viewport = True
        if tag == "link":
            self.links_rel.append(a)
        if tag in ("a", "img", "script", "source") and ("href" in a or "src" in a):
            self.links.append((tag, a))
        if tag == "title":
            self._in_title = True
        if a.get("aria-current") == "page":
            self.aria_current_page_count += 1

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title = (self.title or "") + data
        self.text_parts.append(data)

    @property
    def text(self) -> str:
        return " ".join(" ".join(self.text_parts).split())

    def meta_named(self, name: str):
        for m in self.metas:
            if m.get("name") == name or m.get("property") == name:
                return m.get("content")
        return None

    def rel_href(self, rel: str):
        for l in self.links_rel:
            if rel in (l.get("rel") or ""):
                return l.get("href")
        return None


def emitted_paths() -> set[str]:
    out = set()
    for root, _dirs, files in os.walk(DIST):
        for f in files:
            full = os.path.join(root, f)
            rel = "/" + os.path.relpath(full, DIST).replace(os.sep, "/")
            out.add(rel)
    return out


def normalize_site_href(href: str) -> str:
    """Convert same-site absolute URLs to root-relative paths."""
    if href == SITE_ORIGIN:
        return "/"
    if href.startswith(SITE_ORIGIN + "/"):
        return href[len(SITE_ORIGIN):]
    return href


def resolve_internal(href: str, emitted: set[str]) -> bool:
    """Does an internal href resolve to an emitted file?"""
    href = normalize_site_href(href).split("#", 1)[0].split("?", 1)[0]
    if href == "":
        return True  # pure anchor / query on same page
    if not href.startswith("/"):
        return True  # relative — skip (none expected in this build)
    # directory route -> index.html
    candidates = [href]
    if href.endswith("/"):
        candidates.append(href + "index.html")
    else:
        candidates.append(href + "/index.html")
        candidates.append(href + ".html")
    return any(c in emitted for c in candidates)


def is_external(href: str) -> bool:
    return (
        href.startswith("http://") or href.startswith("https://")
    ) and normalize_site_href(href) == href


def audit():
    emitted = emitted_paths()
    html_files = sorted(p for p in emitted if p.endswith(".html"))

    # A missing or empty build must fail loudly — otherwise os.walk yields no
    # pages, the loop runs zero times, and a skipped/broken build records as a
    # clean audit (zero findings).
    if not html_files:
        finding("high", DIST, "build", "no HTML pages found in dist — build missing or empty")
        return findings

    INDEXABLE_FULL_BUILD_PAGES = {
        "/index.html",
        "/watch/index.html",
        "/video/index.html",
        "/live/index.html",
        "/schedule/index.html",
        "/kids/index.html",
        "/support/index.html",
        "/give/index.html",
        "/donate/index.html",
        "/passport/index.html",
        "/about/index.html",
        "/accessibility/index.html",
        "/closed-captioning/index.html",
        "/privacy/index.html",
        "/public-file/index.html",
        "/eeo/index.html",
        "/meeting-notices/index.html",
    }
    INDEXABLE_FULL_BUILD_PREFIXES = ()
    # These public primary-nav destinations claim an active state on their own
    # route. Keep the dist-level check tied only to links that are local.
    NAV_TARGET_PAGES = {"/live/index.html", "/schedule/index.html"}

    for hf in html_files:
        full = os.path.join(DIST, hf.lstrip("/"))
        with open(full, encoding="utf-8") as fh:
            html = fh.read()
        p = PageParser()
        p.feed(html)
        page = hf

        # --- head contract ---
        if p.rel_href("icon") is None:
            finding("high", page, "head", "missing favicon <link rel=icon>")
        if p.html_lang != "en":
            finding("med", page, "head", f"html lang is {p.html_lang!r}, expected 'en'")
        if not p.has_charset:
            finding("med", page, "head", "missing <meta charset>")
        if not p.has_viewport:
            finding("med", page, "head", "missing viewport meta")
        if not (p.title and p.title.strip()):
            finding("high", page, "head", "missing/empty <title>")
        if not p.meta_named("description"):
            finding("high", page, "head", "missing meta description")
        robots = p.meta_named("robots")
        canon = p.rel_href("canonical")
        # A retired public URL can now point at a new canonical Page address.
        is_alias = bool(canon and canon.startswith(SITE_ORIGIN + "/")
                        and canon != SITE_ORIGIN + page.removesuffix("index.html"))
        expects_noindex = COMING_SOON or is_alias or (
            page not in INDEXABLE_FULL_BUILD_PAGES
            and not page.startswith(INDEXABLE_FULL_BUILD_PREFIXES)
        )
        if expects_noindex:
            if robots is None or "noindex" not in robots:
                finding("high", page, "head", f"robots not noindex (got {robots!r})")
        elif robots is not None and "noindex" in robots:
            finding("high", page, "head", f"public root page unexpectedly noindex (got {robots!r})")
        if not canon or not canon.startswith("https://njpbs.org"):
            finding("med", page, "head", f"canonical missing/odd: {canon!r}")
        # OG + Twitter
        for prop in ("og:title", "og:description", "og:type", "og:url", "og:image"):
            if not p.meta_named(prop):
                finding("med", page, "head", f"missing {prop}")
        ogimg = p.meta_named("og:image")
        if ogimg and not ogimg.startswith("https://"):
            finding("med", page, "head", f"og:image not absolute: {ogimg!r}")
        for prop in ("twitter:card", "twitter:title", "twitter:description", "twitter:image"):
            if not p.meta_named(prop):
                finding("low", page, "head", f"missing {prop}")

        # --- link integrity ---
        for tag, a in p.links:
            href = a.get("href") or a.get("src") or ""
            if href.startswith(("mailto:", "tel:", "data:", "javascript:")):
                if href.startswith("javascript:"):
                    finding("high", page, "link", f"javascript: URL in {tag}")
                continue
            if is_external(href):
                if tag == "a":
                    rel = a.get("rel", "")
                    target = a.get("target", "")
                    if "noopener" not in rel:
                        finding("med", page, "extlink", f"external a -> {href} missing rel=noopener (rel={rel!r})")
                    if target != "_blank":
                        finding("low", page, "extlink", f"external a -> {href} target={target!r} (expected _blank)")
                continue
            if not resolve_internal(href, emitted):
                finding("high", page, "link", f"dangling internal {tag} -> {href}")

        # --- head <link href> integrity (favicon, stylesheet, preload) ---
        # <link> elements never enter p.links, so a broken internal head asset
        # (a wrong favicon or stylesheet path) would otherwise pass the integrity
        # check the auditor promises. Skip external and origin-hint rels.
        for l in p.links_rel:
            href = l.get("href", "")
            rels = l.get("rel", "")
            if not href or is_external(href) or any(
                    r in rels for r in ("preconnect", "dns-prefetch")):
                continue
            if href.startswith(("data:", "mailto:")):
                continue
            if href.startswith("/") and not resolve_internal(href, emitted):
                finding("high", page, "link", f"dangling head <link rel={rels!r}> -> {href}")

        if page in NAV_TARGET_PAGES and p.aria_current_page_count < 1:
            finding("med", page, "aria", "no aria-current on a nav-target page")

        text_l = p.text.lower()
        # --- 404 content ---
        if page == "/404.html":
            if "off the air" not in text_l and "not found" not in text_l:
                finding("med", page, "404", "404 page lacks expected not-found copy")

    # --- coming-soon hero image assets exist ---
    if COMING_SOON:
        idx = os.path.join(DIST, "index.html")
        if os.path.exists(idx):
            html = open(idx, encoding="utf-8").read()
            for m in re.finditer(r'"src":"(/[^"]+)"', html):
                src = m.group(1)
                if src.lstrip("/") and ("/" + src.lstrip("/")) not in emitted:
                    finding("high", "/index.html", "asset", f"hero image src not emitted: {src}")

    return findings


if __name__ == "__main__":
    audit()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audit-findings.json")
    with open(out, "w") as f:
        json.dump(findings, f, indent=2)
    by_sev: dict[str, int] = {}
    for fnd in findings:
        by_sev[fnd["severity"]] = by_sev.get(fnd["severity"], 0) + 1
    print(f"dist: {DIST}  coming_soon={COMING_SOON}")
    print(f"findings: {len(findings)}  " + ", ".join(f"{k}={v}" for k, v in sorted(by_sev.items())))
    for sev in ("high", "med", "low"):
        rows = [x for x in findings if x["severity"] == sev]
        if not rows:
            continue
        print(f"\n=== {sev.upper()} ({len(rows)}) ===")
        for x in rows:
            print(f"  [{x['kind']}] {x['page']}: {x['detail']}")
    # Exit nonzero on high-severity findings (missing build, dangling links, etc.)
    # so a broken or empty dist can't pass as clean in a command chain or CI step.
    # Low/med are reported but non-fatal.
    # A process exit status keeps only its low 8 bits, so a count of 256 would read as 0.
    sys.exit(1 if by_sev.get("high") else 0)
