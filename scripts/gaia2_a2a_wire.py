"""Canonical values and a private synchronous pipe protocol, not ARE authority.

Only a trusted spawn/pipe owner may provide the streams and handler map.
channel_id and binding_hash are correlation labels: they do not establish an
official App, process identity, delegation permission, or Actor-facing API.
The peer closes logically; its trusted owner remains responsible for streams
and operating-system process supervision.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import uuid
from collections.abc import Callable, Mapping
from typing import Any, BinaryIO

MAX_DEPTH = 64
MAX_NODES = 100_000
MAX_ENCODED_BYTES = 4 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
MAX_PENDING_REQUESTS = 64
MAX_ACTIVE_HANDLERS = 64
MAX_SEEN_REQUESTS = 100_000
SCHEMA_VERSION = "capybara-a2a-private-pipe-v1"
_FORBIDDEN_KEYS = frozenset(("__proto__", "prototype", "constructor"))
_HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
_HEX_32 = re.compile(r"[0-9a-f]{32}\Z")
_NUMBER_HEX = re.compile(r"[0-9a-f]{16}\Z")
_METHOD = re.compile(r"[a-z][a-z0-9_]{0,63}\Z")
_ENVELOPE_KEYS = frozenset(("schemaVersion", "channelId", "bindingHash", "sequence", "kind", "requestId", "method", "payload"))


class A2AWireError(RuntimeError):
    """Fixed local code only: never echo a frame, payload or raw exception."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class A2AHandlerError(A2AWireError):
    """A valid remote application failure; the channel remains usable."""


def _fail(code: str) -> None:
    raise A2AWireError(code) from None


def _string(value: Any) -> str:
    if type(value) is not str:
        _fail("A2A_WIRE_INVALID_VALUE")
    try:
        value.encode("utf-8", errors="strict")
        return value
    except UnicodeEncodeError:
        pass
    # Python normally stores scalar codepoints. A manually constructed paired
    # UTF-16 surrogate string has the same meaning as the JS scalar string;
    # combine valid pairs, reject every isolated surrogate.
    parts = []
    index = 0
    while index < len(value):
        code = ord(value[index])
        if 0xD800 <= code <= 0xDBFF:
            if index + 1 >= len(value) or not 0xDC00 <= ord(value[index + 1]) <= 0xDFFF:
                _fail("A2A_WIRE_INVALID_VALUE")
            parts.append(chr(0x10000 + ((code - 0xD800) << 10) + ord(value[index + 1]) - 0xDC00))
            index += 2
        elif 0xDC00 <= code <= 0xDFFF:
            _fail("A2A_WIRE_INVALID_VALUE")
        else:
            parts.append(value[index])
            index += 1
    return "".join(parts)


def _number(value: Any) -> float:
    if type(value) not in (int, float):
        _fail("A2A_WIRE_INVALID_VALUE")
    if type(value) is int and abs(value) > MAX_SAFE_INTEGER:
        _fail("A2A_WIRE_INVALID_VALUE")
    number = float(value)
    if not math.isfinite(number) or number.is_integer() and abs(number) > MAX_SAFE_INTEGER:
        _fail("A2A_WIRE_INVALID_VALUE")
    return 0.0 if number == 0 else number


class _Budget:
    def __init__(self):
        self.nodes = 0
        self.active: set[int] = set()

    def visit(self, depth: int) -> None:
        self.nodes += 1
        if depth > MAX_DEPTH or self.nodes > MAX_NODES:
            _fail("A2A_WIRE_LIMIT")


def _tag(value: Any, budget: _Budget, depth: int = 0) -> list[Any]:
    budget.visit(depth)
    if value is None:
        return ["null"]
    if type(value) is bool:
        return ["bool", value]
    if type(value) is str:
        text = _string(value)
        if len(text.encode("utf-8")) > MAX_ENCODED_BYTES:
            _fail("A2A_WIRE_OVERSIZE")
        return ["string", text]
    if type(value) in (int, float):
        return ["number", struct.pack(">d", _number(value)).hex()]
    if type(value) not in (list, dict):
        _fail("A2A_WIRE_INVALID_VALUE")
    if len(value) > MAX_NODES - budget.nodes:
        _fail("A2A_WIRE_LIMIT")
    identity = id(value)
    if identity in budget.active:
        _fail("A2A_WIRE_CYCLE")
    budget.active.add(identity)
    try:
        if type(value) is list:
            return ["array", [_tag(child, budget, depth + 1) for child in value]]
        pairs = []
        for key, child in value.items():
            budget.visit(depth)  # Object keys are nodes, without adding depth.
            key = _string(key)
            if key in _FORBIDDEN_KEYS:
                _fail("A2A_WIRE_INVALID_VALUE")
            encoded_key = key.encode("utf-8")
            if len(encoded_key) > MAX_ENCODED_BYTES:
                _fail("A2A_WIRE_OVERSIZE")
            pairs.append((encoded_key, key, child))
        pairs.sort(key=lambda item: item[0])
        if any(pairs[index - 1][0] == pairs[index][0] for index in range(1, len(pairs))):
            _fail("A2A_WIRE_INVALID_VALUE")
        return ["object", [[key, _tag(child, budget, depth + 1)] for _, key, child in pairs]]
    finally:
        budget.active.remove(identity)


