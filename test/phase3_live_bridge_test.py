import copy, hashlib, io, json, os, socket, subprocess, sys, tempfile, threading, unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

external_attempts=[]
protocol_failure_audits=[]
original_connect=socket.socket.connect
def loopback_only(sock,address):
    if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1'):
        external_attempts.append(str(type(address).__name__))
        raise AssertionError('External network forbidden')
    return original_connect(sock,address)
socket.socket.connect=loopback_only
sys.path.insert(0,str(Path('scripts').resolve()))
import capybara_official_bridge as bridge
import litellm
from gaia2_model_retry import ModelRequestFailure, ModelRetryPolicy, wrap_completion
from gaia2_runtime_hooks import HookProtocolError, RuntimeHookClient
from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
from are.simulation.apps.app import App
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.apps.system import SystemApp
from are.simulation.apps.sandbox_file_system import SandboxLocalFileSystem
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.notification_system import Message, MessageType
from are.simulation.scenarios.scenario import Scenario
from are.simulation.scenarios.validation_result import ScenarioValidationResult
from are.simulation.tool_utils import AppTool, OperationType, app_tool
from are.simulation.types import Event, EventType, EnvironmentState, event_registered

class LedgerApp(App):
    def __init__(self):
        super().__init__()
        self.values=[]
        self.reads=0
        self.read_result=None
    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self,value:str)->dict:
        """Write the supplied value into the ledger.
        :param value: the value to write
        :returns: the observed ledger
        """
        self.values.append(value)
        if value=='uncertain':
            raise RuntimeError('Hidden effect happened; actual exception text is not logged')
        return {'values':list(self.values)}
    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self)->dict:
        """Read the authoritative current ledger.
        :returns: the observed ledger
        """
        self.reads+=1
        return self.read_result if self.read_result is not None else {'values':list(self.values)}

class ArgumentLedger(App):
    """Dummy callbacks with genuine ARE defaults and event registration."""
    def __init__(self):
        super().__init__()
        self.values=[]
    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read_default(self,value:str='')->dict:
        """Read a dummy value.
        :param value: the dummy read key
        :returns: the dummy observation
        """
        return {'value':value}
    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write_default(self,value:str='')->dict:
        """Append a dummy value.
        :param value: the dummy value
        :returns: the dummy observation
        """
        self.values.append(value)
        return {'value':value}
    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write_required(self,value:str)->dict:
        """Append a required dummy value.
        :param value: the dummy value
        :returns: the dummy observation
        """
        self.values.append(value)
        return {'value':value}
    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def optional(self,value:str|None=None)->dict:
        """Read an optional dummy value.
        :param value: the optional dummy value
        :returns: the dummy observation
        """
        return {'value':value}
    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def observe(self,value:dict)->dict:
        """Read a dummy structured value.
        :param value: the dummy structured value
        :returns: the dummy observation
        """
        return {'value':value}

class ControlledScenario(Scenario):
    def validate(self,env):
        self.judge_calls+=1
        return ScenarioValidationResult(success=self.judge_success)

def setup_scenario(turns=1,success=True):
    env=Environment(config=EnvironmentConfig(start_time=1000,duration=60,verbose=False))
    aui=AgentUserInterface(); system=SystemApp(); ledger=LedgerApp()
    env.register_apps([aui,system,ledger])
    env.state=EnvironmentState.RUNNING
    scenario=ControlledScenario(scenario_id='phase3-controlled',apps=[aui,system,ledger],nb_turns=turns,
                                start_time=1000,duration=60,additional_system_prompt='PUBLIC_SYSTEM_DETAIL')
    scenario.judge_calls=0; scenario.judge_success=success
    # These privileged fields must never become Actor inputs.
    scenario.hints=['ORACLE_HINT_SECRET']
    scenario.events=['FUTURE_EVENT_SECRET']
    env.world_logs=['EVALUATOR_WORLD_LOG_SECRET']
    aui.send_message_to_agent('Initial request')
    return scenario,env,aui,system,ledger

def response(name=None,arguments=None,content=None,call_id='call'):
    calls=[] if name is None else [SimpleNamespace(id=call_id,function=SimpleNamespace(name=name,arguments=json.dumps(arguments or {})))]
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content,tool_calls=calls))])

ARGUMENT_PREFLIGHT_CASES=('finish','defaults','unsafe_json','binding')

def run_argument_preflight_case(case):
    """Same model-free ARE fixture for stub Hooks and the real RuntimeHost."""
    scenario,env,aui,system,unused=setup_scenario()
    ledger=ArgumentLedger()
    scenario.apps.append(ledger);env.register_apps([ledger])
    finish='AgentUserInterface__send_message_to_user'
    nonroundtrip='official_argument_not_roundtrippable'
    steps={
        'finish':[
            ('finish-explicit-empty',finish,'{"content":""}',nonroundtrip),
            ('finish-default-empty',finish,'{}',nonroundtrip),
            ('finish-valid',finish,'{"content":"Controlled dummy reply"}',None),
        ],
        'defaults':[
            ('default-read','ArgumentLedger__read_default','{}',nonroundtrip),
            ('default-write','ArgumentLedger__write_default','{}',nonroundtrip),
            ('defaults-finish',finish,'{"content":"Controlled defaults checked"}',None),
        ],
        'unsafe_json':[
            ('overflow','ArgumentLedger__observe','{"value":{"unsafe":1e400}}','unsafe_json_argument'),
            ('surrogate','ArgumentLedger__observe','{"value":{"unsafe":"\\ud800"}}','unsafe_json_argument'),
            ('deep-json','ArgumentLedger__observe','{"value":'+('['*4096)+'0'+(']'*4096)+'}','unsafe_json_argument'),
            ('none-default','ArgumentLedger__optional','{}',None),
            ('none-explicit','ArgumentLedger__optional','{"value":null}',None),
            ('nested-empty','ArgumentLedger__observe','{"value":{"empty":"","items":[null,{},[]]}}',None),
            ('unsafe-finish',finish,'{"content":"Controlled JSON checked"}',None),
        ],
        'binding':[
            ('missing','ArgumentLedger__write_required','{}','argument_binding_failed'),
            ('extra','ArgumentLedger__write_required','{"value":"dummy","extra":"dummy"}','argument_binding_failed'),
            ('bound-write','ArgumentLedger__write_required','{"value":"dummy"}',None),
            ('binding-finish',finish,'{"content":"Controlled binding checked"}',None),
        ],
    }[case]
    runtime_events=[];actor_inputs=[];callback_counts={}
    original_emit=bridge._emit_runtime_event
    original_call=AppTool.__call__
    def emit(kind,**data):
        runtime_events.append({'type':kind,**data});original_emit(kind,**data)
    def counted_call(tool,*args,**kwargs):
        name=f'{tool.class_name}__{tool.func_name}'
        callback_counts[name]=callback_counts.get(name,0)+1
        return original_call(tool,*args,**kwargs)
    def native_names():
        return [f'{event.action.app_name}__{event.action.function_name}'
                for event in env.event_log.list_view() if event.event_type==EventType.AGENT]
    def model(messages,*unused):
        assert env.state==EnvironmentState.PAUSED
        index=len(actor_inputs)
        assert index<len(steps),'FakeActor unexpectedly continued'
        actor_inputs.append({'messages':copy.deepcopy(messages),'callbackCounts':dict(callback_counts),
                             'nativeCompletedEvents':native_names(),
                             'completedTurns':len([e for e in runtime_events if e['type']=='conversation_turn_completed'])})
        call_id,name,raw,reason=steps[index]
        reply=response(name,call_id=call_id)
        reply.choices[0].message.tool_calls[0].function.arguments=raw
        return reply
    with patch.object(bridge,'_emit_runtime_event',emit),patch.object(bridge,'_call_model',model),\
         patch.object(AppTool,'__call__',counted_call):
        result=bridge._native_run_with_agent(None,scenario.scenario_id,scenario,env,'default','controlled-no-model')
    assert result.success and scenario.judge_calls==1
    assert len(actor_inputs)==len(steps)
    ended=next(e for e in reversed(runtime_events) if e['type']=='attempt_execution_ended')
    expected_executed=[name for _,name,_,reason in steps if reason is None]
    assert native_names()==expected_executed
    assert sum(callback_counts.values())==len(expected_executed)
    assert ended['usage']['toolsExecuted']==len(expected_executed)
    assert ended['usage']['completedTurns']==1
    assert ended['usage']['unknownMutationOutcomes']==0
    assert [m.content for m in aui.messages if m.sender==Sender.AGENT]==[json.loads(steps[-1][2])['content']]
    assert ledger.values==(['dummy'] if case=='binding' else [])
    rejected=[]
    for index,(call_id,name,raw,reason) in enumerate(steps):
        if reason is None:continue
        event=next(e for e in runtime_events if e['type']=='tool_call_blocked' and e['callId']==call_id)
        assert event['reason']==reason
        assert not any(e['type'] in ('tool_call_started','tool_call_completed') and e.get('callId')==call_id for e in runtime_events)
        before,after=actor_inputs[index:index+2]
        assert after['callbackCounts']==before['callbackCounts']
        assert after['nativeCompletedEvents']==before['nativeCompletedEvents']
        assert after['completedTurns']==before['completedTurns']==0
        observed=next(json.loads(m['content']) for m in after['messages'] if m.get('tool_call_id')==call_id)
        assert observed['status']=='blocked' and observed['reason']==reason and observed['executed'] is False
        rejected.append({'id':call_id,'reason':reason,'observation':observed})
    assert not external_attempts
    return {'case':case,'status':'passed','syntheticFixtureOnly':True,'benchmarkExecuted':False,
            'officialSubmissionReady':False,'realModelCalls':0,'externalNetworkAttempts':len(external_attempts),
            'callbackCounts':callback_counts,'nativeCompletedEvents':native_names(),'actorInputs':actor_inputs,
            'events':runtime_events,'rejected':rejected,'usage':ended['usage'],'validationCalls':scenario.judge_calls}

