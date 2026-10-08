"""Pure wire and trusted pipe controls: no sockets, model or ARE execution."""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
from pathlib import Path
import struct
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from gaia2_a2a_wire import (A2AHandlerError, A2AWireError, MAX_DEPTH,
                          MAX_ACTIVE_HANDLERS, MAX_ENCODED_BYTES, MAX_NODES,
                          MAX_PENDING_REQUESTS, MAX_SAFE_INTEGER, MAX_SEEN_REQUESTS,
                          PrivatePipePeer, SCHEMA_VERSION, decode_value,
                          encode_value, read_frame, value_hash, write_frame)

CHANNEL, BINDING = "c" * 64, "b" * 64
REQUEST, OTHER, THIRD = "1" * 32, "2" * 32, "3" * 32


def envelope(kind="request", sequence=1, request_id=REQUEST, method="native", payload=None, **changes):
    value = {"schemaVersion": SCHEMA_VERSION, "channelId": CHANNEL,
             "bindingHash": BINDING, "sequence": sequence, "kind": kind,
             "requestId": request_id, "method": method, "payload": payload}
    value.update(changes)
    return value


def frames(*values):
    stream = io.BytesIO()
    for value in values:
        write_frame(stream, value)
    return stream.getvalue()


def raw_frame(data):
    return struct.pack(">I", len(data)) + data


