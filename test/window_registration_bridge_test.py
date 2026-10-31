import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import capybara_official_bridge as bridge


class WindowRegistrationBridgeTests(unittest.TestCase):
    def test_internal_registration_action_is_not_an_actor_native_tool(self):
        source = {"schemaVersion": "gaia2-window-obligation-source-v1", "enabled": True,
                  "executionId": "e-1", "sessionId": "s-1", "userRef": "u-1",
                  "sourceHash": "a" * 64, "span": None, "sceneStart": 0,
                  "parserReceiptHash": "b" * 64, "obligations": []}
        action = bridge._window_registration_action(source)
        self.assertEqual(action["canonicalName"], "CapybaraWindow__register")
        self.assertEqual(action["effect"], "read")
        self.assertNotIn(action["canonicalName"], {"AgentUserInterface__send_message_to_user", "AppAgent__expert_agent"})
        self.assertEqual(action["arguments"]["windowSource"], source)


if __name__ == "__main__":
    unittest.main()
