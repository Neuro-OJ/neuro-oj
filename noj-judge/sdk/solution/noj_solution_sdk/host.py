"""
noj_solution_sdk host 进程。

启动入口（设计为 `python3 -m noj_solution_sdk.host --entry <file>`）：

    host 启动后从 stdin 读 NDJSON 帧，分发到注册的函数；
    处理结果通过 stdout 写回 NDJSON 帧。

帧协议（详见 design.md §2）：
    judge → host:  type=call            {id, fn, args[]}
                    type=result/error   {id, ...}   （capability 调用的响应）
                    type=shutdown       {}
    host → judge:  type=ready           {}     (启动后立即发)
                    type=result         {id, value}
                    type=error          {id, code, message, trace?}
                    type=capability     {id, name, args[]}   （call_capability 发出）

线程模型：
    - reader 线程：持续读 stdin；call 帧投递到队列；result/error 帧按 id 匹配
      pending 的 capability 调用（capability.py）；shutdown/EOF 触发关闭。
    - worker 线程：单线程顺序执行 call 帧（用户函数可在此内调用
      `call_capability` 阻塞等待响应，由 reader 线程分发响应，不会死锁）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import queue
import selectors
import signal
import sys
import threading
import time
import traceback as _traceback_mod

# line buffering —— 关键！
# docker exec 的 stdin/stdout 是管道，Python 默认 block buffering。
# 必须显式打开 line buffering，否则 NDJSON 帧卡在缓冲区里。
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except (AttributeError, ValueError):
    # reconfigure 在某些环境下不可用，回退到 flush
    pass

_HOST_STDERR = sys.stderr

from noj_sdk_common.chunking import (
    ChunkReassembler,
    encode_chunked_frames,
    get_max_payload_bytes,
)
from noj_sdk_common.serialization import (
    RejectedTypeError,
    estimate_min_frame_size,
)

from .registry import _REGISTRY, get_registry, NotRegisteredError
from .sanitize import sanitize_trace
from .serialization import decode_value, encode_value
from .capability import (
    _deliver_response,
    _rpc,
    _set_protocol_out,
    _set_sync_transport,
    _shutdown_pending,
    _write_frame,
)

LOG_MAX_BYTES_PER_FRAME = 64 * 1024  # 64 KiB 单条 log 上限
LOG_TOTAL_MAX_BYTES = 1 * 1024 * 1024  # 1 MiB 累计 log 上限

_CURRENT_CALL_ID: str | None = None
_STDOUT_CAPTURE: "_ProtocolLogStream | None" = None
_PROTO_FD: int | None = None
_ISOLATION_MODE: str = "shared"
_DEFAULT_CALL_TIMEOUT_MS: int = 0

_ACTIVE_CHILD_LOCK = threading.Lock()
_ACTIVE_CALL_ID: str | None = None
_ACTIVE_CHILD_PID: int | None = None
_CANCEL_EVENT = threading.Event()


def _take_utf8_prefix(text: str, max_bytes: int) -> tuple[str, str]:
    """在合法 UTF-8 字符边界截取不超过 max_bytes 的前缀。"""
    if max_bytes <= 0 or not text:
        return "", text
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, ""
    prefix = encoded[:max_bytes].decode("utf-8", errors="ignore")
    return prefix, text[len(prefix) :]


class _ProtocolLogStream:
    """拦截用户 sys.stdout，按行封装为受配额约束的 NDJSON log 帧。"""

    encoding = "utf-8"
    errors = "replace"

    def __init__(
        self,
        write_frame_fn,
        get_call_id_fn,
        max_frame_bytes: int = LOG_MAX_BYTES_PER_FRAME,
        max_total_bytes: int = LOG_TOTAL_MAX_BYTES,
    ) -> None:
        self._write_frame = write_frame_fn
        self._get_call_id = get_call_id_fn
        self._max_frame_bytes = max_frame_bytes
        self._max_total_bytes = max_total_bytes
        self._lock = threading.Lock()
        self._buf = ""
        self._total_bytes = 0
        self._exhausted = False

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def _emit_locked(self, chunk: str, truncated: bool = False) -> None:
        if not chunk and not truncated:
            return
        frame: dict[str, object] = {
            "type": "log",
            "stream": "stdout",
            "data": chunk,
        }
        cid = self._get_call_id()
        if cid is not None:
            frame["call_id"] = cid
        if truncated:
            frame["truncated"] = True
        self._write_frame(frame)

    def _flush_available_locked(self, flush_tail: bool) -> None:
        while self._buf:
            rem_total = self._max_total_bytes - self._total_bytes
            if rem_total <= 0:
                self._buf = ""
                self._exhausted = True
                self._emit_locked("", truncated=True)
                break

            nl_idx = self._buf.find("\n")
            if nl_idx >= 0:
                candidate = self._buf[: nl_idx + 1]
                cand_bytes = len(candidate.encode("utf-8"))
                limit = min(self._max_frame_bytes, rem_total)
                if cand_bytes <= limit:
                    self._buf = self._buf[nl_idx + 1 :]
                    self._total_bytes += cand_bytes
                    self._emit_locked(candidate, truncated=False)
                    continue

                prefix, _ = _take_utf8_prefix(candidate, limit)
                prefix_bytes = len(prefix.encode("utf-8"))
                if rem_total <= self._max_frame_bytes:
                    self._total_bytes += prefix_bytes
                    self._buf = ""
                    self._exhausted = True
                    self._emit_locked(prefix, truncated=True)
                    break
                if not prefix:
                    self._buf = ""
                    self._exhausted = True
                    self._emit_locked("", truncated=True)
                    break
                self._buf = self._buf[len(prefix) :]
                self._total_bytes += prefix_bytes
                self._emit_locked(prefix, truncated=False)
                continue

            buf_bytes = len(self._buf.encode("utf-8"))
            if (
                not flush_tail
                and buf_bytes < self._max_frame_bytes
                and buf_bytes <= rem_total
            ):
                break

            limit = min(self._max_frame_bytes, rem_total)
            prefix, rest = _take_utf8_prefix(self._buf, limit)
            prefix_bytes = len(prefix.encode("utf-8"))
            if rest != "" and rem_total <= self._max_frame_bytes:
                self._total_bytes += prefix_bytes
                self._buf = ""
                self._exhausted = True
                self._emit_locked(prefix, truncated=True)
                break
            if not prefix:
                self._buf = ""
                self._exhausted = True
                self._emit_locked("", truncated=True)
                break
            self._buf = rest
            self._total_bytes += prefix_bytes
            self._emit_locked(prefix, truncated=False)
            if not flush_tail and len(self._buf.encode("utf-8")) < self._max_frame_bytes:
                break

    def write(self, s: str) -> int:
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        if not s:
            return 0
        with self._lock:
            if self._exhausted:
                return len(s)
            self._buf += s
            self._flush_available_locked(flush_tail=False)
            return len(s)

    def flush(self) -> None:
        with self._lock:
            self._flush_available_locked(flush_tail=True)

    def forward_external_frame(self, frame: dict) -> None:
        """在父进程中按剩余全局日志配额转发子进程传回的 log 帧。"""
        data = frame.get("data", "")
        if not isinstance(data, str):
            data = str(data)
        with self._lock:
            if self._exhausted:
                return
            rem_total = self._max_total_bytes - self._total_bytes
            if rem_total <= 0:
                self._exhausted = True
                return
            encoded = data.encode("utf-8")
            if len(encoded) <= rem_total:
                out_frame = dict(frame)
                self._total_bytes += len(encoded)
                if self._total_bytes >= self._max_total_bytes and frame.get("truncated"):
                    self._exhausted = True
                self._write_frame(out_frame)
                return
            prefix, _ = _take_utf8_prefix(data, rem_total)
            prefix_bytes = len(prefix.encode("utf-8"))
            self._total_bytes += prefix_bytes
            self._exhausted = True
            out_frame = dict(frame)
            out_frame["data"] = prefix
            out_frame["truncated"] = True
            self._write_frame(out_frame)


def _flush_stdout() -> None:
    if _STDOUT_CAPTURE is not None:
        _STDOUT_CAPTURE.flush()


def _install_protocol_io() -> None:
    """物理隔离 fd 1 与 sys.stdout，防止用户 print/os.write(1) 污染协议帧。"""
    global _STDOUT_CAPTURE, _PROTO_FD
    proto_fd = os.dup(1)
    _PROTO_FD = proto_fd
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(devnull_fd, 1)
    finally:
        os.close(devnull_fd)
    proto_out = os.fdopen(proto_fd, "w", buffering=1, encoding="utf-8", errors="replace")
    _set_protocol_out(proto_out)
    _STDOUT_CAPTURE = _ProtocolLogStream(
        _write_frame,
        lambda: _CURRENT_CALL_ID,
    )
    sys.stdout = _STDOUT_CAPTURE  # type: ignore[assignment]
    sys.__stdout__ = _STDOUT_CAPTURE  # type: ignore[assignment]

# ── 线程模型 ───────────────────────────────────────────

# call 帧队列（worker 顺序执行）
_CALL_QUEUE: "queue.Queue[object]" = queue.Queue()
# worker 退出哨兵
_POISON = object()

# 用户 entry 是否加载成功（main 在启动 worker 之前写入，worker 只读）。
# 区分两类 NotFound：entry 正常加载但没有该函数（选手缺函数，确定性 0 分）与
# entry 加载失败（语法错误/导入失败，注册表为空）——evaluator SDK 据
# `reason` 字段决定是否代为判 0 分。
_ENTRY_LOADED = False


def _validate_call_args(args: list) -> None:
    """校验 call 帧的参数类型（防御性，evaluator 端已校验）。"""
    # 本镜像只接收 evaluator 写入的 call 帧；evaluator 端已严格校验。
    # 这里只做基本 sanity，避免主机进程被恶意帧攻击。
    if not isinstance(args, list):
        raise ValueError("call.args 必须是 list")


def _execute_call(call_id: str, fn_name: str, args: list) -> None:
    """执行一次 call 并写回响应帧。"""
    registry = get_registry()
    fn = registry.get(fn_name)
    if fn is None:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "NotFound",
                "message": f"function {fn_name!r} not registered",
                "reason": "not_registered" if _ENTRY_LOADED else "entry_load_failed",
            }
        )
        return

    global _CURRENT_CALL_ID
    _CURRENT_CALL_ID = call_id
    try:
        decoded_args = [decode_value(a) for a in args]
        result = fn(*decoded_args)
    except Exception as e:
        _flush_stdout()
        _CURRENT_CALL_ID = None
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "Exception",
                "message": str(e),
                "trace": sanitize_trace(e),
            }
        )
        return
    finally:
        _flush_stdout()
        _CURRENT_CALL_ID = None

    max_payload = get_max_payload_bytes()
    if estimate_min_frame_size(result, limit=max_payload) > max_payload:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "Rejected",
                "message": f"return value 过大（超出分片载荷上限 {max_payload} 字节）",
            }
        )
        return

    try:
        encoded = encode_value(result)
    except Exception as e:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "Rejected",
                "message": f"return value 序列化失败: {e}",
            }
        )
        return

    _write_payload_frame({"type": "result", "id": call_id, "value": encoded})


def _write_payload_frame(frame: dict) -> None:
    """写出可能超过 1 MiB 的响应帧：<= 1 MiB 单帧写出，1~16 MiB 自动拆分为 chunk 帧。"""
    try:
        parts = encode_chunked_frames(frame)
    except RejectedTypeError as e:
        _write_frame(
            {
                "type": "error",
                "id": frame.get("id", ""),
                "code": "Rejected",
                "message": str(e),
            }
        )
        return
    for part in parts:
        _write_frame(part)


def _kill_pid_group(pid: int) -> None:
    """强杀子进程所属进程组（含可能派生的子进程）。"""
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def _kill_active_child(target_call_id: str | None = None) -> None:
    """在 cancel 或 host 关闭时强杀当前活跃的 fork 子进程。"""
    with _ACTIVE_CHILD_LOCK:
        pid = _ACTIVE_CHILD_PID
        cid = _ACTIVE_CALL_ID
        if pid is None:
            return
        if target_call_id is not None and cid != target_call_id:
            return
        _CANCEL_EVENT.set()
    _kill_pid_group(pid)


def _write_all_fd(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        try:
            written = os.write(fd, view)
            view = view[written:]
        except InterruptedError:
            continue


def _forward_child_log(frame: dict) -> None:
    if _STDOUT_CAPTURE is not None:
        _STDOUT_CAPTURE.forward_external_frame(frame)
    else:
        _write_frame(frame)


def _format_wait_status(status: int) -> str:
    if os.WIFSIGNALED(status):
        return f"signal {os.WTERMSIG(status)}"
    if os.WIFEXITED(status):
        return f"exit code {os.WEXITSTATUS(status)}"
    return f"status {status}"


def _run_forked_child(
    c2p_r: int,
    c2p_w: int,
    p2c_r: int,
    p2c_w: int,
    call_id: str,
    fn,
    args: list,
) -> None:
    """fork_per_call 子进程入口：执行单次函数调用后直接 os._exit(0)。"""
    try:
        try:
            os.setpgrp()
        except OSError:
            pass
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        for fd_to_close in (c2p_r, p2c_w):
            try:
                os.close(fd_to_close)
            except OSError:
                pass
        if _PROTO_FD is not None:
            try:
                os.close(_PROTO_FD)
            except OSError:
                pass

        c2p_out = os.fdopen(
            c2p_w, "w", buffering=1, encoding="utf-8", errors="replace"
        )
        p2c_in = os.fdopen(p2c_r, "r", encoding="utf-8", errors="replace")
        child_lock = threading.Lock()

        def _child_write(frame: dict) -> None:
            line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
            with child_lock:
                c2p_out.write(line + "\n")
                c2p_out.flush()

        def _child_recv() -> dict:
            line = p2c_in.readline()
            if not line:
                raise EOFError("parent pipe closed")
            return json.loads(line)

        child_log_stream = _ProtocolLogStream(_child_write, lambda: call_id)
        sys.stdout = child_log_stream  # type: ignore[assignment]
        sys.__stdout__ = child_log_stream  # type: ignore[assignment]
        _set_sync_transport(_child_write, _child_recv)

        try:
            decoded_args = [decode_value(a) for a in args]
            result = fn(*decoded_args)
        except Exception as e:
            child_log_stream.flush()
            _child_write(
                {
                    "type": "error",
                    "id": call_id,
                    "code": "Exception",
                    "message": str(e),
                    "trace": sanitize_trace(e),
                }
            )
            os._exit(0)

        child_log_stream.flush()
        max_payload = get_max_payload_bytes()
        if estimate_min_frame_size(result, limit=max_payload) > max_payload:
            _child_write(
                {
                    "type": "error",
                    "id": call_id,
                    "code": "Rejected",
                    "message": f"return value 过大（超出分片载荷上限 {max_payload} 字节）",
                }
            )
            os._exit(0)
        try:
            encoded = encode_value(result)
        except Exception as e:
            _child_write(
                {
                    "type": "error",
                    "id": call_id,
                    "code": "Rejected",
                    "message": f"return value 序列化失败: {e}",
                }
            )
            os._exit(0)

        _child_write({"type": "result", "id": call_id, "value": encoded})
        c2p_out.flush()
    except BaseException as e:
        try:
            _HOST_STDERR.write(f"[host-child] 异常退出: {e}\n")
            _HOST_STDERR.flush()
        except Exception:
            pass
        os._exit(1)
    os._exit(0)


def _execute_call_forked(
    call_id: str,
    fn_name: str,
    args: list,
    timeout_ms: object = None,
) -> None:
    """在 fork 出的 COW 子进程中执行单次调用，隔离全局状态并支持超时强杀。"""
    global _ACTIVE_CALL_ID, _ACTIVE_CHILD_PID

    registry = get_registry()
    fn = registry.get(fn_name)
    if fn is None:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "NotFound",
                "message": f"function {fn_name!r} not registered",
                "reason": "not_registered" if _ENTRY_LOADED else "entry_load_failed",
            }
        )
        return

    _flush_stdout()
    _HOST_STDERR.flush()
    c2p_r, c2p_w = os.pipe()
    p2c_r, p2c_w = os.pipe()

    try:
        pid = os.fork()
    except Exception:
        for fd in (c2p_r, c2p_w, p2c_r, p2c_w):
            try:
                os.close(fd)
            except OSError:
                pass
        raise

    if pid == 0:
        _run_forked_child(c2p_r, c2p_w, p2c_r, p2c_w, call_id, fn, args)
        return

    os.close(c2p_w)
    os.close(p2c_r)

    with _ACTIVE_CHILD_LOCK:
        _CANCEL_EVENT.clear()
        _ACTIVE_CALL_ID = call_id
        _ACTIVE_CHILD_PID = pid

    eff_ms = (
        timeout_ms
        if isinstance(timeout_ms, int)
        and not isinstance(timeout_ms, bool)
        and timeout_ms > 0
        else _DEFAULT_CALL_TIMEOUT_MS
    )
    deadline = (time.monotonic() + eff_ms / 1000.0) if eff_ms > 0 else None

    os.set_blocking(c2p_r, False)
    sel = selectors.DefaultSelector()
    sel.register(c2p_r, selectors.EVENT_READ)

    raw_buf = b""
    final_frame: dict | None = None
    timed_out_locally = False
    shutdown_aborted = False
    wait_status = 0

    try:
        done = False
        while not done:
            if _CANCEL_EVENT.is_set():
                break
            wait_sec = 0.05
            if deadline is not None:
                rem = deadline - time.monotonic()
                if rem <= 0:
                    timed_out_locally = True
                    break
                wait_sec = min(wait_sec, rem)

            events = sel.select(timeout=wait_sec)
            if not events:
                continue

            while True:
                try:
                    chunk = os.read(c2p_r, 65536)
                except BlockingIOError:
                    break
                except InterruptedError:
                    continue
                if not chunk:
                    done = True
                    break
                raw_buf += chunk

                while True:
                    nl_pos = raw_buf.find(b"\n")
                    if nl_pos < 0:
                        break
                    line_bytes = raw_buf[:nl_pos]
                    raw_buf = raw_buf[nl_pos + 1 :]
                    text = line_bytes.decode("utf-8", errors="replace").strip()
                    if not text:
                        continue
                    try:
                        cframe = json.loads(text)
                    except json.JSONDecodeError:
                        continue

                    ctype = cframe.get("type")
                    if ctype == "log":
                        _forward_child_log(cframe)
                    elif ctype == "capability":
                        cap_id = cframe.get("id")
                        if not isinstance(cap_id, str) or not cap_id:
                            continue
                        cap_q = _rpc.register_pending(cap_id)
                        _write_frame(cframe)
                        cap_resp = None
                        while True:
                            if _CANCEL_EVENT.is_set():
                                break
                            cap_wait = 0.05
                            if deadline is not None:
                                rem = deadline - time.monotonic()
                                if rem <= 0:
                                    timed_out_locally = True
                                    break
                                cap_wait = min(cap_wait, rem)
                            try:
                                cap_resp = cap_q.get(timeout=cap_wait)
                                break
                            except queue.Empty:
                                continue

                        _rpc.pop_pending(cap_id)
                        if cap_resp is None:
                            done = True
                            break
                        if cap_resp.get("type") == "_shutdown":
                            shutdown_aborted = True
                            done = True
                            break
                        payload = (
                            json.dumps(
                                cap_resp, ensure_ascii=False, separators=(",", ":")
                            ).encode("utf-8")
                            + b"\n"
                        )
                        try:
                            _write_all_fd(p2c_w, payload)
                        except OSError:
                            done = True
                            break
                    elif ctype in ("result", "error"):
                        final_frame = cframe
                        done = True
                        break
    finally:
        try:
            sel.close()
        except Exception:
            pass
        if final_frame is None:
            _kill_pid_group(pid)
        _, wait_status = os.waitpid(pid, 0)
        with _ACTIVE_CHILD_LOCK:
            _ACTIVE_CHILD_PID = None
            _ACTIVE_CALL_ID = None
            was_cancelled = _CANCEL_EVENT.is_set()
            _CANCEL_EVENT.clear()
        for fd in (c2p_r, p2c_w):
            try:
                os.close(fd)
            except OSError:
                pass

    if final_frame is not None:
        _write_payload_frame(final_frame)
    elif was_cancelled or shutdown_aborted:
        return
    elif timed_out_locally:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "CallTimeout",
                "message": "call timeout",
            }
        )
    else:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "Exception",
                "message": f"solution process exited abnormally ({_format_wait_status(wait_status)})",
                "trace": "",
            }
        )


def _handle_call_frame(frame: dict) -> None:
    """worker 处理一个 call 帧。"""
    call_id = frame.get("id", "")
    fn_name = frame.get("fn", "")
    args = frame.get("args", [])
    try:
        _validate_call_args(args)
    except ValueError as e:
        _write_frame(
            {
                "type": "error",
                "id": call_id,
                "code": "Rejected",
                "message": str(e),
            }
        )
        return
    if _ISOLATION_MODE == "fork_per_call":
        _execute_call_forked(call_id, fn_name, args, frame.get("timeout_ms"))
    else:
        _execute_call(call_id, fn_name, args)


def _shutdown_all() -> None:
    """触发关闭：强杀活跃子进程、唤醒 pending capability 调用，通知 worker 退出。"""
    _kill_active_child()
    _shutdown_pending()
    try:
        _CALL_QUEUE.put_nowait(_POISON)
    except Exception:
        pass


def _reader_loop() -> None:
    """reader 线程：从 stdin 读帧，分发到队列 / pending（支持透明分片重组）。"""
    reassembler = ChunkReassembler()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as e:
            _HOST_STDERR.write(f"[host] 非 JSON 帧: {e}: {line!r}\n")
            _HOST_STDERR.flush()
            continue

        try:
            frame_type = frame.get("type")
            if frame_type == "chunk":
                reassembled = reassembler.feed(frame)
                if reassembled is None:
                    continue
                frame = reassembled
                frame_type = frame.get("type")
            if frame_type == "call":
                _CALL_QUEUE.put(frame)
            elif frame_type in ("result", "error"):
                # capability 调用的响应：按 id 分发到 pending
                _deliver_response(frame)
            elif frame_type == "cancel":
                cancel_id = frame.get("id")
                if isinstance(cancel_id, str) and cancel_id:
                    _kill_active_child(cancel_id)
            elif frame_type == "shutdown":
                _shutdown_all()
                return
            else:
                # 未知类型忽略（不退出）
                _HOST_STDERR.write(f"[host] unknown frame type: {frame_type!r}\n")
                _HOST_STDERR.flush()
        except Exception as e:
            # 防御性：避免 host 因单帧异常退出
            _HOST_STDERR.write(f"[host] frame 处理异常: {e}\n{_traceback_mod.format_exc()}\n")
            _HOST_STDERR.flush()

    # stdin EOF（judge 关闭通道）：触发关闭
    _shutdown_all()


def _worker_loop() -> None:
    """worker 线程：顺序执行 call 帧，直到收到哨兵。"""
    while True:
        frame = _CALL_QUEUE.get()
        if frame is _POISON:
            return
        try:
            _handle_call_frame(frame)
        except Exception as e:
            # 防御性：单帧异常不终止 worker
            _HOST_STDERR.write(f"[host] call 处理异常: {e}\n{_traceback_mod.format_exc()}\n")
            _HOST_STDERR.flush()


def _install_signal_handlers() -> None:
    """SIGTERM/SIGINT 优雅退出。

    先 `_shutdown_all()` 唤醒阻塞中的 pending capability 调用并给 worker 放哨兵，
    再退出——否则 `sys.exit(0)` 后解释器会等待非 daemon 的 worker 线程，
    worker 阻塞在 `_CALL_QUEUE.get()` 收不到哨兵，进程挂起不退出。
    """

    def _handler(signum, frame):
        _HOST_STDERR.write(f"[host] 收到信号 {signum}，退出\n")
        _HOST_STDERR.flush()
        _shutdown_all()
        sys.exit(0)

    try:
        signal.signal(signal.SIGTERM, _handler)
        signal.signal(signal.SIGINT, _handler)
    except (ValueError, OSError):
        # 非主线程或不支持信号的运行时
        pass


def _load_entry(entry_path: str) -> None:
    """importlib 加载用户提交文件，自动注册顶层函数。"""
    if not os.path.exists(entry_path):
        _HOST_STDERR.write(f"[host] entry 文件不存在: {entry_path}\n")
        _HOST_STDERR.flush()
        sys.exit(1)

    spec = importlib.util.spec_from_file_location("user_solution", entry_path)
    if spec is None or spec.loader is None:
        _HOST_STDERR.write(f"[host] entry 文件无法加载: {entry_path}\n")
        _HOST_STDERR.flush()
        sys.exit(1)

    module = importlib.util.module_from_spec(spec)
    sys.modules["user_solution"] = module
    try:
        spec.loader.exec_module(module)
    finally:
        _flush_stdout()

    # 自动注册模块中所有顶层函数，用户无需显式 @register；
    # 已显式 @register 的函数跳过（避免 FunctionAlreadyRegisteredError）
    import inspect
    for name, obj in inspect.getmembers(module, inspect.isfunction):
        if obj.__module__ == module.__name__:
            if _REGISTRY.get(name) is not None:
                continue
            _REGISTRY.register(name, obj)
            _HOST_STDERR.write(f"[host] 已自动注册函数: {name}\n")
    _HOST_STDERR.flush()


def main() -> None:
    global _ISOLATION_MODE, _DEFAULT_CALL_TIMEOUT_MS
    parser = argparse.ArgumentParser(description="noj_solution_sdk host")
    parser.add_argument(
        "--entry",
        required=True,
        help="Solution 入口文件绝对路径（如 /workspace/solution.py）",
    )
    parser.add_argument(
        "--isolation-mode",
        choices=["shared", "fork_per_call"],
        default="shared",
        help="调用执行隔离模式（shared 常驻共享 / fork_per_call 按调用 fork 隔离）",
    )
    parser.add_argument(
        "--default-call-timeout-ms",
        type=int,
        default=0,
        help="默认单次调用超时（毫秒，0 表示不设本地超时由 judge 控制）",
    )
    args = parser.parse_args()
    _ISOLATION_MODE = args.isolation_mode
    _DEFAULT_CALL_TIMEOUT_MS = max(0, args.default_call_timeout_ms)

    _install_signal_handlers()
    _install_protocol_io()

    # 1. 先发送 ready 帧（在加载 entry 之前还是之后？详见设计）
    #    决定：先 ready 再 load_entry，避免 entry 内耗时 import 让 judge 等不到 ready
    _write_frame({"type": "ready"})

    # 2. 启动 reader 线程（先于 entry 加载：模块顶层代码即可调用
    #    call_capability，响应帧由 reader 分发；call 帧在队列中积压，
    #    worker 启动后顺序处理，不会丢失）
    reader = threading.Thread(
        target=_reader_loop, name="noj-solution-reader", daemon=True
    )
    reader.start()

    # 3. 加载用户 entry
    global _ENTRY_LOADED
    try:
        _load_entry(args.entry)
        _ENTRY_LOADED = True
    except SystemExit:
        raise
    except Exception as e:
        _write_frame(
            {
                "type": "error",
                "id": "",
                "code": "SystemError",
                "message": f"failed to load entry {args.entry}: {e}",
                "trace": sanitize_trace(e),
            }
        )
        # 仍然启动线程等 shutdown；entry 加载失败不应静默退出

    # 4. 启动 worker 线程
    #    reader 为 daemon：主线程 join worker，worker 退出后进程结束（reader 随进程退出）
    worker = threading.Thread(target=_worker_loop, name="noj-solution-worker")
    worker.start()

    # 5. 主线程等待 worker 结束（worker 在 shutdown/EOF 后收到哨兵退出）
    worker.join()
    _flush_stdout()


if __name__ == "__main__":
    main()
