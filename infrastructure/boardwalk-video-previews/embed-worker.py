#!/usr/bin/env python3
"""Keep the inline Lambda source synchronized with the reviewed worker file."""
import json
import sys
from pathlib import Path


def main():
    folder = Path(__file__).resolve().parent
    path = folder / "template-v1.json"
    template = json.loads(path.read_text())
    code = template["Resources"]["PreviewHelper"]["Properties"]["Code"]
    source = (folder / "worker.py").read_text()
    if "--check" in sys.argv:
        if code["ZipFile"] != source:
            raise SystemExit("Inline worker is stale; run embed-worker.py")
        return
    code["ZipFile"] = source
    path.write_text(json.dumps(template, indent=2) + "\n")


if __name__ == "__main__":
    main()
