#!/usr/bin/env python3
"""Copy a legally obtained UE sample to a new clean directory and SHA-256 verify it."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

SKIP = {".git", "Intermediate", "Saved", "DerivedDataCache", ".vs", "__pycache__"}


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def prepare(source: Path, destination: Path) -> dict:
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    if not source.is_dir():
        raise ValueError("Source sample does not exist")
    if destination == source or source in destination.parents or destination in source.parents:
        raise ValueError("Source/destination must be separate non-nested directories")
    if destination.exists():
        raise FileExistsError("Destination already exists; refusing to overwrite")
    if not any(p.suffix == ".uproject" for p in source.iterdir() if p.is_file()):
        raise ValueError("Source root needs a .uproject descriptor")
    items = [p for p in sorted(source.rglob("*")) if p.is_file() and not SKIP.intersection(p.relative_to(source).parts)]
    if not items:
        raise ValueError("No source files")
    try:
        for item in items:
            target = destination / item.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            if digest(item) != digest(target):
                raise OSError(f"Hash mismatch: {item}")
        manifest = {"status": "offline_copy_verified", "source": str(source),
                    "destination": str(destination), "sdk_upgrade": "not_performed",
                    "unreal_build": "not_run", "files": [
                        {"path": str(p.relative_to(source)).replace("\\", "/"),
                         "sha256": digest(p), "size_bytes": p.stat().st_size} for p in items]}
        (destination / "rove_reference_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return manifest
    except BaseException:
        if destination.exists():
            shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    manifest = prepare(args.source, args.destination)
    print(f"Verified {len(manifest['files'])} copied files. No UE build or SDK upgrade performed.")


if __name__ == "__main__":
    main()
