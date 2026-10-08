import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

test('pinned official exporter, reconstruct, HF schema, portable package and fail-closed audits are exercised offline', () => {
  const result = spawnSync(python, ['-c', String.raw`
import contextlib, hashlib, io, json, os, shutil, socket, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path('scripts').resolve()))
import phase2_official_adapter as adapter

network_attempts = []
def forbidden_network(*args, **kwargs):
    network_attempts.append(True)
    raise AssertionError('Network must not be used')
socket.socket.connect = forbidden_network
socket.create_connection = forbidden_network

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='gaia2-phase2-official-')
        cls.root = Path(cls.temporary.name).resolve()
        cls.package = cls.root / 'original'
        cls.package.mkdir()
        cls.traces = []
        for run in (1, 2, 3):
            path = cls.root / f'trace-{run}.json'
            report = adapter.fixture({'tracePath': str(path), 'scenarioId':'phase2_controlled', 'runNumber':run, 'config':'execution'})
            assert report['syntheticFixtureOnly'] and not report['modelUsed']
            # Preserve real official Trace structure while testing non-ASCII and
            # Windows CRLF text reading. No scenario action is executed.
            content = json.loads(path.read_text(encoding='utf-8'))
            content['context'] = '中文内容🧪不调用模型'
            path.write_bytes(json.dumps(content, ensure_ascii=False, indent=2).replace('\n','\r\n').encode('utf-8'))
            cls.traces.append(path)
        rows = [{'executionId':f'controlled-{run}', 'phase':'standard', 'config':'execution', 'scenarioId':'phase2_controlled', 'runNumber':run, 'success':success, 'traceSourcePath':str(cls.traces[run-1])} for run, success in [(1,True),(2,False),(3,None)]]
        rows[2]['failureCategory']='rate_limit'
        rows[1]['failureCategory']='business_failure'
        cls.report = adapter.build({'packageRoot':str(cls.package), 'model':'controlled-no-model', 'provider':'controlled', 'rows':rows})

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def copy_package(self, name):
        target = self.root / name
        shutil.copytree(self.package, target)
        return target

    def call_check(self, package, **extra):
        return adapter.check({'packageRoot':str(package), 'model':'controlled-no-model', 'provider':'controlled', **extra})

    def assert_rejected(self, package, code):
        with self.assertRaises(adapter.AdapterRejected) as caught:
            self.call_check(package)
        self.assertEqual(caught.exception.code, code)

    def test_01_real_official_construction_and_exact_null_technical_score(self):
        report = self.report
        self.assertEqual((report['reconstructedCount'], report['successCount'], report['businessFailureCount'], report['technicalCount']), (3,1,1,1))
        self.assertTrue(report['traceValidationPassed'] and report['hfSchemaValid'])
        self.assertFalse(report['officialSubmissionReady'])
        self.assertIn('are.simulation.multi_scenario_runner._export_benchmark_result_jsonl', report['officialFunctions'])
        native = adapter.json_lines(self.package/'standard/execution/native-output.jsonl')
        self.assertEqual([row['score'] for row in native], [1.0,0.0,None])
        self.assertEqual([row['metadata']['status'] for row in native], ['success','failed','exception'])
        self.assertEqual([row['metadata']['run_number'] for row in native], [1,2,3])
        hf_path = next(self.package/path for path in report['artifactPaths'] if path.endswith('/hf-rows.jsonl'))
        hf = adapter.json_lines(hf_path)
        self.assertTrue(all(len(row)==17 and 'data' in row for row in hf))
        self.assertEqual([row['score'] for row in hf], [1.0,0.0,None])
        self.assertTrue(all('中文内容' in row['data'] for row in hf))
        self.assertEqual(report['stats']['statistics']['global']['validated_runs'], 2)
        self.assertEqual(report['stats']['statistics']['global']['exception_runs'], 1)
        self.assertEqual(len(report['normalizations']), 9)
        for run in (1,2,3):
            self.assertEqual((self.package/f'standard/execution/hf/controlled-{run}.json').read_bytes(), self.traces[run-1].read_bytes())

    def test_02_package_relocation_reconstructs_and_preserves_old_evidence(self):
        package = self.copy_package('relocated')
        before = {path.relative_to(package).as_posix():hashlib.sha256(path.read_bytes()).hexdigest() for path in package.rglob('*') if path.is_file()}
        prior_hf = next(path for path in before if path.endswith('/hf-rows.jsonl'))
        with adapter.working_directory(package):
            report = self.call_check(package, hfRowsPath=str(package/prior_hf))
        self.assertEqual(report['identityRows'], self.report['identityRows'])
        self.assertEqual(report['reconstructedCount'], 3)
        for relative, digest in before.items():
            self.assertEqual(hashlib.sha256((package/relative).read_bytes()).hexdigest(), digest)
        self.assertEqual(len(list((package/'_official').iterdir())), 2)

    def test_03_duplicates_are_rejected_before_official_silent_overwrite(self):
        package = self.copy_package('duplicate')
        path = package/'standard/execution/output.jsonl'
        content = path.read_text(encoding='utf-8')
        path.write_text(content + content.splitlines()[0] + '\n', encoding='utf-8')
        self.assert_rejected(package, 'duplicate_scenario_run')

    def test_04_score_zero_cannot_hide_technical_exception(self):
        package = self.copy_package('technical-as-zero')
        path = package/'standard/execution/output.jsonl'
        rows = adapter.json_lines(path)
        rows[2]['score'] = 0
        rows[2]['metadata']['status'] = 'failed'
        path.write_text(''.join(json.dumps(row)+'\n' for row in rows), encoding='utf-8')
        self.assert_rejected(package, 'scored_envelope_has_exception')

    def test_05_missing_trace_identity_fields_and_path_escape_rejected(self):
        cases = [('missing-trace','missing_package_file',lambda rows:rows[0].update(trace_id='standard/execution/hf/absent.json')),
                 ('wrong-run','trace_identity_mismatch',lambda rows:rows[0]['metadata'].update(run_number=99)),
                 ('external-path','external_package_path',lambda rows:rows[0].update(trace_id='../trace-1.json')),
                 ('absolute-path','nonportable_package_path',lambda rows:rows[0].update(trace_id=str(self.traces[0]).replace('\\','/'))),
                 ('missing-run','metadata_missing_field',lambda rows:rows[0]['metadata'].pop('run_number')),
                 ('boolean-run','invalid_run_number',lambda rows:rows[0]['metadata'].update(run_number=True))]
        for name, code, mutate in cases:
            with self.subTest(name=name):
                package = self.copy_package(name)
                path = package/'standard/execution/output.jsonl'
                rows = adapter.json_lines(path)
                mutate(rows)
                path.write_text(''.join(json.dumps(row)+'\n' for row in rows), encoding='utf-8')
                self.assert_rejected(package, code)

    def test_06_existing_hf_rows_must_match_official_reconstruction(self):
        package = self.copy_package('hf-tampered')
        hf = next(package/path for path in self.report['artifactPaths'] if path.endswith('/hf-rows.jsonl'))
        rows = adapter.json_lines(hf)
        rows[1]['score']=1.0
        hf.write_text(''.join(json.dumps(row)+'\n' for row in rows), encoding='utf-8')
        with self.assertRaises(adapter.AdapterRejected) as caught:
            self.call_check(package,hfRowsPath=str(hf))
        self.assertEqual(caught.exception.code,'existing_hf_rows_mismatch')

    def test_07_cli_safe_failure_and_report_exclusivity(self):
        spec = self.root/'bad-spec.json'
        spec.write_text(json.dumps({'packageRoot':str(self.root/'SECRET_KEY-private-provider-body')}), encoding='utf-8')
        output = self.root/'safe-output.json'
        original_argv = sys.argv
        sys.argv=['adapter','--operation','check','--spec',str(spec),'--output',str(output)]
        captured=io.StringIO()
        with contextlib.redirect_stdout(captured):
            exit_code=adapter.main()
        self.assertEqual(exit_code,2)
        report=json.loads(output.read_text(encoding='utf-8'))
        self.assertEqual(report['code'],'missing_package_root')
        self.assertNotIn('SECRET_KEY',captured.getvalue()+output.read_text(encoding='utf-8'))
        prior=output.read_bytes()
        with contextlib.redirect_stdout(captured):
            self.assertEqual(adapter.main(),2)
        self.assertEqual(output.read_bytes(),prior)
        sys.argv=original_argv

    def test_08_trace_schema_and_duplicate_json_fields_fail_closed(self):
        package = self.copy_package('bad-trace-fields')
        trace_path=package/'standard/execution/hf/controlled-1.json'
        trace=json.loads(trace_path.read_text(encoding='utf-8'))
        trace.pop('world_logs')
        trace_path.write_text(json.dumps(trace),encoding='utf-8')
        self.assert_rejected(package,'trace_missing_field')
        package = self.copy_package('duplicate-json-key')
        path=package/'standard/execution/output.jsonl'
        rows=path.read_text(encoding='utf-8').splitlines()
        rows[0]=rows[0][:-1]+',"score": 1}\n'
        path.write_text('\n'.join(rows),encoding='utf-8')
        self.assert_rejected(package,'duplicate_json_key')

    def test_09_build_prevalidates_all_rows_before_writing(self):
        package=self.root/'all-prevalidated'
        package.mkdir()
        rows=[{'executionId':'one','phase':'standard','config':'execution','scenarioId':'phase2_controlled','runNumber':1,'success':True,'traceSourcePath':str(self.traces[0])},
              {'executionId':'two','phase':'standard','config':'execution','scenarioId':'phase2_controlled','runNumber':2,'success':True,'traceSourcePath':str(self.root/'missing-trace')}]
        with self.assertRaises(adapter.AdapterRejected) as caught:
            adapter.build({'packageRoot':str(package),'model':'controlled','provider':'controlled','rows':rows})
        self.assertEqual(caught.exception.code,'missing_trace_source')
        self.assertEqual(list(package.iterdir()),[])

    def test_10_no_network_actor_or_judge_was_used(self):
        self.assertEqual(network_attempts,[])

    def test_11_hf_schema_cannot_hide_extra_columns_or_boolean_scores(self):
        for name, change, code in [('hf-extra',lambda row:row.update(extra_secret='SECRET_KEY'), 'existing_hf_schema_fields_mismatch'),
                                   ('hf-bool-score',lambda row:row.update(score=True), 'invalid_existing_hf_score'),
                                   ('hf-bool-run',lambda row:row.update(run_number=True), 'invalid_run_number')]:
            with self.subTest(name=name):
                package=self.copy_package(name)
                hf=next(package/path for path in self.report['artifactPaths'] if path.endswith('/hf-rows.jsonl'))
                rows=adapter.json_lines(hf)
                change(rows[0])
                hf.write_text(''.join(json.dumps(row)+'\n' for row in rows),encoding='utf-8')
                with self.assertRaises(adapter.AdapterRejected) as caught:
                    self.call_check(package,hfRowsPath=str(hf))
                self.assertEqual(caught.exception.code,code)

    def test_12_reserved_node_evidence_is_preserved_but_foreign_roots_rejected(self):
        package=self.root/'reserved-evidence'
        package.mkdir()
        (package/'run-manifest.json').write_text('{"immutable":"manifest"}',encoding='utf-8')
        (package/'evidence').mkdir()
        (package/'evidence'/'task-result.json').write_text('{"immutable":"result"}',encoding='utf-8')
        (package/'provenance').mkdir()
        (package/'provenance'/'dataset-lock.json').write_text('{"immutable":"lock"}',encoding='utf-8')
        before={path.relative_to(package).as_posix():path.read_bytes() for path in package.rglob('*') if path.is_file()}
        row={'executionId':'reserved-one','phase':'standard','config':'execution','scenarioId':'phase2_controlled','runNumber':1,'success':True,'traceSourcePath':str(self.traces[0])}
        report=adapter.build({'packageRoot':str(package),'model':'controlled','provider':'controlled','rows':[row]})
        self.assertEqual(report['reconstructedCount'],1)
        for relative, raw in before.items():
            self.assertEqual((package/relative).read_bytes(),raw)
        package=self.root/'foreign-prepopulation'
        package.mkdir()
        (package/'foreign.json').write_text('{}',encoding='utf-8')
        with self.assertRaises(adapter.AdapterRejected) as caught:
            adapter.build({'packageRoot':str(package),'model':'controlled','provider':'controlled','rows':[row]})
        self.assertEqual(caught.exception.code,'package_root_not_empty')

unittest.main(argv=['phase2_official_test'],verbosity=2)
`], { cwd: root, env: { ...process.env, PYTHONPATH: join(root, '.official-python'), PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False' }, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, /Ran 12 tests/)
  assert.match(result.stderr, /OK/)
})