def encode_value(value: Any) -> bytes:
    """Encode one JSON-like value, with bounded tree depth/nodes/UTF-8 bytes."""
    try:
        tagged = _tag(value, _Budget())
        data = json.dumps(tagged, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except A2AWireError:
        raise
    except Exception:
        _fail("A2A_WIRE_INVALID_VALUE")
    if len(data) > MAX_ENCODED_BYTES:
        _fail("A2A_WIRE_OVERSIZE")
    return data


def _untag(node: Any, budget: _Budget, depth: int = 0) -> Any:
    budget.visit(depth)
    if type(node) is not list or not node or type(node[0]) is not str:
        _fail("A2A_WIRE_INVALID_ENCODING")
    kind = node[0]
    if kind == "null":
        if len(node) != 1:
            _fail("A2A_WIRE_INVALID_ENCODING")
        return None
    if len(node) != 2:
        _fail("A2A_WIRE_INVALID_ENCODING")
    value = node[1]
    if kind == "bool":
        if type(value) is not bool:
            _fail("A2A_WIRE_INVALID_ENCODING")
        return value
    if kind == "string":
        return _string(value)
    if kind == "number":
        if type(value) is not str or not _NUMBER_HEX.fullmatch(value):
            _fail("A2A_WIRE_INVALID_ENCODING")
        number = struct.unpack(">d", bytes.fromhex(value))[0]
        if value == "8000000000000000" or not math.isfinite(number):
            _fail("A2A_WIRE_INVALID_ENCODING")
        if number.is_integer() and abs(number) > MAX_SAFE_INTEGER:
            _fail("A2A_WIRE_INVALID_ENCODING")
        return int(number) if number.is_integer() else number
    if kind == "array":
        if type(value) is not list:
            _fail("A2A_WIRE_INVALID_ENCODING")
        return [_untag(child, budget, depth + 1) for child in value]
    if kind == "object":
        if type(value) is not list:
            _fail("A2A_WIRE_INVALID_ENCODING")
        result = {}
        previous = None
        for pair in value:
            if type(pair) is not list or len(pair) != 2:
                _fail("A2A_WIRE_INVALID_ENCODING")
            budget.visit(depth)
            key = _string(pair[0])
            encoded_key = key.encode("utf-8")
            if key in _FORBIDDEN_KEYS or previous is not None and encoded_key <= previous:
                _fail("A2A_WIRE_INVALID_ENCODING")
            result[key] = _untag(pair[1], budget, depth + 1)
            previous = encoded_key
        return result
    _fail("A2A_WIRE_INVALID_ENCODING")


def decode_value(data: bytes) -> Any:
    """Decode only canonical bytes; JSON objects/whitespace/escapes are not wire."""
    if type(data) is not bytes or not data:
        _fail("A2A_WIRE_INVALID_ENCODING")
    if len(data) > MAX_ENCODED_BYTES:
        _fail("A2A_WIRE_OVERSIZE")
    try:
        text = data.decode("utf-8", errors="strict")
        node = json.loads(text, parse_constant=lambda _: _fail("A2A_WIRE_INVALID_ENCODING"))
        value = _untag(node, _Budget())
        if encode_value(value) != data:
            _fail("A2A_WIRE_NONCANONICAL")
        return value
    except A2AWireError:
        raise
    except Exception:
        _fail("A2A_WIRE_INVALID_ENCODING")


def value_hash(value: Any) -> str:
    return hashlib.sha256(encode_value(value)).hexdigest()


canonical_hash = value_hash


def _read_exact(reader: BinaryIO, length: int, *, header: bool = False) -> bytes:
    chunks = []
    received = 0
    while received < length:
        try:
            chunk = reader.read(length - received)
        except Exception:
            _fail("A2A_PIPE_IO_FAILED")
        if type(chunk) is not bytes or len(chunk) > length - received:
            _fail("A2A_PIPE_IO_FAILED")
        if not chunk:
            _fail("A2A_WIRE_EOF" if header and received == 0 else "A2A_WIRE_TRUNCATED")
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks)


