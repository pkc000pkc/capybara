"""Controlled official-entry receipt guard; no provider or Scenario execution."""

import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
import capybara_official_bridge as bridge


class OfficialEntryHandshakeTests(unittest.TestCase):
    def receipt(self):
        root = Path(tempfile.mkdtemp(prefix="gaia2-entry-"))
        output = root / "output"
        entry_dir = output / "official-entry"
        entry_dir.mkdir(parents=True)
        value = {
            "schemaVersion": "gaia2-official-entry-handshake-v1",
            "runId": "run",
            "manifestHash": "a" * 64,
            "executionId": "exec",
            "sessionId": "session",
            "scenarioId": "scenario",
            "scenarioVersion": "are_simulation_v1",
            "scenarioHash": "b" * 64,
            "config": "execution",
            "runNumber": 1,
            "attemptIndex": 1,
            "correctionOrdinal": 0,
            "phase": "standard",
            "launcherProcessId": 1,
        }
        raw = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        path = entry_dir / "run-manifest.json"
        path.write_bytes(raw)
        event = output / "runtime-events.jsonl"
        # A fresh official child has not written its first event yet.
        return root, path, event, hashlib.sha256(raw).hexdigest()

    def test_required_guard_verifies_exact_bytes_and_scope(self):
        root, path, event, sha = self.receipt()
        env = {
            "GAIA2_OFFICIAL_ENTRY_REQUIRED": "1",
            "GAIA2_OFFICIAL_ENTRY_PATH": str(path),
            "GAIA2_OFFICIAL_ENTRY_SHA256": sha,
            "GAIA2_RUNTIME_EVENT_FILE": str(event),
            "GAIA2_EXECUTION_ID": "exec",
            "GAIA2_SESSION_ID": "session",
        }
        try:
            with patch.dict(os.environ, env, clear=False):
                result = bridge._official_entry_handshake("scenario")
            self.assertEqual(result["executionId"], "exec")
            self.assertEqual(result["entrySha256"], sha)
        finally:
            import shutil
            shutil.rmtree(root, ignore_errors=True)

    def test_guard_rejects_tamper_and_foreign_scenario(self):
        root, path, event, sha = self.receipt()
        env = {
            "GAIA2_OFFICIAL_ENTRY_REQUIRED": "1",
            "GAIA2_OFFICIAL_ENTRY_PATH": str(path),
            "GAIA2_OFFICIAL_ENTRY_SHA256": sha,
            "GAIA2_RUNTIME_EVENT_FILE": str(event),
            "GAIA2_EXECUTION_ID": "exec",
            "GAIA2_SESSION_ID": "session",
        }
        try:
            with patch.dict(os.environ, env, clear=False):
                with self.assertRaisesRegex(Exception, "official_entry_handshake_invalid"):
                    bridge._official_entry_handshake("foreign-scenario")
                path.write_bytes(path.read_bytes() + b"x")
                with self.assertRaisesRegex(Exception, "official_entry_handshake_invalid"):
                    bridge._official_entry_handshake("scenario")
        finally:
            import shutil
            shutil.rmtree(root, ignore_errors=True)

    def test_default_without_required_entry_does_not_attest(self):
        with patch.dict(os.environ, {"GAIA2_OFFICIAL_ENTRY_REQUIRED": "0"}, clear=False):
            self.assertIsNone(bridge._official_entry_handshake("scenario"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
