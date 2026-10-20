"""Offline regression tests; no UE execution or hardware is asserted."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def mod(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preflight = mod("preflight")
prepare = mod("prepare_reference")
check = mod("run_ue_check")


class G1OfflineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.src = self.root / "official"
        self.src.mkdir()
        (self.src / "Sample.uproject").write_text(
            json.dumps({"EngineAssociation": "5.3", "Plugins": [{"Name": "OpenXRHandTracking", "Enabled": True}]}))
        (self.src / "Config").mkdir()
        (self.src / "Config" / "DefaultEngine.ini").write_text(
            '[/Script/EngineSettings.GameMapsSettings]\nGlobalDefaultGameMode=/Game/MissingMode.MissingMode_C\n')
        (self.src / "Plugins" / "ViveOpenXR").mkdir(parents=True)
        (self.src / "Plugins" / "ViveOpenXR" / "ViveOpenXR.uplugin").write_text(
            json.dumps({"VersionName": "2.1.0", "Version": 1}))

    def test_preflight_does_not_claim_runtime_success(self):
        result = preflight.inspect(self.src)
        self.assertEqual(result["status"], "static_only")
        self.assertIn("No Unreal Editor execution", result["limitations"])

    def test_preflight_records_version_and_engine(self):
        result = preflight.inspect(self.src)
        self.assertEqual(result["plugins"][0]["version_name"], "2.1.0")
        self.assertEqual(result["projects"][0]["engine_association"], "5.3")

    def test_preflight_records_missing_gamemode(self):
        self.assertEqual(preflight.inspect(self.src)["gamemode_references"][0]["static_asset_status"], "missing")

    def test_preflight_checks_explicit_handtracking(self):
        self.assertEqual(preflight.inspect(self.src)["checks"][0]["status"], "present")

    def test_preflight_handles_bad_json(self):
        (self.src / "Sample.uproject").write_text("{")
        result = preflight.inspect(self.src)
        self.assertEqual(result["checks"][0]["status"], "failed")

    def test_copy_preserves_hashes(self):
        dest = self.root / "copied"
        report = prepare.prepare(self.src, dest)
        self.assertEqual(report["sdk_upgrade"], "not_performed")
        for record in report["files"]:
            self.assertEqual(prepare.digest(dest / record["path"]), record["sha256"])

    def test_copy_never_overwrites(self):
        dst = self.root / "copied"
        prepare.prepare(self.src, dst)
        with self.assertRaises(FileExistsError):
            prepare.prepare(self.src, dst)

    def test_copy_rejects_nested(self):
        with self.assertRaises(ValueError):
            prepare.prepare(self.src, self.src / "nested")

    def test_copy_excludes_cache(self):
        (self.src / "Saved").mkdir()
        (self.src / "Saved" / "private.log").write_text("secret")
        result = prepare.prepare(self.src, self.root / "copy2")
        self.assertNotIn("Saved/private.log", [f["path"] for f in result["files"]])

    def test_plan_does_not_run(self):
        result = check.plan(self.root / "UE_5.3", self.src / "Sample.uproject", "Sample", "editor", self.root / "out")
        self.assertEqual(result["status"], "planned_not_executed")
        self.assertFalse(result["tool_exists"])

    def test_plan_requires_explicit_target(self):
        result = check.plan(self.root / "UE", self.src / "Sample.uproject", "CustomGame", "editor", self.root / "out")
        self.assertIn("CustomGameEditor", result["command"])

    def test_package_has_output_folder(self):
        result = check.plan(self.root / "UE", self.src / "Sample.uproject", "Sample", "package", self.root / "out")
        self.assertIn("-archive", result["command"])
        self.assertTrue(any(arg.startswith("-archivedirectory=") for arg in result["command"]))


if __name__ == "__main__":
    unittest.main()
