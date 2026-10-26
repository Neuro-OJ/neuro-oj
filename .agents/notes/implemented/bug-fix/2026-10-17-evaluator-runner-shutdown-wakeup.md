# Agent Note: evaluator SDK 通道断开时唤醒 pending 调用

Status: implemented

## Problem

`SolutionRunner` 的 stdin reader 线程在 IPC 通道断开时存在三处遗漏，导致
`runner.call()` 永久阻塞在 `q.get()`，而不是按文档抛 `ConnectionError`（issue #680）：

1. **正常 EOF 不唤醒**：`_reader_loop` 用 `for line in sys.stdin` 读帧，EOF 时迭代
   正常结束、并不抛 `EOFError`；而关闭与唤醒只写在
   `except (EOFError, BrokenPipeError)` 分支。host 崩溃/退出、stdin 被关闭后，
   正在等待的调用与随后发起的调用都会永久挂起。
2. **通用异常不唤醒**：`except Exception` 只置 `_closed = True`，未调用
   `shutdown_pending()`，已注册的调用同样永久阻塞。
3. **注册/唤醒竞态**：`call()` 先检查 `_closed` 再 `register_pending()`；若 `close()`
   或 reader 收尾恰好落在两步之间，`shutdown_pending()` 先于注册执行，本次调用
   永远收不到唤醒。

真实评测中 evaluate.py 会一直挂到评测级超时才被 judge 杀掉，把「Solution host
崩溃」误报成「超时」，评测结果与日志都指向错误原因。

## Decision

- `_reader_loop` 改为 `try/finally`：无论正常 EOF、reader 异常还是收到 `shutdown`
  帧，退出时统一执行 `self._closed = True; self._rpc.shutdown_pending()`。
- 在 `RpcClient` 层消除竞态：`shutdown_pending()` 在同一把锁内**原子地**置
  `_closed` 并清空 pending；`register_pending()` 在同一把锁内检查 `_closed`，
  已关闭时返回**预置 `_SHUTDOWN_FRAME` 的队列**，调用方 `q.get()` 立即拿到哨兵帧
  并按既有约定抛 `ConnectionError`。
- `call()` 在注册之后若发现已关闭，跳过向已断开的通道写帧，直接走哨兵帧路径。
- solution 侧 `call_capability` 复用同一 `RpcClient`，一并受益。

## Alternatives considered

- **只在 `call()` 里再检查一次 `_closed`**：可缩小但不能消除窗口——检查与注册仍是
  两次独立操作，reader 收尾仍可能插在中间。锁内原子判定才能彻底消除。
- **给 `q.get()` 加超时**：会把「通道断开」与「host 执行慢」混为一谈，且 judge 侧
  已有调用级超时，SDK 再加一层会双重超时、语义冲突。
- **每次 `register_pending` 前轮询 `_closed`**：忙等浪费 CPU，且不解决原子性。
- **仅在 reader 的 `except Exception` 里补 `shutdown_pending()`**：只补了第 2 处，
  第 1、3 处仍在；`try/finally` 一次性覆盖全部退出路径。

## Consequences

- 仅改 `noj-judge` 的 Python SDK（`noj_sdk_common/rpc.py`、`noj_evaluator_sdk/runner.py`），
  无需镜像 / 协议 / judge 二进制变更。
- 新增单测覆盖 stdin EOF、reader 异常、close 与 call 并发三种场景，以及 `RpcClient`
  关闭后注册即得哨兵帧的确定性断言；SDK Python 单测已随 #679 接入 CI。
- 正常关闭语义不变（`close()` 等价于 `shutdown_pending()`，幂等）；已注册调用收到
  哨兵帧后仍抛既有 `ConnectionError("Solution host 已关闭 / IPC 通道断开")`。
