import json
import sys
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))

from capybara_official_bridge import _compact_provider_tool_schema  # noqa: E402
from phase7_search_protocol_probe import _read_first_scenario  # noqa: E402


class SearchProtocolProbeFixtureTest(unittest.TestCase):
    def test_compacts_only_system_tool_descriptions(self):
        system = {"function": {"name": "SystemApp__wait_for_notification", "description": "duplicate prose", "parameters": {}}}
        other = {"function": {"name": "Files__open", "description": "keep", "parameters": {}}}
        _compact_provider_tool_schema(type("Tool", (), {"class_name": "SystemApp", "func_name": "wait_for_notification"})(), system)
        _compact_provider_tool_schema(type("Tool", (), {"class_name": "Files", "func_name": "open"})(), other)
        self.assertNotIn("description", system["function"])
        self.assertEqual(other["function"]["description"], "keep")

    def test_reads_current_official_data_column(self):
        scenario = {"metadata": {"definition": {"scenario_id": "current"}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "current.parquet"
            pq.write_table(pa.table({"id": ["1"], "data": [json.dumps(scenario)]}), path)
            self.assertEqual(json.loads(_read_first_scenario(str(path))), scenario)

    def test_keeps_legacy_scenario_column_compatible(self):
        scenario = {"metadata": {"definition": {"scenario_id": "legacy"}}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.parquet"
            pq.write_table(pa.table({"scenario": [json.dumps(scenario)]}), path)
            self.assertEqual(json.loads(_read_first_scenario(str(path))), scenario)

    def test_rejects_missing_scenario_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.parquet"
            pq.write_table(pa.table({"id": ["1"]}), path)
            with self.assertRaisesRegex(ValueError, "scenario or data"):
                _read_first_scenario(str(path))


if __name__ == "__main__":
    unittest.main()
