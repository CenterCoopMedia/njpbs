"""Compare recovered files with the provider snapshot's SHA-256 pins."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = json.loads((ROOT / "config/recovered-service-hashes.json").read_text())
    failures = []
    for service in manifest["services"]:
        for item in service["files"]:
            path = ROOT / item["path"]
            if not path.is_file():
                failures.append(item["path"] + ": Missing source")
                continue
            content = path.read_bytes()
            if (hashlib.sha256(content).hexdigest() != item["committed_sha256"]
                    or len(content) != item["committed_bytes"]):
                failures.append(item["path"] + ": Source differs from recovery pin")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Recovered source hashes match the recorded provider recovery snapshot.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
