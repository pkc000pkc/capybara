"""Execution-history projection: no model, network, native calls or writes."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from gaia2_execution_facts import build_execution_facts


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def row(i, tool='Calendar__delete_calendar_event', resource='Calendar', status='succeeded', confirmed=True):
    item = dict(actionId=str(i), canonicalName=tool, resourceKey=resource,
                mutationKey=digest('args-' + str(i)), resultHash=digest('result-' + str(i)),
                status=status, effect='write', executed=True, complete=status != 'unknown')
    if confirmed and status == 'succeeded':
        item['mutationReceipt'] = dict(schemaVersion='gaia2-mutation-evidence-v1', kind='mutation_confirmed',
            confirmation='confirmed_applied', resourceKey=resource,
            callRef=dict(actionId=str(i), canonicalName=tool, queryHash=item['mutationKey'], resultHash=item['resultHash']))
    return item


def message(item, body='{"status":"unknown","businessCompletion":true}'):
    fields = {key: copy.deepcopy(item[key]) for key in ('status', 'effect', 'canonicalName', 'resourceKey', 'executed', 'complete') if key in item}
    return dict(role='tool', name=item.get('canonicalName', 'public_alias'), tool_call_id=item['actionId'],
                executionOutcome=fields, content=body)


def state(actions):
    return dict(actions=actions, unknown=[copy.deepcopy(r) for r in actions if r['status'] == 'unknown'], blocked=[])


class ExecutionFactsTests(unittest.TestCase):
    def group(self, facts, name):
        return next(g for g in facts['groups'] if g['tool'] == name)

    def test_old_eight_deletes_survive_many_new_mutations(self):
        old = [row('d' + str(i)) for i in range(8)]
        newer = [row('e' + str(i), 'EmailClientV2__send_email', 'Emails') for i in range(20)]
        newer.append(row('new-event', 'Calendar__add_calendar_event'))
        facts = build_execution_facts([message(r) for r in old + newer], state(old + newer))
        self.assertEqual(facts['totalCalls'], 29)
        self.assertEqual(facts['counts']['succeeded'], 29)
        self.assertEqual(self.group(facts, 'Calendar__delete_calendar_event')['counts']['confirmed_applied'], 8)
        self.assertFalse(facts['historyIsCurrentState'])
        self.assertEqual(facts['businessCompletion'], 'not_inferred')

    def test_all_three_domains_and_unconfirmed_success_are_distinct(self):
        rows = [row('c', 'Contacts__edit_contact', 'Contacts'), row('m', 'EmailClientV2__reply_to_email', 'Emails'),
                row('x', 'SyntheticLedger__write', 'SyntheticLedger', confirmed=False)]
        facts = build_execution_facts([message(r, 'false') for r in rows], state(rows))
        self.assertEqual(facts['counts']['succeeded'], 3)
        self.assertEqual(facts['counts']['confirmed_applied'], 2)

    def test_action_message_and_replayed_callback_count_once(self):
        r = row('same')
        facts = build_execution_facts([message(r), message(r)], state([r, copy.deepcopy(r)]))
        self.assertEqual(facts['totalCalls'], 1)
        self.assertEqual(facts['counts']['confirmed_applied'], 1)

    def test_failed_unknown_cancelled_never_become_success(self):
        failed = row('bad', status='failed_before_execution')
        unknown = row('uncertain', status='unknown')
        cancelled = dict(actionId='tail', status='cancelled', effect='unknown', executed=False, complete=True)
        facts = build_execution_facts([message(failed), message(unknown), message(cancelled)], state([failed, unknown]))
        self.assertEqual(facts['totalCalls'], 3)
        self.assertEqual([facts['counts'][k] for k in ('failed', 'unknown', 'not_executed')], [1, 1, 1])
        self.assertEqual(facts['counts']['succeeded'], 0)

    def test_conflicting_same_call_stays_unsettled(self):
        r = row('conflict')
        contradictory = message(r)
        contradictory['executionOutcome']['status'] = 'unknown'
        contradictory['executionOutcome']['complete'] = False
        facts = build_execution_facts([contradictory], state([r]))
        self.assertEqual(facts['counts']['unsettled'], 1)
        self.assertEqual(facts['counts']['confirmed_applied'], 0)

    def test_receipt_binding_mismatch_cannot_claim_applied(self):
        for field in ('actionId', 'canonicalName', 'queryHash', 'resultHash'):
            r = row('forged'); r['mutationReceipt']['callRef'][field] = 'wrong'
            facts = build_execution_facts([], state([r]))
            self.assertEqual(facts['counts']['confirmed_applied'], 0)
            self.assertIn('receipt_binding_mismatch', str(facts['diagnostics']))

    def test_unknown_not_cleared_by_readback_or_other_success(self):
        u = row('unknown', status='unknown'); u['readBackObserved'] = True
        done = row('different', 'Calendar__add_calendar_event')
        facts = build_execution_facts([message(u), message(done)], state([u, done]))
        self.assertEqual(facts['counts']['unknown'], 1)
        self.assertEqual(facts['counts']['succeeded'], 1)

    def test_business_body_is_not_execution_authority(self):
        r = row('ok')
        for body in ('false', '{"status":"failed"}', 'SECRET_TOKEN_DO_NOT_COPY'):
            facts = build_execution_facts([message(r, body)], state([r]))
            self.assertEqual(facts['counts']['confirmed_applied'], 1)
            self.assertNotIn('SECRET_TOKEN', json.dumps(facts))

    def test_read_and_local_control_without_metadata_are_ignored(self):
        facts = build_execution_facts([dict(role='tool', tool_call_id='local', content='bad'),
            dict(role='tool', tool_call_id='read', executionOutcome=dict(status='succeeded', effect='read', executed=True))])
        self.assertEqual(facts['totalCalls'], 0)

    def test_new_user_does_not_rewrite_historical_success(self):
        r = row('old'); r['currentUserRef'] = 'old-user'
        messages = [message(r), dict(role='user', id='new-user', content='A different request')]
        self.assertEqual(build_execution_facts(messages, state([r]))['counts']['confirmed_applied'], 1)

    def test_many_groups_preserve_full_totals_and_bound_bytes(self):
        rows = [row(str(i), 'NativeApp' + str(i) + '__write', 'Resource' + str(i)) for i in range(600)]
        facts = build_execution_facts([], state(rows))
        self.assertEqual(facts['counts']['succeeded'], 600)
        self.assertGreater(facts['omittedGroups'], 0)
        self.assertLessEqual(len(json.dumps(facts, ensure_ascii=False).encode()), 8192)

    def test_long_or_unicode_labels_never_silently_truncate(self):
        r = row('unknown-' + '界' * 300, 'App__' + '界' * 300, status='unknown')
        facts = build_execution_facts([], state([r]))
        self.assertEqual(facts['counts']['unknown'], 1)
        self.assertEqual(facts['omittedGroups'], 1)
        self.assertEqual(facts['riskDetails'], [])

    def test_legacy_rows_derive_only_bound_receipt_tool(self):
        r = row('legacy'); r.pop('canonicalName'); r.pop('effect'); r.pop('executed'); r.pop('complete')
        facts = build_execution_facts([], state([r]))
        self.assertEqual(self.group(facts, 'Calendar__delete_calendar_event')['counts']['confirmed_applied'], 1)

    def test_inputs_never_mutated_and_bad_input_not_a_gate(self):
        r = row('stable'); messages = [message(r)]; ledger = state([r]); before = copy.deepcopy((messages, ledger))
        build_execution_facts(messages, ledger)
        self.assertEqual((messages, ledger), before)
        self.assertEqual(build_execution_facts(None, None)['totalCalls'], 0)

    def test_projection_error_is_unavailable_not_evidence_of_zero_activity(self):
        with patch('gaia2_execution_facts._project', side_effect=ValueError('controlled projection failure')):
            facts = build_execution_facts([], state([row('real-call')]))
        self.assertFalse(facts['projectionComplete'])
        self.assertEqual(facts['diagnostics'], [{'code': 'projection_error', 'count': 1}])


if __name__ == '__main__':
    unittest.main()
