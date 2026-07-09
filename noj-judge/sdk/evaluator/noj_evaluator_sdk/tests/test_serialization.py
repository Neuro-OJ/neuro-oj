"""
noj_evaluator_sdk 单测 —— serialization 模块。
"""

import base64
import io
import json
import sys
import unittest

sys.path.insert(0, sys.path[0] + "/..")

from noj_evaluator_sdk.errors import RejectedError
from noj_evaluator_sdk.serialization import (
    MAX_FRAME_BYTES,
    check_frame_size,
    decode_value,
    encode_value,
    validate_type,
)


class TestValidateType(unittest.TestCase):
    """验证类型白名单。"""

    def test_allow_none_bool_int_float_str(self):
        for v in [None, True, False, 0, 1, -1, 3.14, "hello", ""]:
            validate_type(v)  # 不抛

    def test_allow_bytes(self):
        validate_type(b"hello")
        validate_type(bytearray(b"x"))
        validate_type(memoryview(b"x"))

    def test_allow_list_dict_nested(self):
        validate_type([])
        validate_type({})
        validate_type([1, 2, [3, {"k": "v"}]])
        validate_type({"a": [1, 2, 3], "b": {"nested": True}})

    def test_reject_set(self):
        with self.assertRaises(RejectedError):
            validate_type({1, 2, 3})

    def test_reject_tuple(self):
        with self.assertRaises(RejectedError):
            validate_type((1, 2))

    def test_reject_custom_class(self):
        class Foo:
            pass

        with self.assertRaises(RejectedError):
            validate_type(Foo())

    def test_reject_function(self):
        with self.assertRaises(RejectedError):
            validate_type(lambda x: x)

    def test_reject_nested_invalid(self):
        with self.assertRaises(RejectedError):
            validate_type([1, 2, {1, 2}], "arg[2]")

    def test_reject_dict_with_non_str_key(self):
        with self.assertRaises(RejectedError):
            validate_type({1: "x"})


class TestEncodeDecodeRoundTrip(unittest.TestCase):
    """bytes 必须通过 base64 标签 round-trip。"""

    def test_bytes_encode(self):
        encoded = encode_value(b"hello")
        self.assertEqual(encoded, {"__bytes__": base64.b64encode(b"hello").decode()})

    def test_bytes_decode(self):
        decoded = decode_value(
            {"__bytes__": base64.b64encode(b"hello").decode()}
        )
        self.assertEqual(decoded, b"hello")

    def test_round_trip_primitives(self):
        for v in [None, True, False, 0, 42, 3.14, "hello", "中文", [1, "a", None]]:
            self.assertEqual(decode_value(encode_value(v)), v)

    def test_round_trip_nested_bytes(self):
        original = {"data": b"\x00\x01\x02", "name": "x", "list": [b"a", b"b"]}
        decoded = decode_value(encode_value(original))
        self.assertEqual(decoded["data"], b"\x00\x01\x02")
        self.assertEqual(decoded["list"][0], b"a")
        self.assertEqual(decoded["list"][1], b"b")
        self.assertEqual(decoded["name"], "x")


class TestFrameSizeLimit(unittest.TestCase):
    """单帧 1 MiB 软上限。"""

    def test_small_frame_ok(self):
        check_frame_size(json.dumps({"x": "y"}))

    def test_oversize_frame_rejected(self):
        big = "x" * (MAX_FRAME_BYTES + 1)
        with self.assertRaises(RejectedError):
            check_frame_size(big)


if __name__ == "__main__":
    unittest.main()