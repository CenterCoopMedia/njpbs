"""Extract the verified official runtime, then make a stable Windows ZIP."""

import pathlib
import sys
import zipfile

mode, source, target = sys.argv[1:]
source = pathlib.Path(source)
target = pathlib.Path(target)

if mode == "extract":
    with zipfile.ZipFile(source) as archive:
        for entry in archive.infolist():
            parts = pathlib.PurePosixPath(entry.filename).parts
            if parts[0] != "node-v22.23.5-win-x64" or ".." in parts:
                raise ValueError("Unexpected Node runtime archive path")
            relative = pathlib.Path(*parts[1:])
            destination = target / relative
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            elif parts[1:]:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as reader, destination.open("wb") as writer:
                    while chunk := reader.read(1024 * 1024):
                        writer.write(chunk)
elif mode == "zip":
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(source).as_posix())
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes(), compresslevel=6)
else:
    raise ValueError("Choose extract or zip")
