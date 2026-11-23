#!/usr/bin/env python3
"""Extract a WordPress WXR export into a private archive interchange file."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from urllib.parse import urlsplit
from xml.etree.ElementTree import TreeBuilder
from xml.parsers import expat


READ_SIZE = 64 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_RECORD_ELEMENTS = 4096
MAX_DEPTH = 64
WXR = "{https://wordpress.org/export/1.2/}"
EXCERPT = "{https://wordpress.org/export/1.2/excerpt/}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}"
DC = "{http://purl.org/dc/elements/1.1/}"
STORY_STATUSES = {"publish", "future", "draft", "pending", "private"}


class InvalidExport(ValueError):
    pass


class UnmappableRecord(ValueError):
    pass


def json_line(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def field(element, tag):
    return text_field(element, tag).strip()


def text_field(element, tag):
    fields = element.findall(tag)
    if len(fields) > 1 or (fields and len(fields[0])):
        raise UnmappableRecord("invalid-scalar-field")
    return (fields[0].text or "") if fields else ""


def source_id(value, *, required=False):
    if not required and value in ("", "0"):
        return None
    if not re.fullmatch(r"[1-9][0-9]{0,19}", value):
        raise UnmappableRecord("invalid-source-id")
    return value


def web_url(value, reason):
    try:
        url = urlsplit(value)
        if (url.scheme in {"http", "https"} and url.hostname and url.username is None
                and (url.port is None or url.port > 0)
                and not any(char.isspace() or ord(char) < 32 or char == "\\" for char in value)):
            return value
    except ValueError:
        pass
    raise UnmappableRecord(reason)


def source_date(value):
    if value in ("", "0000-00-00 00:00:00"):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise UnmappableRecord("invalid-date") from None


def utc_date(value):
    date = source_date(value)
    return date.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z") if date else None


def taxonomy(item):
    terms = []
    for element in item.findall("category"):
        domain = element.get("domain", "").strip()
        slug = element.get("nicename", "").strip()
        if not domain or not slug or len(element):
            raise UnmappableRecord("invalid-taxonomy")
        terms.append({"taxonomy": domain, "slug": slug, "label": element.text or ""})
    return terms


def featured_attachment(item):
    ids = {
        source_id(field(meta, WXR + "meta_value"))
        for meta in item.findall(WXR + "postmeta")
        if field(meta, WXR + "meta_key") == "_thumbnail_id"
    }
    if len(ids) > 1:
        raise UnmappableRecord("ambiguous-featured-attachment")
    return next(iter(ids), None)


def item_record(item):
    post_type = field(item, WXR + "post_type")
    if post_type not in {"post", "attachment"}:
        raise UnmappableRecord("unsupported-post-type")
    if text_field(item, WXR + "post_password"):
        raise UnmappableRecord("password-protected-item")

    status = field(item, WXR + "status")
    if status not in (STORY_STATUSES if post_type == "post" else {"inherit", "private", "publish"}):
        raise UnmappableRecord("unsupported-status")

    local_date = source_date(field(item, WXR + "post_date"))
    record = {
        "kind": "story" if post_type == "post" else "attachment",
        "postId": source_id(field(item, WXR + "post_id"), required=True),
        "sourceStatus": status,
        "lifecycle": "staged",
        "title": text_field(item, "title"),
        "slug": field(item, WXR + "post_name"),
        "permalink": web_url(field(item, "link"), "invalid-permalink"),
        "postDate": local_date.isoformat() if local_date else None,
        "postDateUtc": utc_date(field(item, WXR + "post_date_gmt")),
        "authorLogin": field(item, DC + "creator") or None,
        "taxonomy": taxonomy(item),
        "parentPostId": source_id(field(item, WXR + "post_parent")),
        "html": text_field(item, CONTENT + "encoded"),
        "excerpt": text_field(item, EXCERPT + "encoded"),
    }
    if post_type == "attachment":
        record["attachmentUrl"] = web_url(field(item, WXR + "attachment_url"), "invalid-attachment-url")
    else:
        record["featuredAttachmentId"] = featured_attachment(item)
    return with_revision(record, utc_date(field(item, WXR + "post_modified_gmt")))


def with_revision(record, modified_at=None):
    record["revision"] = {
        "modifiedAt": modified_at,
        "sha256": hashlib.sha256(json_line(record).encode("utf-8")).hexdigest(),
    }
    return record


def author_record(author):
    login = field(author, WXR + "author_login")
    if not login:
        raise UnmappableRecord("missing-author-login")
    return with_revision({
        "kind": "author",
        "authorId": source_id(field(author, WXR + "author_id"), required=True),
        "login": login,
        "displayName": field(author, WXR + "author_display_name"),
    })


def xml_name(name):
    if name.startswith("http://wordpress.org/export/1.2/"):
        name = "https" + name[4:]
    return "{" + name if "}" in name else name


class WxrReader:
    """Keep one channel record in memory. Expat consumes the rest without a tree."""

    def __init__(self, emit):
        self.emit = emit
        self.path = []
        self.has_channel = False
        self.has_version = False
        self.ordinal = 0
        self.kind = None
        self.tree = None
        self.start_byte = 0
        self.elements = 0
        self.counts = Counter(story=0, attachment=0, author=0, unmappable=0)
        self.reasons = Counter()
        self.parser = expat.ParserCreate(namespace_separator="}", intern=None)
        self.parser.StartElementHandler = self.start
        self.parser.EndElementHandler = self.end
        self.parser.CharacterDataHandler = self.data
        self.parser.StartDoctypeDeclHandler = self.reject_doctype

    def reject_doctype(self, *_):
        raise InvalidExport("XML document types are unsupported.")

    def start(self, name, attributes):
        name = xml_name(name)
        self.path.append(name)
        if len(self.path) > MAX_DEPTH:
            raise InvalidExport("XML nesting exceeds the archive limit.")
        if len(self.path) == 1 and name != "rss":
            raise InvalidExport("Expected a WXR RSS document.")
        if self.path == ["rss", "channel"]:
            if self.has_channel:
                raise InvalidExport("Expected a single WXR channel.")
            self.has_channel = True
        if self.path[:2] == ["rss", "channel"] and len(self.path) == 3:
            if name in ("item", WXR + "author", WXR + "wxr_version"):
                self.begin_record(name)
        if self.tree is not None:
            self.elements += 1
            self.enforce_record_limits()
            if self.tree is not None:
                self.tree.start(name, attributes)

    def begin_record(self, name):
        if name != WXR + "wxr_version" and not self.has_version:
            raise InvalidExport("Expected WXR version 1.2 before records.")
        self.kind = name
        self.start_byte = self.parser.CurrentByteIndex
        self.elements = 0
        self.tree = TreeBuilder()

    def enforce_record_limits(self):
        if (self.parser.CurrentByteIndex - self.start_byte > MAX_RECORD_BYTES
                or self.elements > MAX_RECORD_ELEMENTS):
            self.tree = None

    def data(self, value):
        if self.tree is not None:
            self.enforce_record_limits()
            if self.tree is not None:
                self.tree.data(value)

    def end(self, name):
        if self.tree is not None:
            self.enforce_record_limits()
            if self.tree is not None:
                self.tree.end(xml_name(name))
        if self.kind is not None and len(self.path) == 3:
            root = self.tree.close() if self.tree is not None else None
            if self.kind == WXR + "wxr_version":
                if root is None or len(root) or (root.text or "").strip() != "1.2" or self.has_version:
                    raise InvalidExport("Expected a single WXR version of 1.2.")
                self.has_version = True
            else:
                self.record(root)
            self.kind = None
            self.tree = None
        self.path.pop()

    def record(self, root):
        self.ordinal += 1
        try:
            if root is None:
                raise UnmappableRecord("record-limit")
            record = item_record(root) if self.kind == "item" else author_record(root)
        except UnmappableRecord as error:
            reason = str(error)
            self.reasons[reason] += 1
            record = {"kind": "unmappable", "entity": "item" if self.kind == "item" else "author",
                      "ordinal": self.ordinal, "reason": reason}
        self.counts[record["kind"]] += 1
        self.emit(record)

    def read(self, source):
        bytes_read = 0
        for chunk in iter(lambda: source.read(READ_SIZE), b""):
            bytes_read += len(chunk)
            self.parser.Parse(chunk, False)
            # A comment or attribute can span reads without an element callback.
            if bytes_read - self.parser.CurrentByteIndex > MAX_RECORD_BYTES:
                raise InvalidExport("An XML token exceeds the archive limit.")
        self.parser.Parse(b"", True)
        if not self.has_channel or not self.has_version:
            raise InvalidExport("Expected a WXR version 1.2 channel.")
        return {"kind": "summary", "counts": dict(self.counts), "reasons": dict(self.reasons)}


def extract(source, source_key, output=None):
    def emit(value):
        if output is not None:
            output.write(json_line(value) + "\n")

    emit({"kind": "header", "format": "wordpress-archive", "version": 1, "source": source_key})
    summary = WxrReader(emit).read(source)
    emit(summary)
    return summary


def extract_to_file(source, source_key, destination):
    with NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=destination.parent) as output:
        summary = extract(source, source_key, output)
        output.flush()
        os.fsync(output.fileno())
        os.link(output.name, destination)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--source", required=True, help="Stable key for the WordPress source")
    parser.add_argument("--output", type=Path, help="New interchange file. Omit for counts only.")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", args.source):
        parser.error("--source requires 1 to 63 lower-case ASCII letters, digits, or hyphens")
    try:
        with args.export.open("rb") as source:
            summary = (extract_to_file(source, args.source, args.output)
                       if args.output is not None else extract(source, args.source))
    except expat.ExpatError as error:
        parser.exit(1, f"Invalid XML at line {error.lineno}, column {error.offset}.\n")
    except InvalidExport as error:
        parser.exit(1, f"{error}\n")
    except FileExistsError:
        parser.exit(1, "The output file already exists.\n")
    except OSError:
        parser.exit(1, "Could not read the export or write the interchange file.\n")
    print(json_line(summary))


if __name__ == "__main__":
    sys.exit(main())