class WireTests(unittest.TestCase):
    def test_scalar_vectors_and_hash(self):
        vectors = [(None, b'["null"]'), (False, b'["bool",false]'),
                   (True, b'["bool",true]'), ("", b'["string",""]'),
                   (1, b'["number","3ff0000000000000"]'),
                   (-2.5, b'["number","c004000000000000"]')]
        for value, expected in vectors:
            with self.subTest(value=value):
                self.assertEqual(encode_value(value), expected)
                self.assertEqual(decode_value(expected), value)
                self.assertEqual(value_hash(value), hashlib.sha256(expected).hexdigest())

    def test_negative_zero_normalized_only_on_encode(self):
        self.assertEqual(encode_value(-0.0), b'["number","0000000000000000"]')
        self.assertEqual(encode_value(-0.0), encode_value(0))
        with self.assertRaises(A2AWireError):
            decode_value(b'["number","8000000000000000"]')

    def test_utf8_object_order_astral_after_bmp(self):
        value = {"\U00010000": "astral", "\ue000": "bmp", "a": "ascii"}
        data = encode_value(value)
        tagged = json.loads(data)
        self.assertEqual([key for key, _ in tagged[1]], ["a", "\ue000", "\U00010000"])
        self.assertEqual(decode_value(data), value)
        self.assertEqual(data, encode_value(dict(reversed(list(value.items())))))

    def test_unicode_scalar_and_manual_valid_surrogate_pair(self):
        self.assertEqual(encode_value("\ud83d\ude00"), encode_value("\U0001f600"))
        self.assertEqual(decode_value(encode_value("中文\U0001f600\n\"\\")), "中文\U0001f600\n\"\\")
        with self.assertRaises(A2AWireError):
            encode_value({"\ud83d\ude00": 1, "\U0001f600": 2})

    def test_isolated_surrogates_rejected(self):
        for value in ["\ud800", "\udc00", "\ud800a", {"\ud800": 1}]:
            with self.subTest(type=type(value).__name__), self.assertRaises(A2AWireError):
                encode_value(value)
        for data in [b'["string","\\ud800"]', b'["object",[["\\udc00",["null"]]]]']:
            with self.assertRaises(A2AWireError):
                decode_value(data)

    def test_nested_roundtrip_and_alias_without_cycle(self):
        shared = [None, True, 0.125]
        value = {"list": [shared, shared], "nested": {"text": "x"}}
        self.assertEqual(decode_value(encode_value(value)), value)

    def test_cycles_and_non_json_values_rejected(self):
        array = []; array.append(array)
        obj = {}; obj["self"] = obj
        for value in [array, obj, (1, 2), {1: "bad"}, b"bad", set(), object()]:
            with self.subTest(type=type(value).__name__), self.assertRaises(A2AWireError):
                encode_value(value)

    def test_forbidden_keys_at_any_depth(self):
        for key in ["__proto__", "prototype", "constructor"]:
            with self.assertRaises(A2AWireError):
                encode_value({"ok": [{key: None}]})
            data = json.dumps(["object", [[key, ["null"]]]], separators=(",", ":")).encode()
            with self.assertRaises(A2AWireError):
                decode_value(data)

    def test_finite_safe_numbers_only(self):
        for value in [MAX_SAFE_INTEGER, -MAX_SAFE_INTEGER, 5e-324, 0.125]:
            self.assertEqual(decode_value(encode_value(value)), value)
        for value in [MAX_SAFE_INTEGER + 1, -MAX_SAFE_INTEGER - 1, 10**400,
                      float(2**53), float("nan"), float("inf"), -float("inf")]:
            with self.subTest(type=type(value).__name__), self.assertRaises(A2AWireError):
                encode_value(value)
        for hex_value in ["7ff0000000000000", "fff0000000000000", "7ff8000000000000",
                          "4340000000000000", "c340000000000000", "3FF0000000000000"]:
            with self.assertRaises(A2AWireError):
                decode_value(f'["number","{hex_value}"]'.encode())

    def test_exact_tag_lengths_types_and_order(self):
        invalid = [["null", None], ["bool", 1], ["string", 1], ["number", 1],
                   ["number", "0000"], ["array", {}], ["object", {}], ["other"], [],
                   ["object", [["b", ["null"]], ["a", ["null"]]]],
                   ["object", [["a", ["null"]], ["a", ["null"]]]],
                   ["object", [["a", ["null"], 1]]], {"tag": "null"}]
        for node in invalid:
            with self.subTest(node=node), self.assertRaises(A2AWireError):
                decode_value(json.dumps(node, separators=(",", ":")).encode())

    def test_strict_utf8_and_canonical_json_bytes(self):
        for data in [b"", b"\xff", b"\xef\xbb\xbf[\"null\"]", b'[ "null" ]',
                     b'["null"]\n', b'["string","\\u4e2d"]', b'["string","a\\/b"]',
                     b'["string","\\ud83d\\ude00"]', b'["bool",NaN]', b'{"a":1,"a":2}']:
            with self.subTest(data=data), self.assertRaises(A2AWireError):
                decode_value(data)

    def test_depth_boundary_and_node_boundary(self):
        value = None
        for _ in range(MAX_DEPTH): value = [value]
        self.assertEqual(decode_value(encode_value(value)), value)
        with self.assertRaises(A2AWireError): encode_value([value])
        tagged = ["null"]
        for _ in range(MAX_DEPTH + 1): tagged = ["array", [tagged]]
        with self.assertRaises(A2AWireError):
            decode_value(json.dumps(tagged, separators=(",", ":")).encode())
        self.assertEqual(len(decode_value(encode_value([None] * (MAX_NODES - 1)))), MAX_NODES - 1)
        with self.assertRaises(A2AWireError): encode_value([None] * MAX_NODES)
        with self.assertRaises(A2AWireError):
            decode_value(json.dumps(["array", [["null"]] * MAX_NODES], separators=(",", ":")).encode())

    def test_encoded_size_exact_boundary(self):
        overhead = len(encode_value(""))
        value = "x" * (MAX_ENCODED_BYTES - overhead)
        data = encode_value(value)
        self.assertEqual(len(data), MAX_ENCODED_BYTES)
        self.assertEqual(decode_value(data), value)
        with self.assertRaises(A2AWireError): encode_value(value + "x")
        with self.assertRaises(A2AWireError): decode_value(b"x" * (MAX_ENCODED_BYTES + 1))

    def test_object_keys_count_as_nodes_without_extra_depth(self):
        value = {str(index): None for index in range((MAX_NODES - 1) // 2)}
        self.assertEqual(decode_value(encode_value(value)), value)
        value["one_more"] = None
        with self.assertRaises(A2AWireError): encode_value(value)
        tagged = ["object", [[key, ["null"]] for key in sorted(value, key=lambda key: key.encode())]]
        with self.assertRaises(A2AWireError):
            decode_value(json.dumps(tagged, separators=(",", ":")).encode())
        deep = None
        for _ in range(MAX_DEPTH): deep = {"key": deep}
        self.assertEqual(decode_value(encode_value(deep)), deep)

    def test_frames_partial_reads_and_writes(self):
        class PartialReader(io.BytesIO):
            def read(self, size=-1): return super().read(min(size, 3))
        class PartialWriter(io.BytesIO):
            def write(self, data): return super().write(data[:2])
        writer = PartialWriter()
        write_frame(writer, {"x": [1, True]})
        self.assertEqual(read_frame(PartialReader(writer.getvalue())), {"x": [1, True]})
        self.assertEqual(struct.unpack(">I", writer.getvalue()[:4])[0], len(writer.getvalue()) - 4)

    def test_empty_truncated_and_oversize_frames(self):
        for data in [b"", b"\x00", b"\x00\x00\x00", struct.pack(">I", 0),
                     struct.pack(">I", 10) + b"abc", struct.pack(">I", MAX_ENCODED_BYTES + 1)]:
            with self.subTest(length=len(data)), self.assertRaises(A2AWireError):
                read_frame(io.BytesIO(data))


class PeerTests(unittest.TestCase):
    def peer(self, data=b"", handlers=None):
        self.closed = []
        self.reader, self.writer = io.BytesIO(data), io.BytesIO()
        self.active = PrivatePipePeer(self.reader, self.writer, CHANNEL, BINDING,
                                      handlers or {}, on_closed=self.closed.append)
        return self.active

    def assert_sticky(self, peer, invoke):
        with self.assertRaises(A2AWireError) as caught: invoke()
        self.assertTrue(peer.closed)
        self.assertEqual(self.closed, [caught.exception.code])
        with self.assertRaises(A2AWireError) as second: peer.serve_once()
        self.assertEqual(second.exception.code, "A2A_PIPE_CLOSED")
        peer.close()
        self.assertEqual(len(self.closed), 1)
        self.assertNotIn("SECRET", str(caught.exception))

    def test_call_response_and_exact_envelope(self):
        peer = self.peer(frames(envelope("response", payload={"ok": True, "value": [7]})))
        self.assertEqual(peer.call("native", {"count": 1}, request_id=REQUEST), [7])
        outgoing = read_frame(io.BytesIO(self.writer.getvalue()))
        self.assertEqual(outgoing, envelope(payload={"count": 1}))
        self.assertFalse(peer.closed)

    def test_inbound_request_served_while_waiting(self):
        seen = []
        peer = self.peer(frames(envelope(request_id=OTHER, payload=3),
                                envelope("response", sequence=2, payload={"ok": True, "value": 9})),
                         {"native": lambda value: seen.append(value) or value + 1})
        self.assertEqual(peer.call("native", None, request_id=REQUEST), 9)
        self.assertEqual(seen, [3])
        stream = io.BytesIO(self.writer.getvalue())
        self.assertEqual(read_frame(stream)["kind"], "request")
        response = read_frame(stream)
        self.assertEqual(response["sequence"], 2)
        self.assertEqual(response["requestId"], OTHER)
        self.assertEqual(response["payload"], {"ok": True, "value": 4})

    def test_true_nested_native_roundtrip_over_private_os_pipes(self):
        ab_r, ab_w = os.pipe(); ba_r, ba_w = os.pipe()
        streams = [os.fdopen(ab_r, "rb", buffering=0), os.fdopen(ab_w, "wb", buffering=0),
                   os.fdopen(ba_r, "rb", buffering=0), os.fdopen(ba_w, "wb", buffering=0)]
        errors = []
        calls = []
        try:
            child = None
            parent = None
            def parent_native(value):
                calls.append("parent_native")
                return parent.call("leaf", value) + 1
            def child_delegate(value):
                calls.append("child_delegate")
                return child.call("native", value) + 1
            parent = PrivatePipePeer(streams[2], streams[1], CHANNEL, BINDING, {"native": parent_native})
            child = PrivatePipePeer(streams[0], streams[3], CHANNEL, BINDING, {"delegate": child_delegate, "leaf": lambda value: value + 1})
            def serve():
                try: child.serve_once()
                except BaseException as error: errors.append(error)
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            self.assertEqual(parent.call("delegate", 4), 7)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(calls, ["child_delegate", "parent_native"])
            self.assertFalse(parent.closed); self.assertFalse(child.closed)
            self.assertEqual(parent._in_sequence, 3); self.assertEqual(child._in_sequence, 3)
        finally:
            for stream in streams: stream.close()

    def test_same_request_id_legal_in_opposite_directions(self):
        peer = self.peer(frames(envelope(request_id=REQUEST, payload=3),
                                envelope("response", sequence=2, request_id=REQUEST, payload={"ok": True, "value": 9})),
                         {"native": lambda value: value + 1})
        self.assertEqual(peer.call("native", None, request_id=REQUEST), 9)
        self.assertEqual(peer._seen_inbound, {REQUEST})
        self.assertEqual(peer._seen_outbound, {REQUEST})
        self.assertFalse(peer.closed)

    def test_handler_close_then_return_never_writes_late_response(self):
        peer = None
        def handler(_): peer.close(); return 7
        peer = self.peer(frames(envelope()), {"native": handler})
        self.assert_sticky(peer, peer.serve_once)
        self.assertEqual(self.writer.getvalue(), b"")

    def test_handler_close_then_throw_never_writes_late_response(self):
        peer = None
        def handler(_): peer.close(); raise RuntimeError("SECRET")
        peer = self.peer(frames(envelope()), {"native": handler})
        self.assert_sticky(peer, peer.serve_once)
        self.assertEqual(self.writer.getvalue(), b"")

    def test_handler_failure_fixed_and_channel_usable(self):
        def fail(_): raise RuntimeError("SECRET raw prompt key endpoint")
        peer = self.peer(frames(envelope(payload=None), envelope(sequence=2, request_id=OTHER, payload=2)), {"native": fail})
        peer.serve_once()
        self.assertFalse(peer.closed)
        response = read_frame(io.BytesIO(self.writer.getvalue()))
        self.assertEqual(response["payload"], {"ok": False, "code": "A2A_HANDLER_FAILED"})
        self.assertNotIn(b"SECRET", self.writer.getvalue())
        peer.handlers["native"] = lambda value: value + 1
        peer.serve_once()
        self.assertFalse(peer.closed)

    def test_invalid_handler_return_is_fixed_application_failure(self):
        peer = self.peer(frames(envelope()), {"native": lambda _: object()})
        peer.serve_once()
        self.assertEqual(read_frame(io.BytesIO(self.writer.getvalue()))["payload"], {"ok": False, "code": "A2A_HANDLER_FAILED"})
        self.assertFalse(peer.closed)

    def test_remote_application_failure_does_not_close_or_retry(self):
        peer = self.peer(frames(envelope("response", payload={"ok": False, "code": "A2A_HANDLER_FAILED"}),
                                envelope("response", sequence=2, request_id=OTHER, payload={"ok": True, "value": 8})))
        with self.assertRaises(A2AHandlerError) as caught:
            peer.call("native", None, request_id=REQUEST)
        self.assertEqual(caught.exception.code, "A2A_HANDLER_FAILED")
        self.assertFalse(peer.closed)
        self.assertEqual(peer.call("native", None, request_id=OTHER), 8)
        stream = io.BytesIO(self.writer.getvalue())
        self.assertEqual(read_frame(stream)["sequence"], 1)
        self.assertEqual(read_frame(stream)["sequence"], 2)
        self.assertEqual(stream.read(), b"")

    def test_request_replay_and_unknown_method_fatal(self):
        calls = []
        peer = self.peer(frames(envelope(), envelope(sequence=2)), {"native": lambda _: calls.append(1)})
        peer.serve_once()
        self.assert_sticky(peer, peer.serve_once)
        self.assertEqual(calls, [1])
        peer = self.peer(frames(envelope(method="unknown")), {"native": lambda _: calls.append(2)})
        self.assert_sticky(peer, peer.serve_once)
        self.assertEqual(calls, [1])

    def test_sequence_gap_repetition_nonpositive_and_bool_fatal(self):
        for sequence in [2, 0, -1, True]:
            with self.subTest(sequence=sequence):
                peer = self.peer(frames(envelope(sequence=sequence)), {"native": lambda _: None})
                self.assert_sticky(peer, peer.serve_once)
        peer = self.peer(frames(envelope(), envelope(sequence=1, request_id=OTHER)), {"native": lambda _: None})
        peer.serve_once()
        self.assert_sticky(peer, peer.serve_once)

    def test_wrong_identity_extra_keys_and_invalid_ids_fatal(self):
        for changes in [{"channelId": "d" * 64}, {"bindingHash": "a" * 64},
                        {"schemaVersion": "other"}, {"extra": "SECRET"},
                        {"requestId": "A" * 32}, {"requestId": "1" * 31},
                        {"method": "BadMethod"}, {"method": "a" * 65}, {"kind": "other"}]:
            with self.subTest(keys=list(changes)):
                peer = self.peer(frames(envelope(**changes)), {"native": lambda _: None})
                self.assert_sticky(peer, peer.serve_once)

    def test_unsolicited_response_and_method_mismatch_fatal(self):
        peer = self.peer(frames(envelope("response", payload={"ok": True, "value": None})))
        self.assert_sticky(peer, peer.serve_once)
        peer = self.peer(frames(envelope("response", request_id=OTHER, payload={"ok": True, "value": None})))
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))
        peer = self.peer(frames(envelope("response", method="wrong", payload={"ok": True, "value": None})))
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))

    def test_response_replay_fatal(self):
        response = envelope("response", payload={"ok": True, "value": None})
        peer = self.peer(frames(response, {**response, "sequence": 2}))
        peer.call("native", None, request_id=REQUEST)
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=OTHER))

    def test_response_payload_exact_fixed_failure_code(self):
        for payload in [{"ok": 1, "value": 7}, {"ok": True},
                        {"ok": True, "value": 7, "extra": "SECRET"},
                        {"ok": False, "code": "SECRET"}, {"ok": False, "code": "A2A_HANDLER_FAILED", "message": "SECRET"}]:
            with self.subTest(keys=list(payload)):
                peer = self.peer(frames(envelope("response", payload=payload)))
                self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))

    def test_outgoing_request_id_reuse_is_fatal(self):
        peer = self.peer(frames(envelope("response", payload={"ok": True, "value": 1})))
        peer.call("native", None, request_id=REQUEST)
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))

    def test_eof_malformed_frame_and_io_error_sticky(self):
        for data in [b"", raw_frame(b'[ "null" ]'), raw_frame(b"\xff"), b"\x00\x00"]:
            with self.subTest(length=len(data)):
                peer = self.peer(data)
                self.assert_sticky(peer, peer.serve_once)
        class BadReader:
            def read(self, _): raise OSError("SECRET")
        peer = self.peer()
        peer.reader = BadReader()
        self.assert_sticky(peer, peer.serve_once)
        class BadWriter(io.BytesIO):
            def write(self, _): raise OSError("SECRET")
        peer = self.peer()
        peer.writer = BadWriter()
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))

    def test_callback_exception_cannot_unclose_channel_or_leak(self):
        peer = self.peer()
        count = []
        def closed(code): count.append(code); raise RuntimeError("SECRET")
        peer.on_closed = closed
        with self.assertRaises(A2AWireError): peer.serve_once()
        peer.close()
        self.assertEqual(count, ["A2A_WIRE_EOF"])
        self.assertTrue(peer.closed)

    def test_pending_and_active_resource_limits_fail_before_dispatch(self):
        peer = self.peer()
        peer._pending = {f"{index:032x}": "native" for index in range(MAX_PENDING_REQUESTS)}
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))
        self.assertEqual(self.writer.getvalue(), b"")
        calls = []
        peer = self.peer(frames(envelope()), {"native": lambda _: calls.append(1)})
        peer._active_handlers = MAX_ACTIVE_HANDLERS
        self.assert_sticky(peer, peer.serve_once)
        self.assertEqual(calls, [])

    def test_seen_request_budget_never_evicted_for_replay(self):
        peer = self.peer()
        peer._seen_outbound = {f"{index:032x}" for index in range(MAX_SEEN_REQUESTS)}
        self.assert_sticky(peer, lambda: peer.call("native", None, request_id=REQUEST))
        self.assertEqual(self.writer.getvalue(), b"")


if __name__ == "__main__":
    unittest.main(verbosity=2)
