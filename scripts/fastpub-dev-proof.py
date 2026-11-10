#!/usr/bin/env python3
"""Capture inherited credential pipe identities before starting Node."""

import argparse
import json
import os
from pathlib import Path
import stat
import sys


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--publish", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output")
    options = parser.parse_args()
    identities = {}
    try:
        for fd in ([3, 4] if options.publish else [3]):
            info = os.fstat(fd)
            if stat.S_ISFIFO(info.st_mode):
                kind = "fifo"
            elif stat.S_ISSOCK(info.st_mode):
                kind = "socket"
            else:
                raise ValueError()
            identities[str(fd)] = {
                "dev": str(info.st_dev), "ino": str(info.st_ino), "type": kind,
            }
            if not os.get_inheritable(fd):
                raise ValueError()
    except (OSError, ValueError):
        print(
            "Dev proof requires inherited credential pipes. Use the direct Python "
            "launcher with fd 3 and, for --publish, fd 4.", file=sys.stderr,
        )
        return 1
    environment = dict(os.environ)
    environment["NJPBS_DEV_PROOF_PIPE_IDENTITIES"] = json.dumps(identities)
    target = str(Path(__file__).resolve().with_suffix(".mjs"))
    try:
        os.execvpe("node", ["node", target, *sys.argv[1:]], environment)
    except OSError:
        print("Dev proof could not start Node. Check Node on PATH.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