@contextmanager
def hook_server(policy=None,corrupt=None,after_hook=None):
    state={'requests':[],'roundRequests':[],'roundResponses':[],'failures':[],'unknown':False,'readBackObserved':False}
    workspace=tempfile.TemporaryDirectory(prefix='phase3-shared-tool-round-')
    worker=None
    def shared_tool_round(request):
        """Only relay JSON; all round state belongs to the production Node service."""
        nonlocal worker
        if worker is None:
            root=Path(__file__).resolve().parents[1]
            backend=Path(json.loads((root/'config/phase0-protocol.json').read_text(encoding='utf-8'))['runtime']['backendRoot'])
            program="""
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, backend, workspace] = process.argv.slice(1);
const { ToolRoundScheduler } = await import(pathToFileURL(join(backend, 'src/core/tools/tool-round-scheduler.ts')).href);
const { createToolRoundService } = await import(pathToFileURL(join(root, 'src/tool_round_service.mjs')).href);
const service = createToolRoundService({ Scheduler: ToolRoundScheduler, workspaceDir: workspace,
  executionId: 'controlled-execution', sessionId: 'controlled-session' });
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try { process.stdout.write(JSON.stringify(service.invoke(JSON.parse(line))) + '\\n'); }
  catch (error) { process.stdout.write(JSON.stringify({ error: error.code || error.message }) + '\\n'); }
}
"""
            worker=subprocess.Popen(['node','--import',(backend/'node_modules/tsx/dist/loader.mjs').as_uri(),
                '--input-type=module','-e',program,str(root),str(backend),workspace.name],
                cwd=str(backend),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                text=True,encoding='utf-8',bufsize=1,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            ready=worker.stdout.readline()
            assert ready and json.loads(ready).get('ready') is True, 'Shared Node scheduler worker failed to initialize'
        state['roundRequests'].append(copy.deepcopy(request))
        worker.stdin.write(json.dumps(request,ensure_ascii=False)+'\n');worker.stdin.flush()
        result=json.loads(worker.stdout.readline(8*1024*1024+1))
        assert 'error' not in result,result
        state['roundResponses'].append(copy.deepcopy(result))
        return result
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            try:
                assert self.path in ('/invoke','/tool-round')
                assert self.headers.get('Authorization')=='Bearer controlled-token'
                request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert request['executionId']=='controlled-execution'
                assert request['sessionId']=='controlled-session'
                if self.path=='/tool-round':
                    raw=json.dumps(shared_tool_round(request),ensure_ascii=False).encode('utf-8')
                    self.send_response(200);self.send_header('Content-Type','application/json')
                    self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
                    return
                assert all(set(message)<={'role','content','id','name','toolCallId','requestId','observation','notificationType','sourceHash'} for message in request['messages'])
                for message in request['messages']:
                    if 'observation' in message:
                        assert message['role']=='tool'
                        assert message['observation']['actionId']==message['toolCallId']
                    if 'notificationType' in message:
                        assert message['role']=='user'
                        assert message['notificationType'] in ('USER_MESSAGE','ENVIRONMENT_NOTIFICATION')
                assert all(isinstance(message['content'],str) for message in request['messages'])
                assert request.get('action','absent') is not None
                assert request.get('outcome','absent') is not None
                state['requests'].append(request)
                action=request.get('action') or {}
                checkpoint=request['checkpoint']
                decision='allow'
                if checkpoint=='before_tool' and policy:
                    decision=policy(request,state)
                if checkpoint=='after_tool':
                    if request['outcome']['status']=='unknown': state['unknown']=True
                    if action.get('authoritativeRead') and request['outcome']['status']=='succeeded': state['readBackObserved']=True
                    if after_hook:after_hook(request,state)
                text='visible_hook_context_'+str(len(state['requests']))
                receipt={'decision':{'action':decision,'reason':'controlled_'+decision},'context':text,
                         'contextHash':hashlib.sha256(text.encode()).hexdigest(),
                         'variablesHash':hashlib.sha256(b'controlled_variables').hexdigest(),
                         'hookReceipts':[{'plugin':'controlled_live_stub','checkpoint':checkpoint}],
                         'revision':len(state['requests']),'evidencePath':'controlled-no-file-evidence.json'}
                if corrupt: receipt=corrupt(receipt,request)
                raw=json.dumps(receipt).encode()
                self.send_response(200); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
            except BaseException as error:
                state['failures'].append(type(error).__name__)
                self.send_error(500)
    server=HTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    settings={'GAIA2_HOOK_URL':f'http://127.0.0.1:{server.server_port}/invoke','GAIA2_HOOK_TOKEN':'controlled-token',
              'GAIA2_EXECUTION_ID':'controlled-execution','GAIA2_SESSION_ID':'controlled-session',
              'GAIA2_TOOL_ROUND_WORKSPACE':workspace.name,
              'GAIA2_E2E_MAX_ACTIONS':'30'}
    try:
        with patch.dict(os.environ,settings): yield state
    finally:
        server.shutdown(); server.server_close(); thread.join(2)
        if worker is not None:
            worker.stdin.close()
            try:worker.wait(timeout=5)
            except subprocess.TimeoutExpired:worker.terminate();worker.wait(timeout=5)
            worker.stdout.close();worker.stderr.close()
        workspace.cleanup()
        assert not state['failures'],state['failures']

@contextmanager
def completion_server(replies=None,reject=False):
    """Real pinned LiteLLM transport, but only a local fake model endpoint."""
    state={'requests':[],'failures':[]}
    responses=list(replies or [])
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_POST(self):
            try:
                assert self.path=='/v1/chat/completions'
                assert self.headers.get('Authorization')=='Bearer controlled-model-token'
                request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                state['requests'].append(request)
                if reject:
                    status=400
                    body={'error':{'message':'parallel_tool_calls is not supported',
                                   'type':'invalid_request_error','param':'parallel_tool_calls','code':'unsupported_parameter'}}
                else:
                    status=200
                    reply=responses.pop(0)
                    message={'role':'assistant','content':reply.choices[0].message.content}
                    calls=reply.choices[0].message.tool_calls
                    if calls:
                        message['tool_calls']=[{'id':call.id,'type':'function','function':
                                               {'name':call.function.name,'arguments':call.function.arguments}} for call in calls]
                    body={'id':'controlled-completion','object':'chat.completion','created':1000,
                          'model':'gpt-4o-mini','choices':[{'index':0,'message':message,
                          'finish_reason':'tool_calls' if calls else 'stop'}],
                          'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}
                raw=json.dumps(body).encode()
                self.send_response(status);self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
            except BaseException as error:
                state['failures'].append(type(error).__name__)
                self.send_error(500)
    server=HTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    settings={'OPENAI_API_KEY':'controlled-model-token','HTTP_PROXY':'','HTTPS_PROXY':'','ALL_PROXY':'',
              'http_proxy':'','https_proxy':'','all_proxy':'','NO_PROXY':'127.0.0.1,::1',
              'no_proxy':'127.0.0.1,::1'}
    try:
        with patch.dict(os.environ,settings):yield state,f'http://127.0.0.1:{server.server_port}/v1'
    finally:
        server.shutdown();server.server_close();thread.join(2)
        assert not state['failures'],state['failures']

class Tests(unittest.TestCase):
    def setUp(self):
        self.events=[]
        self.patcher=patch.object(bridge,'_emit_runtime_event',lambda kind,**data:self.events.append({'type':kind,**data}))
        self.patcher.start()
    def tearDown(self):
        self.patcher.stop()
        self.assertEqual(external_attempts,[])
    def run_bridge(self,scenario,env,model,**kwargs):
        with patch.object(bridge,'_call_model',model):
            return bridge._native_run_with_agent(None,scenario.scenario_id,scenario,env,'default','controlled-no-model',**kwargs)
    def end_event(self):
        return next(item for item in reversed(self.events) if item['type']=='attempt_execution_ended')
    def run_transport(self,scenario,env,endpoint):
        # Match production's actor retry wrapper without installing or changing
        # ARE aliases. Any delay here would mean a forbidden configuration retry.
        retry=wrap_completion(litellm.completion,'actor',bridge._emit_runtime_event,
                              policy=ModelRetryPolicy(max_attempts=5),
                              sleep=lambda *unused:(_ for _ in ()).throw(AssertionError('Unexpected retry wait')))
        with patch.object(bridge,'completion',retry):
            return bridge._native_run_with_agent(None,scenario.scenario_id,scenario,env,'default',
                                                 'gpt-4o-mini',provider='openai',endpoint=endpoint)

    def test_01_dynamic_message_cancels_stale_write_and_enters_next_real_request(self):
        scenario,env,aui,system,ledger=setup_scenario()
        future=Event.from_function(aui.send_message_to_agent,event_type=EventType.USER,content='Updated instruction').at_absolute_time(1010)
        env.event_queue.put(future)
        calls=[]
        def model(messages,tools,*unused):
            calls.append(copy.deepcopy(messages))
            self.assertEqual(env.state,EnvironmentState.PAUSED)
            text=json.dumps(messages)
            self.assertIn('visible_hook_context_',text)
            self.assertIn('PUBLIC_SYSTEM_DETAIL',text)
            self.assertNotIn('ORACLE_HINT_SECRET',text)
            self.assertNotIn('FUTURE_EVENT_SECRET',text)
            self.assertNotIn('EVALUATOR_WORLD_LOG_SECRET',text)
            if len(calls)==1:
                self.assertNotIn('Updated instruction',text)
                env.time_manager.add_offset(10)
                return response('LedgerApp__write',{'value':'obsolete'},call_id='old')
            if len(calls)==2:
                self.assertIn('Updated instruction',text)
                return response('LedgerApp__write',{'value':'latest'},call_id='new')
            return response('AgentUserInterface__send_message_to_user',{'content':'Done'},call_id='finish')
        with hook_server() as host:
            result=self.run_bridge(scenario,env,model)
        self.assertTrue(result.success)
        self.assertEqual(ledger.values,['latest'])
        self.assertEqual(scenario.judge_calls,1)
        self.assertEqual(len(calls),3)
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),2)
        self.assertEqual(self.end_event()['terminationReason'],'conversation_turn_limit')
        self.assertTrue(any(e['type']=='tool_call_blocked' and e['reason']=='stale_dynamic_context' for e in self.events))
        self.assertEqual(len([e for e in self.events if e['type']=='dynamic_context_injected']),3)
        self.assertTrue(all(e['contextHash']==e['injectedContextHash'] for e in self.events if e['type']=='dynamic_context_injected'))

    def test_01b_actor_owns_business_plan_without_universal_readback_approval(self):
        scenario,env,aui,system,ledger=setup_scenario()
        calls=[]
        def model(messages,*unused):
            calls.append(copy.deepcopy(messages))
            if len(calls)==1:
                return response('AgentUserInterface__send_message_to_user',
                                {'content':'Controlled guidance check'}, call_id='finish')
            raise AssertionError('model unexpectedly continued')
        with hook_server() as host:
            result=self.run_bridge(scenario,env,model)
        self.assertTrue(result.success)
        self.assertEqual(len(calls),1)
        system_text=calls[0][0]['content']
        for phrase in (
            'decide the business plan, verification needs and completion yourself',
            'Never blindly replay an unknown write',
            'Follow the latest user instructions, including time windows and notification restrictions',
            'they execute sequentially in listed order',
            'Technical limits and silence are not proof of business success',
            'Decompose the request into independently verifiable subgoals',
            'defer only that branch and continue other branches',
            'reconcile every user clause against the action and observation ledger',
        ):
            self.assertIn(phrase, system_text)
        for retired in ('private checklist', 'After each mutation', 'Independent task contracts',
                        'inspect all relevant candidates before mutating'):
            self.assertNotIn(retired, system_text)
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),1)

    def test_01c_windows_fallback_hydrates_and_open_results_close(self):
        if os.name != 'nt':
            self.skipTest('Windows fallback compatibility is host-specific')
        bridge._install_windows_fallback_compatibility()
        state={'files':{'name':'','type':'directory','children':[
            {'name':'Documents','type':'directory','children':[
                {'name':'news','type':'directory','children':[
                    {'name':'target.txt','type':'file'}]}]}]}}
        with tempfile.TemporaryDirectory() as fallback, tempfile.TemporaryDirectory() as sandbox:
            target=Path(fallback)/'Documents'/'news'/'target.txt'
            target.parent.mkdir(parents=True)
            target.write_text('Copa America 2024', encoding='utf-8')
            fs=SandboxLocalFileSystem(sandbox_dir=sandbox, state_directory=Path(fallback).as_uri())
            fs.load_state(state)
            bridge._official_filesystem_health_check(SimpleNamespace(apps={'Files': SimpleNamespace(sandbox_fs=fs)}))
            self.assertEqual(fs.cat('/Documents/news/target.txt'), b'Copa America 2024')
            handle=fs.open('/Documents/news/target.txt', 'r')
            bridge._actor_visible_tool_result(handle)
            self.assertTrue(handle.closed)

    def test_01d_windows_fallback_serialization_does_not_probe_remote_metadata(self):
        if os.name != 'nt':
            self.skipTest('Windows fallback compatibility is host-specific')
        bridge._install_windows_fallback_compatibility()

        class RemoteFile:
            def __init__(self):
                self.opened=[]
            def open(self, path, mode='rb'):
                self.opened.append(path)
                return io.BytesIO(b'localised payload')
            def exists(self, path):
                raise AssertionError('serialization must not call remote exists/info')
            def info(self, path):
                raise AssertionError('serialization must not call remote exists/info')
            def isfile(self, path):
                raise AssertionError('serialization must not call remote exists/info')

        state={'files':{'name':'','type':'directory','children':[
            {'name':'Documents','type':'directory','children':[
                {'name':'news','type':'directory','children':[
                    {'name':'target.txt','type':'file'}]}]}]}}
        with tempfile.TemporaryDirectory() as fallback, tempfile.TemporaryDirectory() as sandbox:
            target=Path(fallback)/'Documents'/'news'/'target.txt'
            target.parent.mkdir(parents=True)
            target.write_bytes(b'remote payload')
            fs=SandboxLocalFileSystem(sandbox_dir=sandbox, state_directory=Path(fallback).as_uri())
            fs.load_state(state)
            remote=RemoteFile()
            fs.local_fs.fallback_root='remote-root'
            fs.local_fs.fallback_fs=remote
            target=fs._validate_path('/Documents/news/target.txt')
            self.assertEqual(fs.local_fs._get_fallback_stats_for_item(
                target, {'name': target, 'size': 0, 'type': 'file'}
            )['size'], 0)
            self.assertEqual(remote.opened, [])
            self.assertEqual(fs.cat('/Documents/news/target.txt'), b'localised payload')
            self.assertEqual(remote.opened, ['remote-root/Documents/news/target.txt'])

    def test_01e_model_history_compaction_preserves_pairs_and_marks_incomplete(self):
        messages = [
            {'role': 'system', 'content': 'base policy'},
            {'role': 'system', 'content': 'live hook context'},
            {'role': 'user', 'content': 'complete the authoritative task'},
        ]
        for index in range(5):
            messages.extend([
                {'role': 'assistant', 'content': '', 'tool_calls': [
                    {'id': f'call-{index}', 'type': 'function',
                     'function': {'name': 'Files__read', 'arguments': '{}'}}
                ]},
                {'role': 'tool', 'tool_call_id': f'call-{index}',
                 'content': f'old observation {index} ' + ('x' * 6000)},
            ])

        compacted, metadata = bridge._compact_model_input(messages, [], max_bytes=9000)
        self.assertTrue(metadata['compacted'])
        self.assertLessEqual(metadata['compactedBytes'], 9000)
        self.assertGreater(metadata['hiddenMessageCount'], 0)
        self.assertTrue(
            'runtime compaction' in '\n'.join(item.get('content', '') for item in compacted
                                               if item.get('role') in ('system', 'tool'))
            or metadata['hiddenToolCallIds'] or metadata['truncatedToolCallIds']
        )
        self.assertEqual(compacted[:2], messages[:2])
        self.assertIn(messages[2], compacted)
        for index, message in enumerate(compacted):
            if message.get('role') == 'tool':
                self.assertGreater(index, 0)
                self.assertEqual(compacted[index - 1].get('role'), 'assistant')

    def test_01f_model_history_compaction_has_message_count_guard(self):
        messages = [
            {'role': 'system', 'content': 'base policy'},
            {'role': 'system', 'content': 'live hook context'},
            {'role': 'user', 'content': 'complete the authoritative task'},
        ]
        for index in range(20):
            messages.extend([
                {'role': 'assistant', 'content': '', 'tool_calls': [
                    {'id': f'call-count-{index}', 'type': 'function',
                     'function': {'name': 'Files__read', 'arguments': '{}'}}
                ]},
                {'role': 'tool', 'tool_call_id': f'call-count-{index}',
                 'content': f'observation {index}'},
            ])

        compacted, metadata = bridge._compact_model_input(
            messages, [], max_bytes=1_000_000, max_messages=10
        )
        self.assertTrue(metadata['compacted'])
        self.assertIn('message_count', metadata['compactionReason'])
        self.assertLessEqual(len(compacted), 10)
        self.assertEqual(compacted[:2], messages[:2])
        self.assertIn(messages[2], compacted)
        for index, message in enumerate(compacted):
            if message.get('role') == 'tool':
                self.assertGreater(index, 0)
                self.assertEqual(compacted[index - 1].get('role'), 'assistant')

    def test_02_unknown_write_is_not_retried_and_requires_read_back(self):
        scenario,env,aui,system,ledger=setup_scenario()
        steps=[response('LedgerApp__write',{'value':'uncertain'},call_id='first'),
               response('LedgerApp__write',{'value':'uncertain'},call_id='retry'),
               response('LedgerApp__read',call_id='read'),
               response('AgentUserInterface__send_message_to_user',{'content':'Outcome requires confirmation'},call_id='finish')]
        def policy(request,state):
            return 'read_back' if request['action']['effect']=='write' and state['unknown'] else 'allow'
        with hook_server(policy) as host:
            self.run_bridge(scenario,env,lambda *a:steps.pop(0))
        self.assertEqual(ledger.values,['uncertain'])
        self.assertEqual(ledger.reads,1)
        self.assertTrue(host['readBackObserved'])
        actual=[r for r in host['requests'] if r['checkpoint']=='after_tool']
        self.assertEqual([r['outcome']['status'] for r in actual],['unknown','succeeded','succeeded'])
        self.assertFalse(actual[0]['outcome']['complete'])
        self.assertTrue(any(e['type']=='tool_call_blocked' and e['reason']=='authoritative_read_required' for e in self.events))

    def test_03_guard_block_does_not_run_or_record_after_tool(self):
        scenario,env,aui,system,ledger=setup_scenario()
        steps=[response('LedgerApp__write',{'value':'blocked'},call_id='blocked'),response(content='User reply')]
        with hook_server(lambda request,state:'block' if request['action']['effect']=='write' else 'allow') as host:
            self.run_bridge(scenario,env,lambda *a:steps.pop(0))
        self.assertEqual(ledger.values,[])
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),1)
        self.assertEqual([m.content for m in aui.messages if m.sender==Sender.AGENT],['User reply'])

    def test_04_text_final_answer_must_pass_live_before_tool(self):
        scenario,env,aui,system,ledger=setup_scenario()
        with hook_server(lambda *unused:'block') as host,patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):
                self.run_bridge(scenario,env,lambda *a:response(content='Must not bypass guard'))
        self.assertFalse([m for m in aui.messages if m.sender==Sender.AGENT])
        self.assertEqual(scenario.judge_calls,0)
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='before_tool']),1)
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),0)

    def test_05_budget_exhaustion_is_technical_not_fake_judged_success(self):
        scenario,env,aui,system,ledger=setup_scenario()
        with hook_server(lambda *unused:'block') as host,patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'2'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):
                self.run_bridge(scenario,env,lambda *a:response('LedgerApp__write',{'value':'blocked'}))
        self.assertEqual(scenario.judge_calls,0)
        self.assertEqual(self.end_event()['terminationReason'],'action_budget_exhausted')
        self.assertFalse(self.end_event()['evaluationAttempted'])
        self.assertEqual(host['requests'][-1]['loop']['terminationReason'],'action_budget_exhausted')
        self.assertFalse(host['requests'][-1]['outcome']['complete'])

    def test_06_model_failure_resumes_official_environment(self):
        scenario,env,aui,system,ledger=setup_scenario()
        def model(*args):
            self.assertEqual(env.state,EnvironmentState.PAUSED)
            raise RuntimeError('controlled model failure')
        with hook_server():
            with self.assertRaises(RuntimeError):self.run_bridge(scenario,env,model)
        self.assertEqual(env.state,EnvironmentState.RUNNING)
        self.assertFalse(env.time_manager.is_paused)
        self.assertEqual(scenario.judge_calls,0)

    def test_07_no_hook_host_fails_before_model(self):
        scenario,env,aui,system,ledger=setup_scenario()
        settings={key:value for key,value in os.environ.items() if not key.startswith('GAIA2_HOOK_')}
        with patch.dict(os.environ,settings,clear=True),patch.object(bridge,'_call_model') as model:
            with self.assertRaises(HookProtocolError):
                bridge._native_run_with_agent(None,scenario.scenario_id,scenario,env,'default','controlled')
        model.assert_not_called()
        self.assertEqual(scenario.judge_calls,0)

    def test_08_corrupt_hook_receipt_fails_before_model(self):
        scenario,env,aui,system,ledger=setup_scenario()
        with hook_server(corrupt=lambda result,request:{**result,'contextHash':'0'*64}),patch.object(bridge,'_call_model') as model:
            with self.assertRaises(HookProtocolError):
                bridge._native_run_with_agent(None,scenario.scenario_id,scenario,env,'default','controlled')
        model.assert_not_called()
        self.assertEqual(scenario.judge_calls,0)

    def test_09_noise_public_names_keep_canonical_finish_semantics(self):
        scenario,env,aui,system,ledger=setup_scenario()
        finish=next(tool for tool in aui.get_tools() if tool.func_name=='send_message_to_user')
        finish._public_name='noisy_reply_731'
        with hook_server() as host:
            self.run_bridge(scenario,env,lambda *a:response('noisy_reply_731',{'content':'Reply through alias'}))
        action=next(r['action'] for r in host['requests'] if r['checkpoint']=='before_tool')
        self.assertEqual(action['effect'],'finish')
        self.assertEqual(action['canonicalName'],'AgentUserInterface__send_message_to_user')
        self.assertEqual(self.end_event()['usage']['completedTurns'],1)

    def test_10_unknown_effect_cannot_be_allowed_by_tool_name(self):
        scenario,env,aui,system,ledger=setup_scenario()
        tool=next(tool for tool in ledger.get_tools() if tool.func_name=='write')
        tool.write_operation=None
        with hook_server() as host,patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):
                self.run_bridge(scenario,env,lambda *a:response('LedgerApp__write',{'value':'not_executed'}))
        self.assertEqual(ledger.values,[])
        action=next(r['action'] for r in host['requests'] if r['checkpoint']=='before_tool')
        self.assertEqual(action['effect'],'unknown')

    def test_11_true_official_wait_jumps_to_arrived_user_notification(self):
        scenario,env,aui,system,ledger=setup_scenario()
        event=Event.from_function(aui.send_message_to_agent,event_type=EventType.USER,content='Message after official wait').at_absolute_time(1010)
        env.event_queue.put(event)
        steps=[]
        def model(messages,*unused):
            steps.append(json.dumps(messages))
            if len(steps)==1:return response('SystemApp__wait_for_notification',{'timeout':30},call_id='wait')
            self.assertIn('Message after official wait',steps[-1])
            return response('AgentUserInterface__send_message_to_user',{'content':'Wait completed'},call_id='finish')
        with hook_server() as host:self.run_bridge(scenario,env,model)
        action=next(r['action'] for r in host['requests'] if r['checkpoint']=='before_tool')
        self.assertEqual(action['effect'],'wait')
        self.assertGreaterEqual(env.time_manager.time(),1010)
        self.assertNotIn('SystemApp__wait',[tool.name for tool in system.get_tools()])

    def test_12_reply_does_not_end_scenario_without_turn_limit(self):
        scenario,env,aui,system,ledger=setup_scenario(turns=None)
        calls=[]
        reply_observed=threading.Event()
        def model(messages,*unused):
            calls.append(messages)
            return response('AgentUserInterface__send_message_to_user',{'content':'First turn complete'})
        def after_reply(request,state):
            if (request['action'].get('canonicalName')=='AgentUserInterface__send_message_to_user'
                    and request['outcome']['status']=='succeeded'):
                reply_observed.set()
        def later():
            # Lifecycle stop comes from a real environment operation, not Actor silence.
            import time
            if reply_observed.wait(5):
                time.sleep(.1)
            env.stop()
        stopper=threading.Thread(target=later);stopper.start()
        with hook_server(after_hook=after_reply):self.run_bridge(scenario,env,model)
        stopper.join(2)
        self.assertTrue(reply_observed.is_set(),'the real reply must execute before environment stop')
        self.assertEqual(self.end_event()['terminationReason'],'environment_stop')
        self.assertEqual(len(calls),1)

    def test_13_business_failure_is_real_judge_result(self):
        scenario,env,aui,system,ledger=setup_scenario(success=False)
        with hook_server():
            result=self.run_bridge(scenario,env,lambda *a:response(content='Finished the attempt'))
        self.assertFalse(result.success)
        self.assertEqual(scenario.judge_calls,1)
        judged=[e for e in self.events if e['type']=='official_validation_completed']
        self.assertEqual(len(judged),1)
        self.assertFalse(judged[0]['validationSuccess'])

    def test_14_exclusive_wait_mixed_batch_is_not_partially_executed(self):
        scenario,env,aui,system,ledger=setup_scenario()
        two=response('LedgerApp__write',{'value':'a'},call_id='one')
        two.choices[0].message.tool_calls.append(response('SystemApp__wait_for_notification',{'timeout':1},call_id='two').choices[0].message.tool_calls[0])
        with hook_server() as host,patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):self.run_bridge(scenario,env,lambda *a:two)
        self.assertEqual(ledger.values,[])
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),0)
        self.assertEqual(host['roundResponses'][0]['state']['status'],'rejected')
        self.assertEqual(host['roundResponses'][0]['state']['reason'],'exclusive_tool_requires_single_call')

    def test_15_client_rejects_remote_proxy_redirect_and_invalid_identity(self):
        for url in ('https://127.0.0.1:1/invoke','http://localhost:1/invoke','http://example.com:1/invoke',
                    'http://127.0.0.1:1/invoke?token=secret','http://user:password@127.0.0.1:1/invoke'):
            with self.assertRaises(HookProtocolError):RuntimeHookClient(url=url,token='token',execution_id='e',session_id='s')
        with self.assertRaises(HookProtocolError):
            RuntimeHookClient(url='http://127.0.0.1:1/invoke',token='token',execution_id='',session_id='s')
        with hook_server(),patch.dict(os.environ,{'HTTP_PROXY':'http://example.com:9','HTTPS_PROXY':'http://example.com:9','NO_PROXY':''}):
            result=RuntimeHookClient().invoke('before_model',loop={'iteration':0,'terminal':False},messages=[],clock={'now':1000,'revision':0})
        self.assertEqual(result['decision']['action'],'allow')

    def test_16_tool_defaults_are_not_misrepresented_as_required(self):
        scenario,env,aui,system,ledger=setup_scenario()
        tool=next(tool for tool in system.get_tools() if tool.func_name=='wait_for_notification')
        self.assertEqual(bridge._native_openai_tool(tool)['function']['parameters']['required'],[])
        self.assertEqual(bridge._native_openai_tool(next(t for t in ledger.get_tools() if t.func_name=='write'))['function']['parameters']['required'],['value'])

    def test_17_second_user_turn_is_observed_after_first_reply(self):
        scenario,env,aui,system,ledger=setup_scenario(turns=2)
        calls=[]
        sent=[]
        def after(request,state):
            if request['action']['effect']=='finish' and not sent:
                sent.append(True)
                aui.send_message_to_agent('Second current request')
        def model(messages,*unused):
            calls.append(json.dumps(messages))
            if len(calls)==1:
                return response('AgentUserInterface__send_message_to_user',{'content':'First reply'},call_id='first')
            self.assertIn('Second current request',calls[-1])
            return response('AgentUserInterface__send_message_to_user',{'content':'Second reply'},call_id='second')
        with hook_server(after_hook=after):self.run_bridge(scenario,env,model)
        self.assertEqual([m.content for m in aui.messages if m.sender==Sender.AGENT],['First reply','Second reply'])
        self.assertEqual(len(calls),2)
        self.assertEqual(self.end_event()['usage']['completedTurns'],2)
        self.assertEqual(scenario.judge_calls,1)

    def test_18_notification_during_hook_gate_cancels_action(self):
        scenario,env,aui,system,ledger=setup_scenario()
        changed=[]
        def policy(request,state):
            if request['action']['effect']=='write' and not changed:
                changed.append(True)
                aui.send_message_to_agent('Change received during live gate')
            return 'allow'
        steps=[response('LedgerApp__write',{'value':'obsolete'},call_id='old'),response(content='Updated reply')]
        def model(messages,*unused):
            if len(steps)==1:self.assertIn('Change received during live gate',json.dumps(messages))
            return steps.pop(0)
        with hook_server(policy) as host:self.run_bridge(scenario,env,model)
        self.assertEqual(ledger.values,[])
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),1)

    def test_19_duplicate_json_arguments_cannot_execute(self):
        scenario,env,aui,system,ledger=setup_scenario()
        invalid=response('LedgerApp__write',{'value':'a'})
        invalid.choices[0].message.tool_calls[0].function.arguments='{"value":"a","value":"b"}'
        with hook_server(),patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):self.run_bridge(scenario,env,lambda *a:invalid)
        self.assertEqual(ledger.values,[])

    def test_20_a2a_read_metadata_is_not_authoritative_read_back(self):
        scenario,env,aui,system,ledger=setup_scenario()
        inner=SimpleNamespace(run=Mock())
        delegated=AppAgent(inner,{},'DelegatedLedger')
        scenario.apps.append(delegated);env.register_apps([delegated])
        tool=delegated.get_tools()[0]
        self.assertFalse(tool.write_operation)
        action=bridge._action_for_tool(tool,'delegate',{'task':'May write through an inner agent'})
        self.assertEqual(action['effect'],'unknown')
        self.assertFalse(action['authoritativeRead'])
        with hook_server(),patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
            with self.assertRaises(bridge.BridgeBudgetExceeded):
                self.run_bridge(scenario,env,lambda *a:response('DelegatedLedger__expert_agent',{'task':'Write value'}))
        inner.run.assert_not_called()

    def test_21_after_tool_rejection_stops_actor_and_judge(self):
        scenario,env,aui,system,ledger=setup_scenario()
        def corrupt(result,request):
            if request['checkpoint']=='after_tool':
                return {**result,'decision':{'action':'block','reason':'controlled_failed_ledger_hook'}}
            return result
        model=Mock(return_value=response('LedgerApp__write',{'value':'already_executed'}))
        with hook_server(corrupt=corrupt) as host:
            with self.assertRaises(HookProtocolError) as caught:self.run_bridge(scenario,env,model)
        self.assertEqual(caught.exception.code,'after_tool_rejected')
        self.assertEqual(model.call_count,1)
        self.assertEqual(ledger.values,['already_executed'])
        self.assertEqual(scenario.judge_calls,0)
        self.assertEqual(host['requests'][-1]['checkpoint'],'attempt_end')
        self.assertFalse(self.end_event()['evaluationAttempted'])

    def test_22_real_official_contact_result_crosses_strict_http_as_actor_visible_text(self):
        scenario,env,aui,system,ledger=setup_scenario()
        contact=Contact(first_name='Controlled',last_name='User',contact_id='observed-contact',is_user=True)
        contacts=Contacts(contacts={contact.contact_id:contact})
        scenario.apps.append(contacts);env.register_apps([contacts])
        steps=[response('Contacts__get_current_user_details',call_id='contact-read'),response(content='Contact observed')]
        actor_inputs=[]
        def model(messages,*unused):
            actor_inputs.append(copy.deepcopy(messages))
            return steps.pop(0)
        with hook_server() as host:self.run_bridge(scenario,env,model)
        after=next(r for r in host['requests'] if r['checkpoint']=='after_tool' and r['action']['id']=='contact-read')
        self.assertEqual(after['outcome']['result'],str(contact))
        self.assertEqual(after['outcome']['resultHash'],bridge._stable_hash(contact))
        self.assertEqual(after['outcome']['resultHash'],bridge._stable_hash(after['outcome']['result']))
        observed=next(m for m in actor_inputs[1] if m.get('tool_call_id')=='contact-read')
        self.assertEqual(json.loads(observed['content']),after['outcome']['result'])
        self.assertEqual(scenario.judge_calls,1)

    def test_23_nested_objects_use_exact_default_str_actor_view_and_original_hash(self):
        class ContactLike:
            def __str__(self):return 'public controlled contact-like detail'
        scenario,env,aui,system,ledger=setup_scenario()
        original={'contacts':[Contact(first_name='Nested',last_name='Contact',contact_id='nested-contact'),
                              {'custom':ContactLike()}],'tuple':(ContactLike(),None),'finite':1.25}
        ledger.read_result=original
        expected=json.loads(json.dumps(original,default=str,ensure_ascii=False,allow_nan=False))
        steps=[response('LedgerApp__read',call_id='nested-read'),response(content='Nested evidence observed')]
        actor_inputs=[]
        def model(messages,*unused):
            actor_inputs.append(copy.deepcopy(messages));return steps.pop(0)
        with hook_server() as host:self.run_bridge(scenario,env,model)
        after=next(r for r in host['requests'] if r['checkpoint']=='after_tool' and r['action']['id']=='nested-read')
        self.assertEqual(after['outcome']['result'],expected)
        self.assertEqual(after['outcome']['resultHash'],bridge._stable_hash(original))
        self.assertEqual(after['outcome']['resultHash'],bridge._stable_hash(expected))
        observed=next(m for m in actor_inputs[1] if m.get('tool_call_id')=='nested-read')
        self.assertEqual(json.loads(observed['content']),expected)
        self.assertEqual(ledger.reads,1)

    def test_24_nonfinite_tool_results_fail_closed_before_ipc_actor_or_judge(self):
        for value in (float('nan'),float('inf'),float('-inf'),{'nested':[float('nan')]}):
            with self.subTest(value=type(value).__name__):
                scenario,env,aui,system,ledger=setup_scenario()
                ledger.read_result=value
                model=Mock(return_value=response('LedgerApp__read',call_id='nonfinite-read'))
                with hook_server() as host:
                    with self.assertRaises(HookProtocolError) as caught:self.run_bridge(scenario,env,model)
                self.assertEqual(caught.exception.code,'invalid_tool_result_payload')
                self.assertEqual(model.call_count,1)
                self.assertEqual(ledger.reads,1)
                self.assertEqual(scenario.judge_calls,0)
                self.assertFalse(any(r['checkpoint']=='after_tool' for r in host['requests']))
                self.assertEqual(host['requests'][-1]['checkpoint'],'attempt_end')
                self.assertFalse(self.end_event()['evaluationAttempted'])
                self.assertEqual(env.state,EnvironmentState.RUNNING)

    def test_25_request_enables_multiple_calls_and_disables_parameter_dropping(self):
        with patch.object(bridge,'completion') as completion:
            bridge._call_model([{'role':'user','content':'Controlled request'}],[],
                               'controlled-no-model','openai','http://127.0.0.1:1/v1')
        request=completion.call_args.kwargs
        self.assertIs(request['parallel_tool_calls'],True)
        self.assertIs(request['drop_params'],False)
        self.assertEqual(request['additional_drop_params'],[])
        self.assertEqual(request['allowed_openai_params'],[])
        self.assertEqual(request['tool_choice'],'auto')

    def test_26_final_http_payload_contains_true_and_single_action_finishes(self):
        scenario,env,aui,system,ledger=setup_scenario()
        replies=[response('LedgerApp__read',call_id='single-read'),response(content='Single-action transport completed')]
        with hook_server() as host,completion_server(replies) as (server,endpoint):
            result=self.run_transport(scenario,env,endpoint)
        self.assertTrue(result.success)
        self.assertEqual(len(server['requests']),2)
        for request in server['requests']:
            self.assertIn('parallel_tool_calls',request)
            self.assertIs(request['parallel_tool_calls'],True)
            self.assertEqual(request['tool_choice'],'auto')
            self.assertTrue(request['tools'])
            self.assertNotIn('drop_params',request)
            self.assertNotIn('additional_drop_params',request)
            self.assertNotIn('allowed_openai_params',request)
        self.assertEqual(ledger.reads,1)
        self.assertEqual(scenario.judge_calls,1)
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),2)

    def test_27_server_rejecting_parameter_is_technical_without_retry_tools_or_judge(self):
        scenario,env,aui,system,ledger=setup_scenario()
        with hook_server() as host,completion_server(reject=True) as (server,endpoint):
            with self.assertRaises(ModelRequestFailure) as caught:self.run_transport(scenario,env,endpoint)
        self.assertEqual(caught.exception.category,'configuration_error')
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(server['requests']),1)
        self.assertIs(server['requests'][0]['parallel_tool_calls'],True)
        self.assertEqual(ledger.values,[]);self.assertEqual(ledger.reads,0)
        self.assertEqual(scenario.judge_calls,0)
        self.assertFalse(any(r['checkpoint'] in ('before_tool','after_tool') for r in host['requests']))
        self.assertEqual(self.end_event()['terminationReason'],'technical_failure')
        self.assertFalse(self.end_event()['evaluationAttempted'])
        self.assertEqual(self.end_event()['usage']['toolsExecuted'],0)
        self.assertEqual(env.state,EnvironmentState.RUNNING)
        self.assertFalse(env.time_manager.is_paused)
        self.assertFalse(any(e['type']=='model_retry_scheduled' for e in self.events))
        protocol_failure_audits.append({'case':'server_unsupported_parameter','exceptionType':type(caught.exception).__name__,
                                        'events':copy.deepcopy(self.events)})

    def test_28_local_unsupported_parameter_is_technical_before_http(self):
        scenario,env,aui,system,ledger=setup_scenario()
        supported=litellm.get_supported_openai_params(model='gpt-4o-mini',custom_llm_provider='openai')
        supported=[name for name in supported if name!='parallel_tool_calls']
        with hook_server() as host,completion_server() as (server,endpoint),\
             patch('litellm.utils.get_supported_openai_params',return_value=supported):
            with self.assertRaises(ModelRequestFailure) as caught:self.run_transport(scenario,env,endpoint)
        self.assertEqual(caught.exception.category,'configuration_error')
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(server['requests'],[])
        self.assertEqual(scenario.judge_calls,0)
        self.assertEqual(ledger.values,[]);self.assertEqual(ledger.reads,0)
        self.assertFalse(any(r['checkpoint'] in ('before_tool','after_tool') for r in host['requests']))
        self.assertEqual(self.end_event()['terminationReason'],'technical_failure')
        self.assertFalse(self.end_event()['evaluationAttempted'])
        self.assertEqual(env.state,EnvironmentState.RUNNING)
        self.assertFalse(any(e['type']=='model_retry_scheduled' for e in self.events))
        protocol_failure_audits.append({'case':'local_unsupported_parameter','exceptionType':type(caught.exception).__name__,
                                        'events':copy.deepcopy(self.events)})

    def test_29_exclusive_reply_in_three_or_four_call_batches_cannot_partially_execute(self):
        for count in (3,4):
            with self.subTest(count=count):
                scenario,env,aui,system,ledger=setup_scenario()
                batch=response('LedgerApp__write',{'value':'unsafe-0'},call_id='batch-0')
                for index in range(1,count):
                    batch.choices[0].message.tool_calls.extend(response(
                        'AgentUserInterface__send_message_to_user' if index==count-1 else 'LedgerApp__write',
                        {'content':'Must not notify'} if index==count-1 else {'value':'unsafe-'+str(index)},
                        call_id='batch-'+str(index)).choices[0].message.tool_calls)
                with hook_server() as host,completion_server([batch]) as (server,endpoint),\
                     patch.dict(os.environ,{'GAIA2_E2E_MAX_ACTIONS':'1'}):
                    with self.assertRaises(bridge.BridgeBudgetExceeded):self.run_transport(scenario,env,endpoint)
                self.assertEqual(len(server['requests']),1)
                self.assertIs(server['requests'][0]['parallel_tool_calls'],True)
                self.assertEqual(ledger.values,[]);self.assertEqual(ledger.reads,0)
                self.assertEqual(scenario.judge_calls,0)
                self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='before_tool']),0)
                self.assertFalse(any(r['checkpoint']=='after_tool' for r in host['requests']))
                blocked=[e for e in self.events if e['type']=='tool_call_cancelled'][-count:]
                self.assertEqual([e['reason'] for e in blocked],['exclusive_tool_requires_single_call']*count)
                observations=[json.loads(m['content']) for m in host['requests'][-1]['messages'] if m['role']=='tool']
                self.assertEqual(len(observations),count)
                self.assertTrue(all(not item['executed'] for item in observations))
                self.assertTrue(all(item['status']=='cancelled' and item['reason']=='exclusive_tool_requires_single_call' for item in observations))
                self.assertEqual(host['roundResponses'][0]['state']['status'],'rejected')
                self.assertEqual([r['op'] for r in host['roundRequests']],['begin'])

    def test_30_exclusive_batch_feedback_enters_next_http_request_for_replanning(self):
        scenario,env,aui,system,ledger=setup_scenario()
        batch=response('LedgerApp__write',{'value':'cancelled-first'},call_id='multi-first')
        batch.choices[0].message.tool_calls.extend(response('SystemApp__wait_for_notification',{'timeout':1},
                                                           call_id='multi-second').choices[0].message.tool_calls)
        replies=[batch,response('LedgerApp__write',{'value':'replanned'},call_id='fresh-single'),response(content='Completed')]
        with hook_server() as host,completion_server(replies) as (server,endpoint):
            self.run_transport(scenario,env,endpoint)
        self.assertEqual(ledger.values,['replanned'])
        self.assertEqual(len(server['requests']),3)
        observations=[json.loads(message['content']) for message in server['requests'][1]['messages'] if message['role']=='tool']
        self.assertEqual(len(observations),2)
        self.assertTrue(all(item['reason']=='exclusive_tool_requires_single_call' for item in observations))
        self.assertTrue(all(item['status']=='cancelled' and not item['executed'] for item in observations))
        self.assertEqual([m['tool_call_id'] for m in server['requests'][1]['messages'] if m['role']=='tool'],['multi-first','multi-second'])
        self.assertEqual(host['roundResponses'][0]['state']['status'],'rejected')
        self.assertEqual(len([r for r in host['requests'] if r['checkpoint']=='after_tool']),2)
        self.assertEqual(scenario.judge_calls,1)

    def test_30b_oversized_parallel_round_is_replanned_without_hook_failure(self):
        scenario,env,aui,system,ledger=setup_scenario()
        oversized=response('LedgerApp__read',call_id='oversized-0')
        for index in range(1,65):
            oversized.choices[0].message.tool_calls.extend(
                response('LedgerApp__read',call_id=f'oversized-{index}').choices[0].message.tool_calls)
        replies=[oversized,
                 response('LedgerApp__read',call_id='bounded-read'),
                 response('AgentUserInterface__send_message_to_user',
                          {'content':'Oversized round was replanned'},call_id='finish')]
        with hook_server() as host,completion_server(replies) as (server,endpoint):
            result=self.run_transport(scenario,env,endpoint)
        self.assertTrue(result.success)
        self.assertEqual(ledger.reads,1)
        self.assertEqual(scenario.judge_calls,1)
        self.assertEqual(len(server['requests']),3)
        self.assertTrue(any(e['type']=='tool_round_rejected'
                            and e['reason']=='parallel_tool_round_limit'
                            and e['totalCalls']==65 for e in self.events))
        cancelled=[e for e in self.events
                   if e['type']=='tool_call_cancelled'
                   and e['reason']=='parallel_tool_round_limit']
        self.assertEqual(len(cancelled),65)
        first_observations=[json.loads(message['content']) for message in server['requests'][1]['messages']
                            if message.get('tool_call_id','').startswith('oversized-')]
        self.assertEqual(len(first_observations),65)
        self.assertTrue(all(item['status']=='blocked' and not item['executed']
                            and item['reason']=='parallel_tool_round_limit'
                            for item in first_observations))
        self.assertFalse(any(e['type']=='attempt_execution_ended'
                             and e['terminationReason']=='live_hook_failure' for e in self.events))

    def test_31_unsafe_global_parameter_transforms_fail_before_transport(self):
        for setting in ('drop_params','modify_params','add_function_to_prompt'):
            with self.subTest(setting=setting):
                scenario,env,aui,system,ledger=setup_scenario()
                with hook_server() as host,completion_server() as (server,endpoint),patch.object(litellm,setting,True):
                    with self.assertRaises(bridge.BridgeModelProtocolError) as caught:self.run_transport(scenario,env,endpoint)
                self.assertEqual(caught.exception.code,'unsafe_litellm_'+setting)
                self.assertEqual(server['requests'],[])
                self.assertEqual(ledger.values,[]);self.assertEqual(scenario.judge_calls,0)
                self.assertFalse(any(r['checkpoint'] in ('before_tool','after_tool') for r in host['requests']))
                self.assertEqual(self.end_event()['terminationReason'],'technical_failure')
                self.assertFalse(self.end_event()['evaluationAttempted'])
                self.assertEqual(env.state,EnvironmentState.RUNNING)

    def test_32_install_rejects_global_drop_before_retry_install_can_clear_it(self):
        with patch.object(litellm,'drop_params',True),patch.object(bridge,'install_model_retries') as install:
            with self.assertRaises(bridge.BridgeModelProtocolError) as caught:bridge.install()
            self.assertIs(litellm.drop_params,True)
        self.assertEqual(caught.exception.code,'unsafe_litellm_drop_params')
        install.assert_not_called()

    def test_33_readonly_strategy_consumed_in_every_real_actor_request(self):
        scenario,env,aui,system,ledger=setup_scenario()
        text='Fixed controlled procedure. Observe before choosing the next action.'
        strategy_hash=hashlib.sha256(text.encode()).hexdigest()
        settings={'GAIA2_E2E_CORRECTION_ORDINAL':'1','GAIA2_CORRECTION_STRATEGY_TEXT':text,
                  'GAIA2_CORRECTION_STRATEGY_HASH':strategy_hash,'GAIA2_CORRECTION_CONTEXT_HASH':'a'*64}
        def context(receipt,request):
            receipt['context']+='\n'+text
            receipt['contextHash']=hashlib.sha256(receipt['context'].encode()).hexdigest()
            return receipt
        inputs=[]
        def model(messages,*unused):
            inputs.append(copy.deepcopy(messages))
            return response('LedgerApp__read',call_id='fresh-read') if len(inputs)==1 else response(content='Done')
        with hook_server(corrupt=context),patch.dict(os.environ,settings):self.run_bridge(scenario,env,model)
        injections=[event for event in self.events if event['type']=='dynamic_context_injected']
        self.assertEqual(len(inputs),2);self.assertEqual(len(injections),2)
        for messages,event in zip(inputs,injections):
            self.assertIn(text,messages[1]['content'])
            self.assertEqual(event['consumedStrategyHash'],strategy_hash)
            self.assertEqual(event['correctionContextHash'],'a'*64)
            self.assertEqual(event['actorInputHash'],bridge._stable_hash(messages))

    def test_34_missing_or_changed_strategy_fails_before_actor_tool_and_judge(self):
        for hash_value in (hashlib.sha256(b'fixed template').hexdigest(),'b'*64):
            with self.subTest(hash=hash_value):
                scenario,env,aui,system,ledger=setup_scenario();model=Mock()
                settings={'GAIA2_E2E_CORRECTION_ORDINAL':'1','GAIA2_CORRECTION_STRATEGY_TEXT':'fixed template',
                          'GAIA2_CORRECTION_STRATEGY_HASH':hash_value,'GAIA2_CORRECTION_CONTEXT_HASH':'a'*64}
                with hook_server(),patch.dict(os.environ,settings):
                    with self.assertRaises(HookProtocolError) as caught:self.run_bridge(scenario,env,model)
                self.assertEqual(caught.exception.code,'correction_strategy_not_consumed')
                model.assert_not_called();self.assertEqual(ledger.values,[]);self.assertEqual(scenario.judge_calls,0)

    def test_35_initial_actor_rejects_inherited_correction_context(self):
        scenario,env,aui,system,ledger=setup_scenario();model=Mock()
        with hook_server(),patch.dict(os.environ,{'GAIA2_E2E_CORRECTION_ORDINAL':'0','GAIA2_CORRECTION_STRATEGY_TEXT':'forbidden'}):
            with self.assertRaises(HookProtocolError) as caught:self.run_bridge(scenario,env,model)
        self.assertEqual(caught.exception.code,'initial_actor_has_correction')
        model.assert_not_called();self.assertEqual(ledger.values,[]);self.assertEqual(scenario.judge_calls,0)

    def check_argument_preflight(self,case):
        with hook_server() as host:audit=run_argument_preflight_case(case)
        gates=[r for r in host['requests'] if r['checkpoint']=='before_tool']
        after=[r for r in host['requests'] if r['checkpoint']=='after_tool']
        self.assertEqual(len(gates),audit['usage']['toolCalls'])
        self.assertEqual(len(after),audit['usage']['toolsExecuted'])
        for rejected in audit['rejected']:
            gate=next(r for r in gates if r['action']['id']==rejected['id'])
            self.assertFalse(any(r['action']['id']==rejected['id'] for r in after))
            if rejected['reason']=='unsafe_json_argument':self.assertEqual(gate['action']['arguments'],{})
        self.assertEqual(host['requests'][-1]['checkpoint'],'attempt_end')
        self.assertEqual(host['requests'][-1]['outcome']['usage']['completedTurns'],1)

    def test_36_empty_explicit_and_default_finish_cannot_record_or_end_a_turn(self):
        self.check_argument_preflight('finish')

    def test_37_non_aui_empty_defaults_are_rejected_before_read_or_write(self):
        self.check_argument_preflight('defaults')

    def test_38_unsafe_json_is_sanitized_but_none_and_nested_empty_values_execute(self):
        self.check_argument_preflight('unsafe_json')

    def test_39_binding_errors_do_not_invoke_the_official_tool(self):
        self.check_argument_preflight('binding')

    def test_40_actor_reconciliation_roundtrip_reaches_the_real_bridge_path(self):
        scenario, env, aui, system, ledger = setup_scenario()
        calls = []

        def model(messages, *unused):
            calls.append(copy.deepcopy(messages))
            if len(calls) == 1:
                return response('capybara_task_reconcile', {
                    'mode': 'enforce', 'quote': 'Initial request', 'obligations': [],
                }, call_id='reconcile-entry')
            if len(calls) == 2:
                return response('AgentUserInterface__send_message_to_user',
                                {'content': 'Reconciliation roundtrip complete'}, call_id='finish-entry')
            raise AssertionError('model unexpectedly continued')

        with hook_server() as host, patch.dict(os.environ, {'GAIA2_TASK_RECONCILIATION_ENABLED': '1'}):
            result = self.run_bridge(scenario, env, model)
        self.assertTrue(result.success)
        self.assertEqual(len(calls), 2)
        completed = [event for event in self.events if event['type'] == 'task_reconciliation_completed']
        self.assertEqual(len(completed), 1)
        inventory = [event for event in self.events if event['type'] == 'official_tool_inventory']
        self.assertEqual(len(inventory), 1)
        self.assertTrue(inventory[0]['taskReconciliationEnabled'])
        self.assertEqual(completed[0]['mode'], 'enforce')
        self.assertEqual(completed[0]['status'], 'succeeded')
        self.assertFalse(completed[0]['oracleConsulted'])
        reconciliation_before = [request for request in host['requests']
                                 if request['checkpoint'] == 'before_tool'
                                 and request['action']['canonicalName'] == 'CapybaraTaskContract__review']
        reconciliation_after = [request for request in host['requests']
                                if request['checkpoint'] == 'after_tool'
                                and request['action']['canonicalName'] == 'CapybaraTaskContract__review']
        self.assertEqual(len(reconciliation_before), 1)
        self.assertEqual(len(reconciliation_after), 1)
        self.assertEqual(reconciliation_before[0]['action']['id'], completed[0]['callId'])
        self.assertEqual(reconciliation_after[0]['action']['id'], completed[0]['callId'])
        self.assertEqual(aui.messages[-1].content, 'Reconciliation roundtrip complete')
        self.assertEqual(host['requests'][-1]['checkpoint'], 'attempt_end')

    def test_41_invalid_reconciliation_quote_is_feedback_not_success(self):
        scenario, env, aui, system, ledger = setup_scenario()
        calls = []

        def model(messages, *unused):
            calls.append(copy.deepcopy(messages))
            if len(calls) == 1:
                return response('capybara_task_reconcile', {
                    'mode': 'enforce', 'quote': 'not present in USER history', 'obligations': [],
                }, call_id='reconcile-invalid')
            return response('AgentUserInterface__send_message_to_user',
                            {'content': 'Recovered after reconciliation feedback'}, call_id='finish-recovered')

        with hook_server() as host, patch.dict(os.environ, {'GAIA2_TASK_RECONCILIATION_ENABLED': '1'}):
            result = self.run_bridge(scenario, env, model)
        self.assertTrue(result.success)
        failed = [event for event in self.events if event['type'] == 'task_reconciliation_completed']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['status'], 'failed_before_execution')
        self.assertEqual(failed[0]['reason'], 'task_reconciliation_quote_binding')
        feedback = [message for message in calls[1]
                    if message.get('role') == 'tool' and message.get('tool_call_id') == 'reconcile-invalid']
        self.assertEqual(len(feedback), 1)
        feedback_payload = json.loads(feedback[0]['content'])
        self.assertEqual(feedback_payload['errorCode'], 'task_reconciliation_quote_binding')
        self.assertIn('quote', feedback_payload['requiredFields'])
        self.assertNotIn('expectedActions', feedback_payload)
        self.assertEqual(aui.messages[-1].content, 'Recovered after reconciliation feedback')
        reconcile_after = [request for request in host['requests']
                           if request['checkpoint'] == 'after_tool'
                           and request['action']['canonicalName'] == 'CapybaraTaskContract__review']
        self.assertEqual(reconcile_after, [])

if len(sys.argv)==3 and sys.argv[1]=='--argument-preflight-fixture':
    if sys.argv[2] not in ARGUMENT_PREFLIGHT_CASES:raise SystemExit('unknown controlled fixture')
    print('ARGUMENT_PREFLIGHT_AUDIT:'+json.dumps(run_argument_preflight_case(sys.argv[2])))
else:
    completed=unittest.main(argv=['phase3_bridge_test'],verbosity=2,exit=False)
    print('MODEL_PROTOCOL_FAILURE_AUDITS:'+json.dumps(protocol_failure_audits))
    if not completed.result.wasSuccessful():raise SystemExit(1)
