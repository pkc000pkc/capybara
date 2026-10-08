import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

test('official argument preflight binds actual AppTools and roundtrips pinned ARE values without invoking tools or events', { timeout: 60_000 }, () => {
  const result = spawnSync(python, ['-B', '-c', String.raw`
import copy, inspect, json, math, socket, sys, unittest
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

network_attempts = []
def forbidden_network(*args, **kwargs):
    network_attempts.append(True)
    raise AssertionError('Network must not be used')
socket.socket.connect = forbidden_network
socket.create_connection = forbidden_network

sys.path.insert(0, str(Path('scripts').resolve()))
from gaia2_argument_preflight import safe_json_value, validate_tool_arguments
from are.simulation.data_handler.exporter import JsonScenarioExporter
from are.simulation.scenarios.scenario import Scenario
from are.simulation.tool_utils import AppTool, AppToolArg
from are.simulation.types import Event, EventRegisterer

SCHEMA = 'gaia2-official-argument-preflight-v1'
REASONS = {'no_callable_tool', 'argument_binding_failed', 'unsafe_json_argument', 'official_argument_not_roundtrippable'}
execution_attempts = []
body_calls = []
stringification_attempts = []

def forbidden_execution(*args, **kwargs):
    execution_attempts.append(True)
    raise AssertionError('Preflight must never invoke a tool or construct an event')

def required(self, value):
    body_calls.append(True)

def empty_default(self, value: str = ''):
    body_calls.append(True)

def optional_default(self, value: str | None = None):
    body_calls.append(True)

def optional_required(self, value: str | None):
    body_calls.append(True)

def union_value(self, value: str | int | None):
    body_calls.append(True)

def primitive_defaults(self, zero=0, flag=False, items=[], mapping={}):
    body_calls.append(True)

def nonempty_default(self, value='unchanged'):
    body_calls.append(True)

def keyword_bucket(self, value='unchanged', **kwargs):
    body_calls.append(True)

def alternate_receiver(self_instance, value='unchanged'):
    body_calls.append(True)

def positional_bucket(self, *args):
    body_calls.append(True)

def free_function(value='unchanged'):
    body_calls.append(True)

class PrivateDefault:
    def __str__(self):
        stringification_attempts.append(True)
        raise ValueError('SECRET_CUSTOM_DEFAULT')

def with_default(default):
    def function(self, value=default):
        body_calls.append(True)
    return function

def tool(function, instance=True, args=None):
    return AppTool(class_name='PureBindingFixture', app_name='PureBindingFixture',
                   name='PureBindingFixture__function', function_description='Pure binding fixture.',
                   args=[] if args is None else args, function=function,
                   class_instance=object() if instance else None, write_operation=True)

class Tests(unittest.TestCase):
    def setUp(self):
        self.blockers = [patch.object(AppTool, '__call__', forbidden_execution),
                         patch.object(Event, 'from_function', forbidden_execution),
                         patch.object(EventRegisterer, 'capture_mode', forbidden_execution)]
        for blocker in self.blockers:
            blocker.start()
            self.addCleanup(blocker.stop)

    def tearDown(self):
        self.assertEqual(body_calls, [])
        self.assertEqual(execution_attempts, [])
        self.assertEqual(stringification_attempts, [])
        self.assertEqual(network_attempts, [])

    def check(self, app_tool, arguments, valid, reason=None, count=None):
        report = validate_tool_arguments(app_tool, arguments)
        self.assertIs(type(report), dict)
        self.assertEqual(set(report), {'schemaVersion', 'valid', 'reason', 'parameterCount'})
        self.assertEqual(report['schemaVersion'], SCHEMA)
        self.assertIs(type(report['valid']), bool)
        self.assertEqual(report['valid'], valid)
        self.assertEqual(report['reason'], reason)
        self.assertTrue(report['reason'] is None or report['reason'] in REASONS)
        self.assertTrue(report['parameterCount'] is None or (type(report['parameterCount']) is int and report['parameterCount'] >= 0))
        if valid:
            self.assertEqual(report['parameterCount'], count)
        self.assertNotIn('SECRET', json.dumps(report))
        return report

    def test_01_actual_locked_are_api_and_no_callable_rejected(self):
        self.assertEqual(version('meta-agents-research-environments'), '1.2.0')
        pinned = Path('.official-python/are').resolve()
        for api in (JsonScenarioExporter, Scenario, AppTool):
            self.assertTrue(Path(inspect.getfile(api)).resolve().is_relative_to(pinned))
        self.check(None, {}, False, 'no_callable_tool')
        self.check(tool(None), {}, False, 'no_callable_tool')
        invalid = tool(None)
        invalid.function = 'not-callable'
        self.check(invalid, {}, False, 'no_callable_tool')

    def test_02_explicit_and_omitted_empty_string_are_rejected(self):
        self.check(tool(required), {'value': ''}, False, 'official_argument_not_roundtrippable')
        arguments = {}
        self.check(tool(empty_default), arguments, False, 'official_argument_not_roundtrippable')
        self.assertEqual(arguments, {})

    def test_03_optional_empty_string_is_not_confused_with_none(self):
        self.check(tool(optional_default), {'value': ''}, False, 'official_argument_not_roundtrippable')
        self.check(tool(optional_default), {'value': None}, True, count=1)
        arguments = {}
        self.check(tool(optional_default), arguments, True, count=1)
        self.assertEqual(arguments, {})
        exported = JsonScenarioExporter.convert_action_args('value', None)
        self.assertIsNone(exported.value)
        self.assertIsNone(exported.value_type)
        self.assertIsNone(Scenario._parse_parameter_value(exported.value, exported.value_type))

    def test_04_missing_required_and_unrecognized_keywords_fail_binding(self):
        self.check(tool(required), {}, False, 'argument_binding_failed')
        self.check(tool(optional_required), {}, False, 'argument_binding_failed')
        self.check(tool(required), {'value': 'valid', 'unrecognized': 'SECRET_ARGUMENT'}, False, 'argument_binding_failed')
        self.check(tool(required), {'self': 'SECRET_RECEIVER', 'value': 'valid'}, False, 'argument_binding_failed')

    def test_05_valid_falsy_containers_whitespace_and_unicode_are_preserved(self):
        for label, value in [('zero', 0), ('false', False), ('list', []), ('dict', {}),
                             ('whitespace', ' '), ('unicode', '\u4e2d\u6587\U0001f9ea'),
                             ('float', -0.0), ('large_integer', 2**100)]:
            with self.subTest(case=label):
                arguments = {'value': value}
                before = copy.deepcopy(arguments)
                self.check(tool(required), arguments, True, count=1)
                self.assertTrue(arguments == before, 'Preflight changed supplied arguments')
                self.assertIs(type(arguments['value']), type(value))
        arguments = {}
        self.check(tool(primitive_defaults), arguments, True, count=4)
        self.assertEqual(arguments, {})

    def test_06_nested_empty_strings_and_none_are_legal_container_values(self):
        for value in (['', None, {'empty': '', 'none': None}], {'items': ['', None], 'nested': {'empty': ''}}):
            arguments = {'value': value}
            before = copy.deepcopy(arguments)
            self.check(tool(required), arguments, True, count=1)
            self.assertTrue(arguments == before, 'Preflight changed nested arguments')

    def test_07_union_uses_actual_exported_type_not_annotation(self):
        for label, value, value_type in [('string', 'seven', 'str'), ('integer', 7, 'int'), ('none', None, None)]:
            with self.subTest(case=label):
                self.check(tool(union_value), {'value': value}, True, count=1)
                exported = JsonScenarioExporter.convert_action_args('value', value)
                self.assertEqual(exported.value_type, value_type)
                restored = Scenario._parse_parameter_value(exported.value, exported.value_type)
                self.assertIs(type(restored), type(value))
                self.assertEqual(restored, value)
        self.check(tool(union_value), {'value': ''}, False, 'official_argument_not_roundtrippable')

    def test_08_metadata_defaults_cannot_hide_actual_signature_defaults(self):
        misleading = [AppToolArg(name='value', arg_type='str | None', description='Metadata only.', has_default=True, default=None)]
        self.check(tool(empty_default, args=misleading), {}, False, 'official_argument_not_roundtrippable')
        arguments = {}
        self.check(tool(nonempty_default), arguments, True, count=1)
        self.assertEqual(arguments, {})

    def test_09_keyword_bucket_is_checked_as_official_bound_dictionary(self):
        with patch.object(JsonScenarioExporter, 'convert_action_args', wraps=JsonScenarioExporter.convert_action_args) as exporter:
            self.check(tool(keyword_bucket), {'extra': '', 'other': None}, True, count=2)
            bound_values = {call.args[0]: call.args[1] for call in exporter.call_args_list}
            self.assertEqual(bound_values, {'value': 'unchanged', 'kwargs': {'extra': '', 'other': None}})
        self.check(tool(keyword_bucket), {}, True, count=2)
        self.check(tool(keyword_bucket), {'value': ''}, False, 'official_argument_not_roundtrippable')

    def test_10_receiver_and_positional_variadic_are_not_guessed_away(self):
        self.check(tool(alternate_receiver), {}, False, 'unsafe_json_argument')
        self.check(tool(positional_bucket), {}, False, 'unsafe_json_argument')
        self.check(tool(free_function, instance=False), {}, True, count=1)
        self.check(tool(free_function, instance=True), {}, False, 'unsafe_json_argument')

    def test_11_non_json_default_types_are_rejected_without_stringification(self):
        for label, value in [('tuple', ()), ('set', set()), ('bytes', b''), ('custom', PrivateDefault())]:
            with self.subTest(case=label):
                self.check(tool(with_default(value)), {}, False, 'unsafe_json_argument')
                self.assertIs(safe_json_value(value), False)

    def test_12_nonfinite_explicit_default_and_exponent_overflow_rejected(self):
        exponent = json.loads('{"value":1e400}')
        self.assertTrue(math.isinf(exponent['value']))
        self.check(tool(required), exponent, False, 'unsafe_json_argument')
        for label, value in [('nan', float('nan')), ('infinity', float('inf')), ('negative_infinity', float('-inf'))]:
            with self.subTest(case=label):
                self.check(tool(required), {'value': value}, False, 'unsafe_json_argument')
                self.check(tool(with_default(value)), {}, False, 'unsafe_json_argument')
                self.check(tool(required), {'value': {'nested': [value]}}, False, 'unsafe_json_argument')
                self.assertIs(safe_json_value(value), False)

    def test_13_lone_surrogates_and_non_string_dictionary_keys_rejected(self):
        for label, value in [('surrogate_value', '\ud800'), ('surrogate_key', {'\udfff': 'valid'}),
                             ('integer_key', {1: 'valid'}), ('boolean_key', {False: 'valid'})]:
            with self.subTest(case=label):
                self.check(tool(required), {'value': value}, False, 'unsafe_json_argument')
                self.assertIs(safe_json_value(value), False)

    def test_14_cycles_and_excessive_depth_fail_closed_without_recursion_escape(self):
        cyclic_list = []
        cyclic_list.append(cyclic_list)
        cyclic_dict = {}
        cyclic_dict['cycle'] = cyclic_dict
        deep = 'leaf'
        for unused in range(4096):
            deep = [deep]
        for label, value in [('list_cycle', cyclic_list), ('dict_cycle', cyclic_dict), ('depth', deep)]:
            with self.subTest(case=label):
                self.assertIs(safe_json_value(value), False)
                self.check(tool(required), {'value': value}, False, 'unsafe_json_argument')

    def test_15_shared_acyclic_references_and_plain_json_values_remain_safe(self):
        shared = ['', None]
        value = [shared, shared]
        self.assertIs(safe_json_value(value), True)
        self.check(tool(required), {'value': value}, True, count=1)
        for value in (None, '', ' ', 0, False, 1.5, 2**100, [], {}, {'nested': ['', None]}):
            self.assertIs(safe_json_value(value), True)

    def test_16_real_official_conversion_functions_are_used_not_a_parallel_parser(self):
        with patch.object(JsonScenarioExporter, 'convert_action_args', wraps=JsonScenarioExporter.convert_action_args) as exporter, \
             patch.object(Scenario, '_parse_parameter_value', wraps=Scenario._parse_parameter_value) as parser:
            self.check(tool(union_value), {'value': 9}, True, count=1)
            self.assertEqual(exporter.call_count, 1)
            self.assertEqual(exporter.call_args.args, ('value', 9))
            self.assertEqual(parser.call_count, 1)
            self.assertEqual(parser.call_args.args, ('9', 'int'))

    def test_17_rejection_reports_never_expose_parameter_names_values_or_exceptions(self):
        def private_parameter(self, SECRET_PARAMETER=''):
            body_calls.append(True)
        reports = [self.check(tool(private_parameter), {}, False, 'official_argument_not_roundtrippable'),
                   self.check(tool(required), {'value': {'SECRET_KEY': 'SECRET_PAYLOAD'}}, True, count=1),
                   self.check(tool(required), {'SECRET_UNKNOWN': 'SECRET_PAYLOAD'}, False, 'argument_binding_failed'),
                   self.check(tool(with_default(PrivateDefault())), {}, False, 'unsafe_json_argument')]
        with patch.object(JsonScenarioExporter, 'convert_action_args', side_effect=ValueError('SECRET_OFFICIAL_EXPORT')):
            reports.append(self.check(tool(required), {'value': 'valid'}, False, 'official_argument_not_roundtrippable'))
        with patch.object(Scenario, '_parse_parameter_value', side_effect=ValueError('SECRET_OFFICIAL_IMPORT')):
            reports.append(self.check(tool(required), {'value': 'valid'}, False, 'official_argument_not_roundtrippable'))
        self.assertNotIn('SECRET', json.dumps(reports))

    def test_18_no_models_tools_events_or_network_were_executed(self):
        self.assertEqual(body_calls, [])
        self.assertEqual(execution_attempts, [])
        self.assertEqual(network_attempts, [])
        self.assertEqual(stringification_attempts, [])

unittest.main(argv=['phase4_argument_preflight_test'], verbosity=2)
`], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error?.message || ''}`)
  assert.match(result.stderr, /Ran 18 tests/)
  assert.match(result.stderr, /OK/)
  assert.equal(`${result.stdout}\n${result.stderr}`.includes('SECRET'), false)
})