def read_frame(reader: BinaryIO) -> Any:
    length = struct.unpack(">I", _read_exact(reader, 4, header=True))[0]
    if length == 0:
        _fail("A2A_WIRE_INVALID_ENCODING")
    if length > MAX_ENCODED_BYTES:
        _fail("A2A_WIRE_OVERSIZE")
    return decode_value(_read_exact(reader, length))


def _write_bytes(writer: BinaryIO, data: bytes) -> None:
    written = 0
    try:
        while written < len(data):
            count = writer.write(data[written:])
            if type(count) is not int or count <= 0 or count > len(data) - written:
                _fail("A2A_PIPE_IO_FAILED")
            written += count
        writer.flush()
    except A2AWireError:
        raise
    except Exception:
        _fail("A2A_PIPE_IO_FAILED")


def write_frame(writer: BinaryIO, value: Any) -> None:
    data = encode_value(value)
    _write_bytes(writer, struct.pack(">I", len(data)) + data)


class PrivatePipePeer:
    """One execution thread per peer, with synchronous reentrant callbacks.

    call() serves trusted inbound requests while awaiting its own response, so
    a child may call a parent Native handler which in turn calls the child.
    Application failure is a fixed response, not a reason to retry the handler.
    on_closed(code) fires once. It receives no remote text or application value.
    """

    def __init__(self, reader: BinaryIO, writer: BinaryIO, channel_id: str,
                 binding_hash: str, handlers: Mapping[str, Callable[[Any], Any]],
                 on_closed: Callable[[str], None] | None = None):
        if type(channel_id) is not str or not _HEX_64.fullmatch(channel_id) or type(binding_hash) is not str or not _HEX_64.fullmatch(binding_hash):
            _fail("A2A_PROTOCOL_INVALID_ENVELOPE")
        if not isinstance(handlers, Mapping) or any(type(name) is not str or not _METHOD.fullmatch(name) or not callable(handler) for name, handler in handlers.items()):
            _fail("A2A_PROTOCOL_INVALID_METHOD")
        if not callable(getattr(reader, "read", None)) or not callable(getattr(writer, "write", None)) or not callable(getattr(writer, "flush", None)) or on_closed is not None and not callable(on_closed):
            _fail("A2A_PIPE_IO_FAILED")
        self.reader = reader
        self.writer = writer
        self.channel_id = channel_id
        self.binding_hash = binding_hash
        self.handlers = dict(handlers)
        self.on_closed = on_closed
        self.closed = False
        self.close_code: str | None = None
        self._out_sequence = 0
        self._in_sequence = 0
        self._seen_inbound: set[str] = set()
        self._seen_outbound: set[str] = set()
        self._seen_responses: set[str] = set()
        self._pending: dict[str, str] = {}
        self._responses: dict[str, dict[str, Any]] = {}
        self._active_handlers = 0

    def close(self, code: str = "A2A_PIPE_CLOSED") -> None:
        if self.closed:
            return
        self.closed = True
        self.close_code = code
        self._pending.clear()
        self._responses.clear()
        if self.on_closed is not None:
            try:
                self.on_closed(code)
            except Exception:
                pass

    def _ensure_open(self) -> None:
        if self.closed:
            _fail("A2A_PIPE_CLOSED")

    def _envelope(self, kind: str, request_id: str, method: str, payload: Any) -> dict[str, Any]:
        if self._out_sequence >= MAX_SAFE_INTEGER:
            _fail("A2A_PROTOCOL_SEQUENCE")
        return {"schemaVersion": SCHEMA_VERSION, "channelId": self.channel_id,
                "bindingHash": self.binding_hash, "sequence": self._out_sequence + 1,
                "kind": kind, "requestId": request_id, "method": method, "payload": payload}

    def _send(self, kind: str, request_id: str, method: str, payload: Any) -> None:
        self._ensure_open()
        envelope = self._envelope(kind, request_id, method, payload)
        data = encode_value(envelope)
        _write_bytes(self.writer, struct.pack(">I", len(data)) + data)
        self._out_sequence += 1

    def _receive(self) -> dict[str, Any]:
        envelope = read_frame(self.reader)
        if type(envelope) is not dict or frozenset(envelope) != _ENVELOPE_KEYS:
            _fail("A2A_PROTOCOL_INVALID_ENVELOPE")
        if envelope["schemaVersion"] != SCHEMA_VERSION or envelope["channelId"] != self.channel_id or envelope["bindingHash"] != self.binding_hash:
            _fail("A2A_PROTOCOL_INVALID_ENVELOPE")
        sequence = envelope["sequence"]
        if type(sequence) is not int or sequence <= 0 or sequence > MAX_SAFE_INTEGER or sequence != self._in_sequence + 1:
            _fail("A2A_PROTOCOL_SEQUENCE")
        if envelope["kind"] not in ("request", "response") or type(envelope["requestId"]) is not str or not _HEX_32.fullmatch(envelope["requestId"]):
            _fail("A2A_PROTOCOL_INVALID_ENVELOPE")
        if type(envelope["method"]) is not str or not _METHOD.fullmatch(envelope["method"]):
            _fail("A2A_PROTOCOL_INVALID_METHOD")
        self._in_sequence = sequence
        return envelope

    def _serve_request(self, envelope: dict[str, Any]) -> None:
        request_id, method = envelope["requestId"], envelope["method"]
        if request_id in self._seen_inbound:
            _fail("A2A_PROTOCOL_REQUEST_REPLAY")
        if method not in self.handlers:
            _fail("A2A_PROTOCOL_UNKNOWN_METHOD")
        if len(self._seen_inbound) + len(self._seen_outbound) >= MAX_SEEN_REQUESTS or self._active_handlers >= MAX_ACTIVE_HANDLERS:
            _fail("A2A_PROTOCOL_RESOURCE_LIMIT")
        self._seen_inbound.add(request_id)
        self._active_handlers += 1
        try:
            value = self.handlers[method](envelope["payload"])
            self._ensure_open()
            payload = {"ok": True, "value": value}
            # Complete validation before writing any bytes. An invalid/too
            # large handler return is an application failure, never a replay.
            encode_value(self._envelope("response", request_id, method, payload))
        except A2AWireError:
            if self.closed:
                raise
            payload = {"ok": False, "code": "A2A_HANDLER_FAILED"}
        except Exception:
            payload = {"ok": False, "code": "A2A_HANDLER_FAILED"}
        finally:
            self._active_handlers -= 1
        self._send("response", request_id, method, payload)

    def _route_once(self) -> None:
        envelope = self._receive()
        if envelope["kind"] == "request":
            self._serve_request(envelope)
            return
        request_id, method, payload = envelope["requestId"], envelope["method"], envelope["payload"]
        if request_id in self._seen_responses:
            _fail("A2A_PROTOCOL_RESPONSE_REPLAY")
        if request_id not in self._pending:
            _fail("A2A_PROTOCOL_UNSOLICITED_RESPONSE")
        if method != self._pending[request_id]:
            _fail("A2A_PROTOCOL_INVALID_RESPONSE")
        if type(payload) is not dict or type(payload.get("ok")) is not bool:
            _fail("A2A_PROTOCOL_INVALID_RESPONSE")
        keys = frozenset(payload)
        if payload["ok"] is True:
            if keys != frozenset(("ok", "value")):
                _fail("A2A_PROTOCOL_INVALID_RESPONSE")
        elif keys != frozenset(("ok", "code")) or payload["code"] != "A2A_HANDLER_FAILED":
            _fail("A2A_PROTOCOL_INVALID_RESPONSE")
        self._seen_responses.add(request_id)
        del self._pending[request_id]
        self._responses[request_id] = payload

    def serve_once(self) -> None:
        self._ensure_open()
        try:
            self._route_once()
        except A2AWireError as error:
            self.close(error.code)
            raise
        except Exception:
            self.close("A2A_PIPE_IO_FAILED")
            _fail("A2A_PIPE_IO_FAILED")

    def call(self, method: str, payload: Any, request_id: str | None = None) -> Any:
        self._ensure_open()
        request_id = uuid.uuid4().hex if request_id is None else request_id
        try:
            if type(method) is not str or not _METHOD.fullmatch(method):
                _fail("A2A_PROTOCOL_INVALID_METHOD")
            if type(request_id) is not str or not _HEX_32.fullmatch(request_id):
                _fail("A2A_PROTOCOL_INVALID_ENVELOPE")
            if request_id in self._seen_outbound:
                _fail("A2A_PROTOCOL_REQUEST_REPLAY")
            if len(self._seen_inbound) + len(self._seen_outbound) >= MAX_SEEN_REQUESTS or len(self._pending) + len(self._responses) >= MAX_PENDING_REQUESTS:
                _fail("A2A_PROTOCOL_RESOURCE_LIMIT")
            self._seen_outbound.add(request_id)
            self._pending[request_id] = method
            self._send("request", request_id, method, payload)
            while request_id not in self._responses:
                self._route_once()
            response = self._responses.pop(request_id)
        except A2AWireError as error:
            self.close(error.code)
            raise
        except Exception:
            self.close("A2A_PIPE_IO_FAILED")
            _fail("A2A_PIPE_IO_FAILED")
        if response["ok"] is False:
            raise A2AHandlerError("A2A_HANDLER_FAILED") from None
        return response["value"]
