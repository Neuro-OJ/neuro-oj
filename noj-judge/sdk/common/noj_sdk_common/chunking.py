"""
noj_sdk_common 透明分片传输层（Evaluator / Solution 共享）。

单条 NDJSON 帧仍严格控制在 MAX_FRAME_BYTES（1 MiB）以内，避免超长单行拖垮
noj-judge 的 LineParser（4 MiB 缓冲）；对于 1 MiB ~ 16 MiB 的大载荷（如图像、
张量/嵌入向量、批量评测样本），自动拆分为多条 `type: "chunk"` 帧，并在接收端
透明重组回原始协议帧。
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

from .serialization import MAX_FRAME_BYTES, RejectedTypeError

DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
HARD_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
# 512 KiB 原始 UTF-8 JSON 切片 → base64 约 683 KiB，保证单条 NDJSON 行严格 < 1 MiB
CHUNK_SLICE_BYTES = 512 * 1024
# 分片数量与元数据防放大上限（防止恶意发送大量空分片/超长 stream_id 耗尽内存）
MIN_EXPECTED_CHUNK_BYTES = 64 * 1024
MIN_MAX_CHUNKS_PER_STREAM = 64
MAX_STREAM_ID_LEN = 128
CHUNK_METADATA_OVERHEAD_BYTES = 256


def get_max_payload_bytes() -> int:
    """读取允许的最大逻辑载荷字节数（默认 16 MiB，钳制在 [1 MiB, 32 MiB]）。"""
    raw = os.environ.get("NOJ_RPC_MAX_PAYLOAD_BYTES", "").strip()
    if not raw:
        return DEFAULT_MAX_PAYLOAD_BYTES
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_MAX_PAYLOAD_BYTES
    return max(MAX_FRAME_BYTES, min(parsed, HARD_MAX_PAYLOAD_BYTES))


def encode_chunked_frames(
    frame: dict[str, Any],
    *,
    max_payload_bytes: int | None = None,
    chunk_bytes: int = CHUNK_SLICE_BYTES,
) -> list[dict[str, Any]]:
    """将协议帧编码为单帧（<= 1 MiB）或有序 `chunk` 帧列表（<= max_payload_bytes）。"""
    limit = get_max_payload_bytes() if max_payload_bytes is None else max_payload_bytes
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    raw = line.encode("utf-8")
    if len(raw) <= MAX_FRAME_BYTES:
        return [frame]
    if len(raw) > limit:
        raise RejectedTypeError(
            f"payload size {len(raw)} > {limit}（超出分片载荷上限）"
        )
    if chunk_bytes <= 0:
        raise ValueError("chunk_bytes 必须为正整数")

    stream_id = uuid.uuid4().hex
    kind = str(frame.get("type", ""))
    frame_id = str(frame.get("id", ""))
    total = (len(raw) + chunk_bytes - 1) // chunk_bytes
    chunks: list[dict[str, Any]] = []
    for seq in range(total):
        start = seq * chunk_bytes
        part = raw[start : start + chunk_bytes]
        chunk_frame: dict[str, Any] = {
            "type": "chunk",
            "stream_id": stream_id,
            "id": frame_id,
            "kind": kind,
            "seq": seq,
            "total": total,
            "data": base64.b64encode(part).decode("ascii"),
        }
        if seq == 0:
            if kind == "call" and "timeout_ms" in frame:
                chunk_frame["timeout_ms"] = frame["timeout_ms"]
            elif kind == "capability" and "name" in frame:
                chunk_frame["name"] = frame["name"]
        chunks.append(chunk_frame)
    return chunks


class _StreamBuffer:
    __slots__ = ("total", "parts", "received_bytes", "metadata_bytes")

    def __init__(self, total: int, stream_id_bytes: int) -> None:
        self.total = total
        self.parts: dict[int, bytes] = {}
        self.received_bytes = 0
        self.metadata_bytes = stream_id_bytes


class ChunkReassembler:
    """有界内存的 `chunk` 帧重组器。"""

    def __init__(
        self,
        *,
        max_payload_bytes: int | None = None,
        max_inflight_streams: int = 16,
        max_chunks_per_stream: int | None = None,
    ) -> None:
        self._max_payload_bytes = (
            get_max_payload_bytes()
            if max_payload_bytes is None
            else max_payload_bytes
        )
        self._max_inflight_streams = max(1, max_inflight_streams)
        default_max_chunks = max(
            MIN_MAX_CHUNKS_PER_STREAM,
            (self._max_payload_bytes + MIN_EXPECTED_CHUNK_BYTES - 1)
            // MIN_EXPECTED_CHUNK_BYTES,
        )
        self._max_chunks_per_stream = (
            default_max_chunks
            if max_chunks_per_stream is None
            else max(1, max_chunks_per_stream)
        )
        self._max_stream_metadata_bytes = (
            MAX_STREAM_ID_LEN
            + self._max_chunks_per_stream * CHUNK_METADATA_OVERHEAD_BYTES
        )
        self._streams: dict[str, _StreamBuffer] = {}

    def feed(self, frame: dict[str, Any]) -> dict[str, Any] | None:
        """喂入一条 `chunk` 帧；所有分片集齐后返回还原后的原始帧 dict，否则返回 None。"""
        stream_id = frame.get("stream_id")
        seq = frame.get("seq")
        total = frame.get("total")
        data = frame.get("data")
        if (
            not isinstance(stream_id, str)
            or not stream_id
            or len(stream_id) > MAX_STREAM_ID_LEN
            or type(seq) is not int
            or type(total) is not int
            or total <= 0
            or total > self._max_chunks_per_stream
            or seq < 0
            or seq >= total
            or not isinstance(data, str)
        ):
            return None

        try:
            decoded = base64.b64decode(data.encode("ascii"), validate=True)
        except Exception:
            self._streams.pop(stream_id, None)
            return None

        # 多分片流不允许空分片，防止恶意用大量空分片占用表项内存
        if total > 1 and len(decoded) == 0:
            self._streams.pop(stream_id, None)
            return None

        buf = self._streams.get(stream_id)
        if buf is None:
            if len(self._streams) >= self._max_inflight_streams:
                oldest = next(iter(self._streams))
                self._streams.pop(oldest, None)
            buf = _StreamBuffer(total, len(stream_id.encode("utf-8")))
            self._streams[stream_id] = buf
        elif buf.total != total:
            self._streams.pop(stream_id, None)
            return None

        if seq in buf.parts:
            return None

        next_bytes = buf.received_bytes + len(decoded)
        next_metadata = buf.metadata_bytes + CHUNK_METADATA_OVERHEAD_BYTES
        if (
            next_bytes > self._max_payload_bytes
            or next_metadata > self._max_stream_metadata_bytes
            or len(buf.parts) + 1 > self._max_chunks_per_stream
        ):
            self._streams.pop(stream_id, None)
            return None

        buf.parts[seq] = decoded
        buf.received_bytes = next_bytes
        buf.metadata_bytes = next_metadata

        if len(buf.parts) < buf.total:
            return None

        self._streams.pop(stream_id, None)
        merged = b"".join(buf.parts[i] for i in range(buf.total))
        try:
            obj = json.loads(merged.decode("utf-8"))
        except Exception:
            return None
        return obj if isinstance(obj, dict) else None
