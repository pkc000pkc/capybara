"""One HTTP dispatch per trusted SDK attempt, using public synchronous clients.

This opt-in production boundary consumes the Node-owned official entry receipt.
It never journals HTTP bodies, headers, credentials, URLs or exception text.
The journal is independent of the bridge's best-effort runtime event emitter.
Python privacy is not a sandbox against hostile code in the same interpreter.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
from contextvars import ContextVar
from urllib.parse import urlsplit

SCHEMA = "gaia2-model-http-dispatch-v1"
FAILURE_CODES = frozenset({
    "HTTP_GUARD_ENTRY_INVALID", "HTTP_GUARD_ENTRY_CHANGED", "HTTP_GUARD_REQUIRED_CHANGED",
    "HTTP_GUARD_JOURNAL_FAILED", "HTTP_GUARD_IDENTITY_INVALID", "HTTP_GUARD_ATTEMPT_REPLAY",
    "HTTP_GUARD_NESTED_ATTEMPT", "HTTP_GUARD_SCOPE_INVALID", "HTTP_GUARD_MODE_UNSUPPORTED",
    "HTTP_GUARD_CLIENT_INJECTION", "HTTP_GUARD_UNSAFE_GLOBAL_CONFIG", "HTTP_GUARD_KWARGS_INVALID",
    "HTTP_GUARD_ROUTE_INVALID", "HTTP_GUARD_BODY_UNBUFFERED", "HTTP_GUARD_REDISPATCH_DENIED",
    "HTTP_GUARD_RESPONSE_INVALID", "HTTP_GUARD_CLIENT_CLOSE_FAILED", "HTTP_GUARD_NO_DISPATCH",
    "SDK_CALL_FAILED", "SDK_CALL_CANCELLED",
})
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_REQUEST = re.compile(r"[a-f0-9]{32}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\Z")
_ROLES = ("actor", "judge", "correction", "child_actor")
_CHILD_FIELDS = {"permitId", "actualInputHash", "modelScopeHash", "configHash",
    "parentExecutionId", "parentSessionId", "childExecutionId", "childSessionId", "delegationScopeHash"}
_ENTRY_FIELDS = {"schemaVersion", "runId", "manifestHash", "executionId", "sessionId", "scenarioId",
    "scenarioVersion", "scenarioHash", "config", "runNumber", "attemptIndex", "correctionOrdinal", "phase", "launcherProcessId"}
_active_lease = ContextVar("gaia2_model_http_dispatch_lease", default=None)
_controller = None
_controller_lock = threading.RLock()


class ModelHttpGuardFailure(ValueError):
    status_code = 400
    body = {"error": {"code": "configuration_error"}}

    def __init__(self, code):
        self.guard_code = code if code in FAILURE_CODES else "HTTP_GUARD_SCOPE_INVALID"
        super().__init__(self.guard_code)


def _fail(code):
    raise ModelHttpGuardFailure(code) from None


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _plain_path(path, *, must_exist=True):
    path = Path(path).absolute()
    for current in (path, *path.parents):
        try:
            info = current.lstat()
        except FileNotFoundError:
            if current == path and not must_exist:
                continue
            raise
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError()
    if path.resolve(strict=must_exist) != path:
        raise ValueError()
    return path


def _entry_binding():
    try:
        if (os.environ.get("GAIA2_MODEL_HTTP_GUARD_REQUIRED") != "1"
                or os.environ.get("GAIA2_OFFICIAL_ENTRY_REQUIRED") != "1"):
            raise ValueError()
        expected_sha = os.environ.get("GAIA2_OFFICIAL_ENTRY_SHA256", "")
        if not _HASH.fullmatch(expected_sha):
            raise ValueError()
        entry = _plain_path(os.environ["GAIA2_OFFICIAL_ENTRY_PATH"])
        event = _plain_path(os.environ["GAIA2_RUNTIME_EVENT_FILE"], must_exist=False)
        if (entry.name != "run-manifest.json" or entry.parent.name != "official-entry"
                or entry.parent.parent != event.parent or event.name != "runtime-events.jsonl"):
            raise ValueError()
        raw = entry.read_bytes()
        value = json.loads(raw.decode("utf-8"))
        if (type(value) is not dict or set(value) != _ENTRY_FIELDS or _sha(raw) != expected_sha
                or value["schemaVersion"] != "gaia2-official-entry-handshake-v1"
                or _json(value) + b"\n" != raw):
            raise ValueError()
        for name in ("runId", "executionId", "sessionId", "scenarioId", "scenarioVersion", "config", "phase"):
            if type(value[name]) is not str or not _ID.fullmatch(value[name]):
                raise ValueError()
        if (not _HASH.fullmatch(value["manifestHash"]) or not _HASH.fullmatch(value["scenarioHash"])
                or value["executionId"] != os.environ.get("GAIA2_EXECUTION_ID")
                or value["sessionId"] != os.environ.get("GAIA2_SESSION_ID")):
            raise ValueError()
        for name in ("runNumber", "attemptIndex", "correctionOrdinal", "launcherProcessId"):
            if type(value[name]) is not int or value[name] < (1 if name in ("runNumber", "launcherProcessId") else 0):
                raise ValueError()
        identity = {name: value[name] for name in ("runId", "manifestHash", "executionId", "sessionId", "scenarioId")}
        identity.update(entrySha256=expected_sha, pythonProcessId=os.getpid())
        return entry, event, identity
    except BaseException:
        _fail("HTTP_GUARD_ENTRY_INVALID")


class _Journal:
    def __init__(self, entry, event, identity):
        self.entry, self.event, self.identity = entry, event, identity
        self.path = event.parent / "model-http-dispatch.jsonl"
        self.lock = threading.RLock()
        self.failed = False
        self.sequence = 0
        self.previous = None
        self.expected_size = 0
        self.expected_hash = _sha(b"")
        self.used_attempts = set()
        self.fd = None
        try:
            _plain_path(self.path, must_exist=False)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND | getattr(os, "O_BINARY", 0)
            self.fd = os.open(self.path, flags, 0o600)
            info = os.fstat(self.fd)
            self.file_identity = (info.st_dev, info.st_ino)
            self.append("guard_initialized", guardRequired=True, clientFamily="httpx2",
                maxSdkHttpDispatches=1, sdkMaxRetries=0)
        except BaseException:
            self.failed = True
            if self.fd is not None:
                os.close(self.fd)
                self.fd = None
            _fail("HTTP_GUARD_JOURNAL_FAILED")

    def append(self, kind, *, attempt=None, **fields):
        with self.lock:
            try:
                if self.failed or self.fd is None:
                    raise ValueError()
                entry, event, identity = _entry_binding()
                if (entry, event, identity) != (self.entry, self.event, self.identity):
                    raise ValueError()
                _plain_path(self.path)
                info = self.path.stat()
                descriptor = os.fstat(self.fd)
                raw = self.path.read_bytes()
                if ((info.st_dev, info.st_ino) != self.file_identity
                        or (descriptor.st_dev, descriptor.st_ino) != self.file_identity or len(raw) != self.expected_size
                        or _sha(raw) != self.expected_hash):
                    raise ValueError()
                record = {"schemaVersion": SCHEMA, "type": kind, "sequence": self.sequence + 1,
                    "previousRecordSha256": self.previous, **self.identity, **(attempt or {}), **fields}
                record_hash = _sha(_json(record))
                record["recordSha256"] = record_hash
                encoded = _json(record) + b"\n"
                if os.write(self.fd, encoded) != len(encoded):
                    raise OSError()
                os.fsync(self.fd)
                actual = self.path.read_bytes()
                if actual != raw + encoded:
                    raise OSError()
                self.sequence += 1
                self.previous = record_hash
                self.expected_size = len(actual)
                self.expected_hash = _sha(actual)
                return record_hash
            except BaseException:
                self.failed = True
                _fail("HTTP_GUARD_JOURNAL_FAILED")

    def claim(self, identity):
        with self.lock:
            key = (identity["modelRole"], identity["requestId"], identity["requestAttempt"])
            if self.failed:
                _fail("HTTP_GUARD_JOURNAL_FAILED")
            if key in self.used_attempts:
                _fail("HTTP_GUARD_ATTEMPT_REPLAY")
            self.used_attempts.add(key)


def install_model_http_guard():
    """Initialize exactly once at the trusted official process entrance."""
    global _controller
    with _controller_lock:
        if os.environ.get("GAIA2_MODEL_HTTP_GUARD_REQUIRED") != "1":
            if _controller is not None:
                _fail("HTTP_GUARD_REQUIRED_CHANGED")
            return None
        entry, event, identity = _entry_binding()
        if _controller is None:
            _controller = _Journal(entry, event, identity)
        elif (_controller.entry, _controller.event, _controller.identity) != (entry, event, identity):
            _fail("HTTP_GUARD_ENTRY_CHANGED")
        return _controller


def _attempt_identity(role, request_id, request_attempt, additional):
    if (role not in _ROLES or type(request_id) is not str or not _REQUEST.fullmatch(request_id)
            or type(request_attempt) is not int or not 1 <= request_attempt <= 100000):
        _fail("HTTP_GUARD_IDENTITY_INVALID")
    identity = {"modelRole": role, "requestId": request_id, "requestAttempt": request_attempt}
    if role != "child_actor":
        if additional is not None:
            _fail("HTTP_GUARD_IDENTITY_INVALID")
        return identity
    if type(additional) is not dict or set(additional) != _CHILD_FIELDS:
        _fail("HTTP_GUARD_IDENTITY_INVALID")
    for name, value in additional.items():
        pattern = _REQUEST if name == "permitId" else _HASH if name.endswith("Hash") else _ID
        if type(value) is not str or not pattern.fullmatch(value):
            _fail("HTTP_GUARD_IDENTITY_INVALID")
    identity.update(additional)
    return identity


class _AttemptFailureReceipt:
    """Caller-owned, single-use evidence; never an SDK exception attribute.

    The receipt is kept outside SDK kwargs. Only a fully journaled, healthy
    lease closure can seal it, and consumption must name the exact exception
    and trusted attempt that created it. No request or response text is stored.
    """
    def __init__(self, role, request_id, request_attempt):
        self.identity = _attempt_identity(role, request_id, request_attempt, None)
        self.owner = threading.get_ident()
        self.consumed = False
        self._proof = None

    def _seal(self, lease, failure, closed_hash):
        if (self.consumed or self._proof is not None or self.identity != lease.identity
                or self.owner != lease.owner or self.owner != threading.get_ident()
                or not isinstance(failure, Exception) or lease.failure_code is not None
                or lease.before_dispatch_failure is not None or not lease.closed
                or lease.admitted != 1 or lease.denied != 0 or lease.responses != 1
                or type(lease.response_status) is not int or lease.journal.failed
                or type(closed_hash) is not str or not _HASH.fullmatch(closed_hash)):
            return
        self._proof = (failure, lease.journal, lease.response_status, closed_hash)

    def consume(self, error, role, request_id, request_attempt):
        """An unsuccessful/mismatched consumption also burns the receipt."""
        proof, self._proof = self._proof, None
        if self.consumed:
            return None
        self.consumed = True
        if (proof is None or self.owner != threading.get_ident()
                or type(request_id) is not str or type(request_attempt) is not int
                or self.identity != {"modelRole": role, "requestId": request_id,
                    "requestAttempt": request_attempt}):
            return None
        failure, journal, status, closed_hash = proof
        if (failure is not error or journal is not _controller or journal.failed
                or journal.fd is None or install_model_http_guard() is not journal):
            return None
        return {"responseStatus": status, "closedRecordSha256": closed_hash}


class _Lease:
    def __init__(self, journal, identity, before_dispatch=None):
        self.journal, self.identity = journal, identity
        self.owner = threading.get_ident()
        self.lock = threading.RLock()
        self.admitted = self.denied = self.responses = 0
        self.body_hash = None
        self.response_status = None
        self.failure_code = None
        self.closed = False
        self.expected_url = None
        self.before_dispatch = before_dispatch
        self.before_dispatch_failure = None

    def fail(self, code):
        self.failure_code = self.failure_code or code
        _fail(self.failure_code)

    def emit(self, kind, **fields):
        try:
            return self.journal.append(kind, attempt=self.identity, **fields)
        except BaseException:
            self.failure_code = "HTTP_GUARD_JOURNAL_FAILED"
            _fail(self.failure_code)

    def request_hook(self, request):
        with self.lock:
            if self.closed or _active_lease.get() is not self or self.owner != threading.get_ident():
                self.fail("HTTP_GUARD_SCOPE_INVALID")
            if self.admitted:
                try:
                    candidate = _sha(request.content)
                except BaseException:
                    candidate = None
                self.denied += 1
                self.failure_code = "HTTP_GUARD_REDISPATCH_DENIED"
                self.emit("redispatch_denied", admittedDispatches=self.admitted, deniedDispatches=self.denied,
                    originalBodyHash=self.body_hash, candidateBodyHash=candidate,
                    candidateHashAvailable=candidate is not None, localGuardFailure=True)
                self.fail("HTTP_GUARD_REDISPATCH_DENIED")
            if self.failure_code is not None:
                self.fail(self.failure_code)
            if self.before_dispatch_failure is not None:
                raise self.before_dispatch_failure from None
            if request.method != "POST" or str(request.url) != self.expected_url:
                self.fail("HTTP_GUARD_ROUTE_INVALID")
            try:
                body_hash = _sha(request.content)
            except BaseException:
                self.fail("HTTP_GUARD_BODY_UNBUFFERED")
            # Trusted scoped deadlines may expire while the Node ACK or SDK
            # prepares this request. Check at the last public pre-send hook,
            # after opening the lease but BEFORE admitting any HTTP dispatch.
            if self.before_dispatch is not None:
                try:
                    returned = self.before_dispatch()
                except BaseException as error:
                    self.before_dispatch_failure = error
                    raise error from None
                if returned is not None:
                    self.fail("HTTP_GUARD_SCOPE_INVALID")
            self.emit("dispatch_admitted", requestBodyHash=body_hash, admittedDispatches=1)
            self.body_hash, self.admitted = body_hash, 1

    def response_hook(self, response):
        with self.lock:
            if (self.closed or _active_lease.get() is not self or self.owner != threading.get_ident()
                    or self.admitted != 1 or self.responses != 0
                    or type(response.status_code) is not int or not 100 <= response.status_code <= 599):
                self.fail("HTTP_GUARD_RESPONSE_INVALID")
            self.emit("dispatch_response", admittedDispatches=1, requestBodyHash=self.body_hash,
                responseStatus=response.status_code)
            self.response_status = response.status_code
            self.responses += 1


def _sdk_completion_url(sdk_client):
    """Use the public SDK URL value and its HTTPX2 byte-path semantics.

    OpenAI normalizes the hostname/default port/dot segments and enforces a
    trailing slash. Appending to raw_path mirrors its request URL merge while
    preserving encoded or repeated path separators (URL.join can change them).
    """
    try:
        base_url = sdk_client.base_url
        raw_path = base_url.raw_path
        if type(raw_path) is not bytes or not raw_path.endswith(b"/") or b"?" in raw_path:
            raise ValueError()
        return str(base_url.copy_with(raw_path=raw_path + b"chat/completions"))
    except BaseException:
        _fail("HTTP_GUARD_KWARGS_INVALID")


def guarded_sdk_attempt(completion, role, request_id, request_attempt, *, kwargs,
                        args=(), additional_identity=None, before_dispatch=None, _failure_receipt=None):
    """Trusted retry callers supply identity; SDK/Actor kwargs never supply it."""
    journal = install_model_http_guard()
    if journal is None:
        if before_dispatch is not None:
            if not callable(before_dispatch) or before_dispatch() is not None:
                _fail("HTTP_GUARD_SCOPE_INVALID")
        return completion(*args, **kwargs)
    active = _active_lease.get()
    if active is not None:
        active.fail("HTTP_GUARD_NESTED_ATTEMPT")
    identity = _attempt_identity(role, request_id, request_attempt, additional_identity)
    if (_failure_receipt is not None and (type(_failure_receipt) is not _AttemptFailureReceipt
            or _failure_receipt.identity != identity or _failure_receipt.owner != threading.get_ident()
            or _failure_receipt.consumed or _failure_receipt._proof is not None)):
        _fail("HTTP_GUARD_IDENTITY_INVALID")
    if role == "child_actor" and (identity["parentExecutionId"] != journal.identity["executionId"]
            or identity["parentSessionId"] != journal.identity["sessionId"]):
        _fail("HTTP_GUARD_IDENTITY_INVALID")
    journal.claim(identity)
    lease = _Lease(journal, identity, before_dispatch)
    token = _active_lease.set(lease)
    http_client = sdk_client = None
    result = failure = None
    sdk_status = "failed"
    client_closed = True
    try:
        lease.emit("sdk_attempt_started")
        if (args or not callable(completion) or type(kwargs) is not dict
                or before_dispatch is not None and not callable(before_dispatch)):
            lease.fail("HTTP_GUARD_KWARGS_INVALID")
        if kwargs.get("client") is not None or kwargs.get("http_client") is not None:
            lease.fail("HTTP_GUARD_CLIENT_INJECTION")
        if kwargs.get("custom_llm_provider") != "openai" or kwargs.get("stream", False) or kwargs.get("acompletion", False):
            lease.fail("HTTP_GUARD_MODE_UNSUPPORTED")
        import litellm
        import httpx2
        import openai
        if (any(getattr(litellm, name, False) for name in ("drop_params", "modify_params", "add_function_to_prompt"))
                or getattr(litellm, "num_retries", None) not in (None, 0)):
            lease.fail("HTTP_GUARD_UNSAFE_GLOBAL_CONFIG")
        try:
            private = copy.deepcopy(kwargs)
            endpoint = urlsplit(private["api_base"])
            if (endpoint.scheme not in ("http", "https") or not endpoint.hostname
                    or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
                    or private.get("num_retries") != 0 or private.get("max_retries") != 0):
                raise ValueError()
        except BaseException:
            lease.fail("HTTP_GUARD_KWARGS_INVALID")
        http_client = httpx2.Client(
            limits=httpx2.Limits(max_connections=1000, max_keepalive_connections=100),
            verify=litellm.ssl_verify, follow_redirects=True,
            event_hooks={"request": [lease.request_hook], "response": [lease.response_hook]})
        sdk_client = openai.OpenAI(api_key=private.get("api_key"), base_url=private.get("api_base"),
            timeout=private.get("timeout"), max_retries=0, http_client=http_client)
        lease.expected_url = _sdk_completion_url(sdk_client)
        private["client"] = sdk_client
        result = completion(**private)
        sdk_status = "succeeded"
    except BaseException as error:
        failure = error
        if not isinstance(error, Exception):
            sdk_status = "cancelled"
    finally:
        lease.closed = True
        try:
            if sdk_client is not None:
                sdk_client.close()
            elif http_client is not None:
                http_client.close()
        except BaseException:
            client_closed = False
            lease.failure_code = "HTTP_GUARD_CLIENT_CLOSE_FAILED"
            try:
                if http_client is not None:
                    http_client.close()
            except BaseException:
                pass
        try:
            observed_closed = http_client is None or http_client.is_closed is True
        except BaseException:
            observed_closed = False
        if not observed_closed:
            client_closed = False
            lease.failure_code = "HTTP_GUARD_CLIENT_CLOSE_FAILED"
        if sdk_status == "succeeded" and (lease.admitted != 1 or lease.responses != 1):
            lease.failure_code = lease.failure_code or "HTTP_GUARD_NO_DISPATCH"
        code = lease.failure_code or ("SDK_CALL_CANCELLED" if sdk_status == "cancelled"
            else "SDK_CALL_FAILED" if sdk_status == "failed" else None)
        transport_status = "failed" if lease.failure_code else sdk_status
        try:
            closed_hash = lease.emit("sdk_attempt_closed", sdkCallStatus=sdk_status, transportStatus=transport_status,
                admittedDispatches=lease.admitted, deniedDispatches=lease.denied, responseCount=lease.responses,
                clientClosed=client_closed, leaseClosed=True, failureCode=code)
        finally:
            _active_lease.reset(token)
        if (_failure_receipt is not None and sdk_status == "failed" and code == "SDK_CALL_FAILED"
                and client_closed and observed_closed):
            _failure_receipt._seal(lease, failure, closed_hash)
    if lease.failure_code:
        _fail(lease.failure_code)
    if lease.before_dispatch_failure is not None:
        raise lease.before_dispatch_failure from None
    if failure is not None:
        raise failure from None
    return result
