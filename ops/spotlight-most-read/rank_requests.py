#!/usr/bin/env python3
"""Produce aggregate article rankings from a complete day of retained requests."""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, quote, unquote, urlsplit


COMBINED = re.compile(
    rb'^(\S+) \S+ .*? \[(\d{2}/[A-Za-z]{3}/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\] "([^"]*)" (\d{3}) \S+ "[^"]*" "([^"]*)"'
)
REQUEST = re.compile(rb'^(\S+) (\S+) HTTP/[0-9.]+$')
ARTICLE = re.compile(r'^/[0-9]{4}/(?:0[1-9]|1[0-2])/[^/?#\\]{1,300}/?$')
BOT = re.compile(
    rb'bot|crawl|spider|slurp|scrapy|headless|lighthouse|monitor|uptime|python|'
    rb'curl|wget|facebookexternalhit|bytespider|preview|fetch', re.I
)
BROWSER = re.compile(rb'Chrome/|Firefox/|Safari/|Edg/|AppleWebKit/', re.I)
MONTHS = {name: i for i, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1
)}


def timestamp(value):
    text = value.decode('ascii')
    # The deployed Nginx log uses UTC. Reject another offset rather than shift it.
    if len(text) != 26 or text[21:] != '+0000':
        raise ValueError('Expected a UTC Nginx timestamp')
    return datetime(int(text[7:11]), MONTHS[text[3:6]], int(text[:2]),
                    int(text[12:14]), int(text[15:17]), int(text[18:20]), tzinfo=timezone.utc)


def article_path(target):
    try:
        value = target.decode('utf-8')
        parts = urlsplit(value)
        path = unquote(parts.path, errors='strict').lower()
    except (UnicodeError, ValueError):
        return None
    if parts.scheme or parts.netloc or not ARTICLE.fullmatch(path):
        return None
    if any(key in parse_qs(parts.query, keep_blank_values=True)
           for key in ('preview', 'preview_id', 'preview_nonce', 'date_preview')):
        return None
    normalized = quote(path.rstrip('/') + '/', safe='/-._~')
    # Apply the importer's segment bound after encoding can expand the path.
    return normalized if ARTICLE.fullmatch(normalized) else None


def rank(log, end, max_bytes=512 * 1024 * 1024):
    start = end - timedelta(days=1)
    counts, totals = Counter(), Counter()
    first = last = None
    salt = os.urandom(32)
    seen = set()
    scanned_bytes = 0
    # The previous uncompressed log supplies records across rotation.
    sources = [log]
    previous = log.with_name(log.name + '.1')
    if previous.is_file():
        sources.append(previous)
    for source in sources:
        with source.open('rb') as stream:
            source_first = None
            size = os.fstat(stream.fileno()).st_size
            offset = max(0, size - max_bytes)
            stream.seek(offset)
            if offset:
                stream.readline()
            scan_start = stream.tell()
            while stream.tell() < size:
                line = stream.readline()
                if not line.endswith(b'\n') or stream.tell() > size:
                    break
                totals['lines'] += 1
                match = COMBINED.match(line)
                if not match:
                    totals['unparsed'] += 1
                    continue
                client, stamp, request, status, agent = match.groups()
                try:
                    observed = timestamp(stamp)
                except (ValueError, KeyError):
                    totals['unparsed'] += 1
                    continue
                first = observed if first is None else min(first, observed)
                source_first = observed if source_first is None else min(source_first, observed)
                last = observed if last is None else max(last, observed)
                if not start <= observed < end or status not in (b'200', b'304'):
                    continue
                parsed_request = REQUEST.fullmatch(request)
                if not parsed_request:
                    totals['invalid_requests'] += 1
                    continue
                method, target = parsed_request.groups()
                if method != b'GET':
                    continue
                path = article_path(target)
                if path is None:
                    continue
                totals['successful_article_requests'] += 1
                if not agent.startswith(b'Mozilla/') or not BROWSER.search(agent) or BOT.search(agent):
                    totals['excluded_clients'] += 1
                    continue
                try:
                    address = ipaddress.ip_address(client.decode('ascii'))
                except (UnicodeDecodeError, ValueError):
                    totals['invalid_clients'] += 1
                    continue
                network = address.packed[:8] if address.version == 6 else address.packed
                client_key = hashlib.blake2b(network, key=salt, digest_size=16).digest()
                visit = (client_key, path, int(observed.timestamp()) // 3600)
                if visit in seen:
                    totals['excluded_repeat_requests'] += 1
                    continue
                seen.add(visit)
                counts[path] += 1
                totals['included_requests'] += 1
            if offset and source_first is not None and source_first > start:
                raise ValueError('Truncated log tail would omit part of the reporting day')
        scanned_bytes += size - scan_start
        if first is not None and first <= start:
            break
    if first is None or first > start or last < end:
        raise ValueError('Retained log tail does not cover the complete reporting day')
    if totals['unparsed'] > max(10, totals['lines'] // 100):
        raise ValueError('Too many log records have an unsupported format')
    rows = sorted(counts.items(), key=lambda row: (-row[1], row[0]))
    return {
        'version': 1, 'source': 'server-requests',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'window_start': start.isoformat(), 'window_end': end.isoformat(),
        'complete': True, 'scanned_bytes': scanned_bytes, 'totals': dict(totals),
        'articles': [{'path': path, 'requests': count} for path, count in rows[:200] if count >= 3],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('log', type=Path)
    parser.add_argument('--end', help='UTC ISO reporting end; defaults to the start of this hour')
    args = parser.parse_args()
    try:
        end = datetime.fromisoformat(args.end) if args.end else datetime.now(timezone.utc).replace(
            minute=0, second=0, microsecond=0)
        if end.tzinfo is None or end.utcoffset() != timedelta(0):
            raise ValueError('Reporting end must use UTC')
        print(json.dumps(rank(args.log, end), separators=(',', ':')))
    except (OSError, ValueError, KeyError) as error:
        print('Ranking refresh refused: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
