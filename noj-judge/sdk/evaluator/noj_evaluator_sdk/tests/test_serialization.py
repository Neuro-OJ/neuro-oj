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
    estimate_frame_size,
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


class TestEstimateFrameSize(unittest.TestCase):
    """encode 前大小预算：估算为上界（≥ 实际序列化大小），超限即短路。"""

    def _serialized_len(self, value) -> int:
        """实际序列化帧长度（bytes 经 encode_value + json.dumps 后）。"""
        return len(json.dumps(encode_value(value), ensure_ascii=False).encode("utf-8"))

    def test_estimate_is_upper_bound_for_primitives(self):
        for v in [None, True, False, 0, 42, -123456, 3.14, "hello", "中文", ""]:
            self.assertGreaterEqual(estimate_frame_size(v), self._serialized_len(v))

    def test_estimate_is_upper_bound_for_bytes(self):
        # bytes base64 膨胀 ~1.33×，估算必须覆盖编码后大小
        for size in [0, 1, 100, 1024, 1024 * 1024]:
            v = b"x" * size
            self.assertGreaterEqual(estimate_frame_size(v), self._serialized_len(v))

    def test_estimate_is_upper_bound_for_nested(self):
        v = {
            "name": "test",
            "data": b"\x00\x01" * 512,
            "list": [1, 2, 3, "a" * 128],
            "nested": {"k": [None, True, 3.14]},
        }
        self.assertGreaterEqual(estimate_frame_size(v), self._serialized_len(v))

    def test_huge_dict_short_circuits_over_limit(self):
        # 1 GB 级对象：估算应超限并短路（不完整遍历所有元素）
        huge = {f"k{i}": "x" * 1024 for i in range(1024 * 1024)}  # ~1 GB str
        self.assertGreater(estimate_frame_size(huge), MAX_FRAME_BYTES)

    def test_oversize_bytes_over_limit(self):
        big = b"x" * (MAX_FRAME_BYTES + 1)
        self.assertGreater(estimate_frame_size(big), MAX_FRAME_BYTES)

    def test_small_value_under_limit(self):
        self.assertLessEqual(estimate_frame_size({"a": 1, "b": "hello"}), MAX_FRAME_BYTES)


if __name__ == "__main__":
    unittest.main()