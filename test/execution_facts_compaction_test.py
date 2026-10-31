"""Actual compactor protects source USER occurrences and deterministic facts."""
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / '.official-python')]
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
import capybara_official_bridge as bridge
from gaia2_runtime_hooks import HookProtocolError


def group(i):
    return [dict(role='assistant', content='', tool_calls=[dict(id=str(i), type='function', function=dict(name='App__read', arguments='{}'))]),
            dict(role='tool', name='App__read', tool_call_id=str(i), content='{"records":[]}')]


class CompactionTests(unittest.TestCase):
    def compact(self, users, extra_user=None):
        prefix = [dict(role='system', content='Native runtime'), dict(role='system', content='Current context')]
        facts = dict(role='system', content=json.dumps({'schemaVersion': 'gaia2-execution-facts-v1', 'deletionCalls': 8}))
        messages = prefix + [users[0]] + sum([group(i) for i in range(10)], []) + users[1:]
        for i in range(10, 30):
            messages += group(i)
            if extra_user: messages.append(extra_user)
        messages.append(facts)
        result, receipt = bridge._compact_model_input(messages, [], max_messages=18,
            protected_context=[facts], protected_user_messages=users)
        self.assertTrue(receipt['compacted'])
        self.assertIn(facts, result)
        bridge._validate_provider_tool_pairs(result)
        self.assertFalse(any(m.get('tool_call_id') == '0' for m in result))
        return result

    def test_latest_actual_user_survives_many_later_tool_groups(self):
        users = [dict(role='user', content='Original request'), dict(role='user', content='Changed user instruction')]
        result = self.compact(users)
        self.assertEqual([m for m in result if m['role'] == 'user'], users)

    def test_environment_notice_is_not_substituted_for_current_user(self):
        users = [dict(role='user', content='Original'), dict(role='user', content='New user task')]
        result = self.compact(users, dict(role='user', content='Environmental observation, not authorization'))
        self.assertIn(users[1], result)
        self.assertLess(result.index(users[0]), result.index(users[1]))

    def test_equal_text_user_occurrences_are_not_deduplicated(self):
        result = self.compact([dict(role='user', content='Same text'), dict(role='user', content='Same text')])
        self.assertEqual(sum(m['role'] == 'user' and m['content'] == 'Same text' for m in result), 2)

    def test_unbound_protected_user_is_not_silently_invented(self):
        with self.assertRaises(HookProtocolError):
            bridge._compact_model_input([dict(role='system', content='s'), dict(role='user', content='actual')], [],
                protected_user_messages=[dict(role='user', content='not actually arrived')])


if __name__ == '__main__':
    unittest.main()
