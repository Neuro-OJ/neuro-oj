"""
noj_solution_sdk host 进程。

启动入口（设计为 `python3 -m noj_solution_sdk.host --entry <file>`）：

    host 启动后从 stdin 读 NDJSON 帧，分发到注册的函数；
    处理结果通过 stdout 写回 NDJSON 帧。

帧协议（详见 design.md §2）：
    judge → host:  type=call    {id, fn, args[]}
                  type=shutdown {}
    host → judge:  type=ready   {}     (启动后立即发)
                  type=result  {id, value}
                  type=error   {id, code, message, trace?}
                  type=log     {stream, data}
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import sys
import threading
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

from .registry import _REGISTRY, get_registry, NotRegisteredError
from .sanitize import sanitize_trace
from .serialization import decode_value, encode_value

LOG_MAX_BYTES_PER_FRAME = 64 * 1024  # 64 KiB 单条 log 上限
LOG_TOTAL_MAX_BYTES = 1 * 1024 * 1024  # 1 MiB 累计 log 上限


def _write_frame(frame: dict) -> None:
    """写 NDJSON 帧到 stdout（一行 + 换行）。"""
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


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
            }
        )
        return

    try:
        decoded_args = [decode_value(a) for a in args]
        result = fn(*decoded_args)
    except Exception as e:
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

    _write_frame({"type": "result", "id": call_id, "value": encoded})


def _handle_frame(frame: dict) -> bool:
    """处理单帧。返回 False 表示收到 shutdown 应退出。"""
    frame_type = frame.get("type")

    if frame_type == "call":
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
            return True
        _execute_call(call_id, fn_name, args)
        return True

    if frame_type == "shutdown":
        return False

    # 未知类型忽略（不退出）
    sys.stderr.write(f"[host] unknown frame type: {frame_type!r}\n")
    sys.stderr.flush()
    return True


def _reader_loop() -> None:
    """主循环：从 stdin 读帧，处理直到 shutdown 或 EOF。"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write(f"[host] 非 JSON 帧: {e}: {line!r}\n")
            sys.stderr.flush()
            continue

        try:
            cont = _handle_frame(frame)
        except Exception as e:
            # 防御性：避免 host 因单帧异常退出
            sys.stderr.write(f"[host] frame 处理异常: {e}\n{_traceback_mod.format_exc()}\n")
            sys.stderr.flush()
            cont = True

        if not cont:
            return


def _install_signal_handlers() -> None:
    """SIGTERM/SIGINT 优雅退出。"""

    def _handler(signum, frame):
        sys.stderr.write(f"[host] 收到信号 {signum}，退出\n")
        sys.stderr.flush()
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
        sys.stderr.write(f"[host] entry 文件不存在: {entry_path}\n")
        sys.stderr.flush()
        sys.exit(1)

    spec = importlib.util.spec_from_file_location("user_solution", entry_path)
    if spec is None or spec.loader is None:
        sys.stderr.write(f"[host] entry 文件无法加载: {entry_path}\n")
        sys.stderr.flush()
        sys.exit(1)

    module = importlib.util.module_from_spec(spec)
    sys.modules["user_solution"] = module
    spec.loader.exec_module(module)

    # 自动注册模块中所有顶层函数，用户无需显式 @register
    import inspect
    for name, obj in inspect.getmembers(module, inspect.isfunction):
        if obj.__module__ == module.__name__:
            _REGISTRY.register(name, obj)
            sys.stderr.write(f"[host] 已自动注册函数: {name}\n")
    sys.stderr.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="noj_solution_sdk host")
    parser.add_argument(
        "--entry",
        required=True,
        help="Solution 入口文件绝对路径（如 /workspace/solution.py）",
    )
    args = parser.parse_args()

    _install_signal_handlers()

    # 1. 先发送 ready 帧（在加载 entry 之前还是之后？详见设计）
    #    决定：先 ready 再 load_entry，避免 entry 内耗时 import 让 judge 等不到 ready
    _write_frame({"type": "ready"})

    # 2. 加载用户 entry
    try:
        _load_entry(args.entry)
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
        # 仍然进入 reader loop 等 shutdown；entry 加载失败不应静默退出

    # 3. 主循环
    _reader_loop()


if __name__ == "__main__":
    main()