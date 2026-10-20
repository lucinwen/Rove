#!/usr/bin/env python3
"""Explicit Unreal execution launcher. Default is a plan only, not an attempted build."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def plan(engine_root: Path, project: Path, target: str, mode: str, output: Path) -> dict:
    engine_root = engine_root.expanduser().resolve()
    project = project.expanduser().resolve()
    output = output.expanduser().resolve()
    version_file = engine_root / "Engine" / "Build" / "Build.version"
    engine_version = None
    if version_file.is_file():
        info = json.loads(version_file.read_text(encoding="utf-8-sig"))
        engine_version = {key: info.get(key) for key in ("MajorVersion", "MinorVersion", "PatchVersion", "Changelist")}
    if mode == "editor":
        tool = engine_root / "Engine" / "Build" / "BatchFiles" / "Build.bat"
        command = [str(tool), f"{target}Editor", "Win64", "Development",
                   f"-Project={project}", "-WaitMutex"]
    else:
        tool = engine_root / "Engine" / "Build" / "BatchFiles" / "RunUAT.bat"
        command = [str(tool), "BuildCookRun", f"-project={project}", "-noP4",
                   "-platform=Win64", "-clientconfig=Development", "-build", "-cook",
                   "-stage", "-package", "-pak", "-archive",
                   f"-archivedirectory={output / 'package'}"]
    return {"status": "planned_not_executed", "mode": mode, "project": str(project),
            "project_exists": project.is_file(), "tool_exists": tool.is_file(),
            "engine_version": engine_version, "command": command,
            "limitations": ["Editor and hardware results require actual Windows / UE workstation"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--target", required=True, help="UE C++ target name (not guessed)")
    parser.add_argument("--mode", choices=("editor", "package"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--execute", action="store_true", help="Opt in to run on Windows")
    args = parser.parse_args()
    report = plan(args.engine_root, args.project, args.target, args.mode, args.out)
    args.out.mkdir(parents=True, exist_ok=True)
    if args.execute:
        if os.name != "nt":
            report["status"] = "blocked_non_windows"
        elif not report["project_exists"] or not report["tool_exists"] or not report["engine_version"]:
            report["status"] = "blocked_missing_dependencies"
        else:
            with (args.out / "build.log").open("w", encoding="utf-8") as log:
                try:
                    finished = subprocess.run(report["command"], stdout=log, stderr=subprocess.STDOUT,
                                              check=False, timeout=7200)
                    report["exit_code"] = finished.returncode
                    report["status"] = "process_exit_zero" if finished.returncode == 0 else "process_failed"
                except subprocess.TimeoutExpired:
                    report["status"] = "process_timeout"
                except OSError as exc:
                    report["status"] = "process_launch_error"
                    report["error"] = str(exc)
    (args.out / "build-evidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "evidence": str(args.out / "build-evidence.json")}, ensure_ascii=False))
    if args.execute and report["status"] != "process_exit_zero":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
