#!/usr/bin/env python3
"""Static UE sample inspection. Reports evidence; never asserts runtime compatibility."""
import argparse
import json
import re
from pathlib import Path


def inspect(root: Path) -> dict:
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Project directory not found: {root}")
    projects = sorted(p for p in root.rglob("*.uproject") if "Intermediate" not in p.parts)
    result = {"project_root": str(root), "status": "static_only",
              "projects": [], "plugins": [], "gamemode_references": [],
              "checks": [], "limitations": ["No Unreal Editor execution", "No hardware tracking or MR test"]}
    for project in projects:
        try:
            data = json.loads(project.read_text(encoding="utf-8-sig"))
        except (UnicodeError, ValueError) as exc:
            result["checks"].append({"check": "uproject_json", "status": "failed", "detail": f"{project.name}: {exc}"})
            continue
        plugins = data.get("Plugins", [])
        result["projects"].append({"path": str(project.relative_to(root)),
                                   "engine_association": data.get("EngineAssociation", "unknown"),
                                   "plugins": plugins if isinstance(plugins, list) else []})
        hand = next((p for p in plugins if isinstance(p, dict) and p.get("Name") == "OpenXRHandTracking"), None) if isinstance(plugins, list) else None
        result["checks"].append({"check": "OpenXRHandTracking_explicitly_enabled",
                                 "status": "present" if hand and hand.get("Enabled") is True else "unconfirmed",
                                 "detail": "Descriptor only; not a device test"})
    for path in sorted(root.rglob("*.uplugin")):
        if any(x in path.parts for x in ("Intermediate", "Saved")):
            continue
        if "vive" not in path.name.lower() and "openxr" not in path.name.lower():
            continue
        try:
            info = json.loads(path.read_text(encoding="utf-8-sig"))
            result["plugins"].append({"path": str(path.relative_to(root)), "name": path.stem,
                                      "version_name": info.get("VersionName", "unknown"),
                                      "version_number": info.get("Version", "unknown")})
        except (UnicodeError, ValueError) as exc:
            result["plugins"].append({"path": str(path.relative_to(root)), "error": str(exc)})
    for config in sorted((root / "Config").glob("Default*.ini")) if (root / "Config").is_dir() else []:
        text = config.read_text(encoding="utf-8-sig", errors="replace")
        for line in text.splitlines():
            if "DefaultGameMode" not in line or line.lstrip().startswith(";"):
                continue
            ref = line.split("=", 1)[-1].strip()
            match = re.search(r"/Game/([A-Za-z0-9_/\-]+)", ref)
            candidates = []
            present = "unknown"
            if match:
                asset = match.group(1).split(".")[0].removesuffix("_C")
                candidates = [f"Content/{asset}.uasset", f"Content/{asset}.umap"]
                present = "present" if any((root / c).is_file() for c in candidates) else "missing"
            result["gamemode_references"].append({"config": str(config.relative_to(root)),
                                                    "reference": ref, "candidate_assets": candidates,
                                                    "static_asset_status": present})
    result["checks"].append({"check": "uproject_found", "status": "present" if result["projects"] else "missing"})
    result["checks"].append({"check": "MR_passthrough_and_face_tracking_together", "status": "not_tested",
                             "detail": "Requires supported SDK, UE, streaming mode and physical headset"})
    result["checks"].append({"check": "metahuman_loaded", "status": "not_tested",
                             "detail": "Cannot be established from project descriptor"})
    result["file_count"] = sum(1 for p in root.rglob("*") if p.is_file() and ".git" not in p.parts)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = inspect(args.project_root)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")


if __name__ == "__main__":
    main()
