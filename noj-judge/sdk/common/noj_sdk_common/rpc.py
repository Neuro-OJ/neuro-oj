"""
noj_sdk_common RPC 客户端基础设施（Evaluator / Solution 共享）。

封装 NDJSON 帧的 pending 注册、线程安全写出、按 id 分发响应与关闭唤醒，
避免两个 SDK 各自维护一套相同的锁与队列逻辑。
"""

from __future__ import annotations

import json
import sys
import threading
from queue import Queue
from typing import Any, TextIO

# 关闭/EOF 时放入 pending 队列的哨兵帧
_SHUTDOWN_FRAME = {"type": "_shutdown"}


class RpcClient:
    """线程安全的 NDJSON RPC 客户端状态。

    两个 SDK 的差异（reader 线程、capability 执行、错误映射）保留在各 SDK，
    这里只提供公共的 pending / 写帧 / 分发 / 关闭原语。
    """

    def __init__(self, out: TextIO | None = None) -> None:
        self._pending: dict[str, Queue] = {}
        self._lock = threading.Lock()
        self._out_lock = threading.Lock()
        self._out = out if out is not None else sys.stdout
        self._closed = False

    def write_frame(self, frame: dict) -> None:
        """写 NDJSON 帧到 stdout（一行 + 换行），线程安全。"""
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        with self._out_lock:
            self._out.write(line + "\n")
            self._out.flush()

    def register_pending(self, call_id: str) -> Queue:
        """注册一个 pending 调用，返回用于接收响应的队列。"""
        q: Queue = Queue(maxsize=1)
        with self._lock:
            self._pending[call_id] = q
        return q

    def pop_pending(self, call_id: str) -> Queue | None:
        """取出并移除 pending 队列（响应到达或超时清理时调用）。"""
        with self._lock:
            return self._pending.pop(call_id, None)

    def deliver_response(self, frame: dict) -> None:
        """按 id 分发 result/error 帧到对应 pending 队列。"""
        frame_id = frame.get("id")
        if frame_id is None:
            return
        q = self.pop_pending(frame_id)
        if q is not None:
            q.put(frame)

    def shutdown_pending(self) -> None:
        """唤醒所有 pending 调用（连接断开/关闭时）。"""
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for q in pending:
            try:
                q.put_nowait(_SHUTDOWN_FRAME)
            except Exception:
                pass

    def clear_pending(self) -> None:
        """清空 pending（仅测试用）。"""
        with self._lock:
            self._pending.clear()

    def close(self) -> None:
        """标记关闭并唤醒所有 pending。"""
        self._closed = True
        self.shutdown_pending()
