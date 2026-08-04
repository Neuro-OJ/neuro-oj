# 调用级超时（call_timeout_ms → RPC / Evaluator SDK 调用参数）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `runner.call(..., timeout_ms)` 与 capability 注册默认值控制单次调用的超时（judge 侧 in-flight 追踪 + tokio 参数化超时），缺省回退题目级 `runtime_config.solution.call_timeout_ms`。

**Architecture:** Judge Worker 的 dual 主循环从"双向透明转发"改为"感知帧类型 + in-flight 超时追踪"：Evaluator 的 call 帧 / Solution 的 capability 帧登记 deadline（`InFlightTracker`），响应帧按 id 命中判定，超时向等待方写 `code="Timeout"` 错误帧并丢弃迟到响应。Evaluator SDK 的 `call()` 增加可选 `timeout_ms`，`register_capability()` 增加可选 `timeout_ms` 并经一次性 `cap_reg` 帧上报 judge。

**Tech Stack:** Rust（tokio / serde_json，`noj-judge`）、Python（`noj_evaluator_sdk` / `noj_solution_sdk`）、TypeScript（noj-tests E2E）、Deno。

## Global Constraints

- 设计规格：`docs/superpowers/specs/2026-08-04-call-timeout-per-call-design.md`（已批准）
- 超时计时起点：judge 收到帧的时刻（Evaluator call 帧 / Solution capability 帧）
- `timeout_ms` 规则：正整数生效；缺省 / 0 / 负数 / 非数字 → 回退题目级默认 `runtime_config.solution.call_timeout_ms`
- 超时错误帧：`{"type":"error","id":"<id>","code":"Timeout","message":"..."}`；Evaluator SDK 侧抛 `SolutionTimeoutError`（已存在）
- 迟到响应丢弃：已超时 id 的响应不再转发；warn/debug 限频日志
- `cap_reg` 帧是 judge 与 evaluator 的私有协议，**不转发**给 Solution Host
- 向后兼容：旧 SDK / 旧题目零改动（可选字段 + 默认回退）；不新增协议版本字段
- 保持 evaluator `time_limit_ms` 外层兜底不变
- 提交规范：Conventional Commits，description 中文，GPG 签名；`cargo fmt` / `cargo clippy` 通过
- 新模块必须 `cargo fmt` 后提交；测试文件遵循既有模式（`#[cfg(test)]` / `#[ignore]` + `NOJ_RUN_E2E=1` 守卫）

---

### Task 1: InFlightTracker 纯逻辑模块（tracker.rs）

**Files:**
- Create: `noj-judge/src/dual/tracker.rs`
- Modify: `noj-judge/src/dual/mod.rs`（追加 `mod tracker;` 与 `pub use tracker::...`，供 tests 引用）
- Test: `noj-judge/src/dual/tracker.rs`（`#[cfg(test)] mod tests` 内）

**Interfaces:**
- Produces（后续 Task 3 消费）：
  - `pub enum WaitingSide { Evaluator, Solution }`
  - `pub struct InFlightTracker`
  - `InFlightTracker::new(default_call_timeout_ms: u64) -> Self`
  - `on_call_frame(&mut self, frame: &Value, now: Instant) -> Option<(String, u64)>`（无 id 返回 None）
  - `on_cap_reg_frame(&mut self, frame: &Value)`（`timeout_ms` 缺省/非法 → 删除映射）
  - `on_capability_frame(&mut self, frame: &Value, now: Instant) -> Option<(String, u64)>`
  - `resolve_response(&mut self, id: &str) -> bool`
  - `expire_now(&mut self, now: Instant) -> Vec<(String, WaitingSide)>`
  - `next_deadline(&self) -> Option<Instant>`
  - `is_empty(&self) -> bool`

- [ ] **Step 1: 在 mod.rs 声明子模块（先写最小骨架以编译）**

```rust
// noj-judge/src/dual/mod.rs 顶部（现有 use 之后）
pub mod tracker;
```

（此时 tracker.rs 不存在会编译失败——Step 2 立即创建。）

- [ ] **Step 2: 创建 tracker.rs 并先写测试**

创建 `noj-judge/src/dual/tracker.rs`，先只写测试（`#[cfg(test)] mod tests`），再跑测试确认失败（`cannot find struct InFlightTracker` 编译错误即可）：

```rust
//! 调用级超时追踪（judge 侧 RPC 超时实现，纯逻辑、零容器依赖）。
use std::collections::HashMap;
use std::time::{Duration, Instant};
use serde_json::{json, Value};

/// 调用等待方向：决定超时错误帧写给谁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitingSide {
    Evaluator, // evaluator 等 solution（runner.call）
    Solution,  // solution 等 evaluator（capability 调用）
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call_frame(id: &str, timeout_ms: Option<u64>) -> Value {
        let mut f = json!({"type": "call", "id": id, "fn": "solve", "args": []});
        if let Some(t) = timeout_ms {
            f["timeout_ms"] = json!(t);
        }
        f
    }

    #[test]
    fn test_new_uses_default_timeout() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        let (id, ms) = t.on_call_frame(&call_frame("a", None), now).unwrap();
        assert_eq!(id, "a");
        assert_eq!(ms, 2000);
    }

    #[test]
    fn test_call_frame_explicit_timeout_wins() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        let (_, ms) = t.on_call_frame(&call_frame("b", Some(500)), now).unwrap();
        assert_eq!(ms, 500);
    }

    #[test]
    fn test_call_frame_invalid_timeout_falls_back() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        let f = json!({"type": "call", "id": "c", "fn": "solve", "args": [], "timeout_ms": 0});
        let (_, ms) = t.on_call_frame(&f, now).unwrap();
        assert_eq!(ms, 2000);
        let f2 = json!({"type": "call", "id": "d", "fn": "solve", "args": [], "timeout_ms": -1});
        let (_, ms2) = t.on_call_frame(&f2, now).unwrap();
        assert_eq!(ms2, 2000);
    }

    #[test]
    fn test_call_frame_missing_id_returns_none() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        let f = json!({"type": "call", "fn": "solve", "args": []});
        assert!(t.on_call_frame(&f, now).is_none());
    }

    #[test]
    fn test_capability_uses_registered_timeout() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping", "timeout_ms": 9000}));
        let f = json!({"type": "capability", "id": "cap-1", "name": "ping", "args": []});
        let (_, ms) = t.on_capability_frame(&f, now).unwrap();
        assert_eq!(ms, 9000);
    }

    #[test]
    fn test_capability_falls_back_when_not_registered() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        let f = json!({"type": "capability", "id": "cap-2", "name": "unknown", "args": []});
        let (_, ms) = t.on_capability_frame(&f, now).unwrap();
        assert_eq!(ms, 2000);
    }

    #[test]
    fn test_cap_reg_re_registration_overwrites_and_none_deletes() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping", "timeout_ms": 9000}));
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping", "timeout_ms": 1000}));
        let f = json!({"type": "capability", "id": "cap-3", "name": "ping", "args": []});
        assert_eq!(t.on_capability_frame(&f, now).unwrap().1, 1000);
        // timeout_ms 缺省 → 删除映射，回退默认
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping"}));
        let f2 = json!({"type": "capability", "id": "cap-4", "name": "ping", "args": []});
        assert_eq!(t.on_capability_frame(&f2, now).unwrap().1, 2000);
    }

    #[test]
    fn test_resolve_response_hit_removes_and_returns_true() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_call_frame(&call_frame("r1", None), now).unwrap();
        assert!(t.resolve_response("r1"));
        assert!(!t.resolve_response("r1"), "已移除，二次命中应为 false");
    }

    #[test]
    fn test_resolve_response_unknown_false() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        assert!(!t.resolve_response("ghost"));
    }

    #[test]
    fn test_expire_now_returns_expired_and_removes() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_call_frame(&call_frame("fast", Some(10)), now).unwrap();
        t.on_call_frame(&call_frame("slow", Some(10_000)), now).unwrap();
        // fast 的 deadline 在 11ms 之后
        let expired = t.expire_now(now + Duration::from_millis(11));
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].0, "fast");
        assert_eq!(expired[0].1, WaitingSide::Evaluator);
        assert!(!t.is_empty(), "slow 仍在 in-flight");
        // slow 的 deadline 之后全部过期
        let expired2 = t.expire_now(now + Duration::from_millis(10_001));
        assert_eq!(expired2.len(), 1);
        assert_eq!(expired2[0].0, "slow");
        assert!(t.is_empty());
    }

    #[test]
    fn test_capability_expire_side_is_solution() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping", "timeout_ms": 10}));
        let f = json!({"type": "capability", "id": "cap-x", "name": "ping", "args": []});
        t.on_capability_frame(&f, now).unwrap();
        let expired = t.expire_now(now + Duration::from_millis(11));
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].1, WaitingSide::Solution);
    }

    #[test]
    fn test_next_deadline_min_and_empty() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        assert!(t.next_deadline().is_none());
        t.on_call_frame(&call_frame("x", Some(100)), now).unwrap();
        t.on_call_frame(&call_frame("y", Some(50)), now).unwrap();
        let d = t.next_deadline().unwrap();
        assert_eq!(d, now + Duration::from_millis(50));
    }

    #[test]
    fn test_concurrent_calls_have_independent_deadlines() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000);
        t.on_call_frame(&call_frame("c1", Some(30)), now).unwrap();
        t.on_call_frame(&call_frame("c2", Some(200)), now).unwrap();
        // 30ms 时只有 c1 过期
        let e1 = t.expire_now(now + Duration::from_millis(30));
        assert_eq!(e1.len(), 1);
        assert_eq!(e1[0].0, "c1");
        // c2 仍可正常命中
        assert!(t.resolve_response("c2"));
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd noj-judge && cargo test --lib dual::tracker 2>&1 | tail -5`
Expected: 编译错误（`cannot find struct InFlightTracker`）——测试先行。

- [ ] **Step 4: 实现 InFlightTracker**

在 `tracker.rs` 的测试上方补实现（替换 Step 2 的骨架）：

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};
use serde_json::Value;

/// 调用等待方向：决定超时错误帧写给谁。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitingSide {
    /// evaluator 等 solution（runner.call）
    Evaluator,
    /// solution 等 evaluator（capability 调用）
    Solution,
}

/// 单次 in-flight 调用的超时信息。
#[derive(Debug, Clone)]
struct InFlightEntry {
    deadline: Instant,
    waiting: WaitingSide,
}

/// 调用级超时追踪器。
#[derive(Debug)]
pub struct InFlightTracker {
    inflight: HashMap<String, InFlightEntry>,
    cap_timeouts: HashMap<String, u64>,
    default_call_timeout_ms: u64,
}

impl InFlightTracker {
    /// 以题目级默认超时创建追踪器。
    pub fn new(default_call_timeout_ms: u64) -> Self {
        Self {
            inflight: HashMap::new(),
            cap_timeouts: HashMap::new(),
            default_call_timeout_ms,
        }
    }

    /// 从帧中读取 timeout_ms（正整数才生效，否则回退默认）。
    fn resolve_timeout(&self, frame: &Value) -> u64 {
        frame
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .filter(|&t| t > 0)
            .unwrap_or(self.default_call_timeout_ms)
    }

    /// 处理 evaluator 的 call 帧：登记 deadline，返回 (call_id, 生效超时)。
    /// 无 id 的帧返回 None（调用方照常转发，不追踪）。
    pub fn on_call_frame(&mut self, frame: &Value, now: Instant) -> Option<(String, u64)> {
        let id = frame.get("id").and_then(Value::as_str)?.to_string();
        let timeout_ms = self.resolve_timeout(frame);
        self.inflight.insert(
            id.clone(),
            InFlightEntry {
                deadline: now + Duration::from_millis(timeout_ms),
                waiting: WaitingSide::Evaluator,
            },
        );
        Some((id, timeout_ms))
    }

    /// 处理 evaluator 的 cap_reg 帧：timeout_ms 为正 → 更新映射；否则删除映射。
    pub fn on_cap_reg_frame(&mut self, frame: &Value) {
        let Some(name) = frame.get("name").and_then(Value::as_str) else {
            return;
        };
        match frame.get("timeout_ms").and_then(Value::as_u64).filter(|&t| t > 0) {
            Some(ms) => {
                self.cap_timeouts.insert(name.to_string(), ms);
            }
            None => {
                self.cap_timeouts.remove(name);
            }
        }
    }

    /// 处理 solution 的 capability 帧：查映射→默认，登记 deadline，返回 (id, 生效超时)。
    pub fn on_capability_frame(&mut self, frame: &Value, now: Instant) -> Option<(String, u64)> {
        let id = frame.get("id").and_then(Value::as_str)?.to_string();
        let name = frame.get("name").and_then(Value::as_str).unwrap_or("");
        let timeout_ms = self
            .cap_timeouts
            .get(name)
            .copied()
            .unwrap_or(self.default_call_timeout_ms);
        self.inflight.insert(
            id.clone(),
            InFlightEntry {
                deadline: now + Duration::from_millis(timeout_ms),
                waiting: WaitingSide::Solution,
            },
        );
        Some((id, timeout_ms))
    }

    /// 响应帧按 id 判定：命中（尚在 in-flight）→ 移除并返回 true（转发）；否则 false（丢弃）。
    pub fn resolve_response(&mut self, id: &str) -> bool {
        self.inflight.remove(id).is_some()
    }

    /// 摘除所有已超时调用，返回 (id, 等待方向) 列表。
    pub fn expire_now(&mut self, now: Instant) -> Vec<(String, WaitingSide)> {
        let expired: Vec<(String, InFlightEntry)> = self
            .inflight
            .iter()
            .filter(|(_, e)| e.deadline <= now)
            .map(|(id, e)| (id.clone(), e.clone()))
            .collect();
        let mut out = Vec::with_capacity(expired.len());
        for (id, e) in expired {
            self.inflight.remove(&id);
            out.push((id, e.waiting));
        }
        out
    }

    /// 当前最早 deadline（无 in-flight 返回 None）。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.inflight.values().map(|e| e.deadline).min()
    }

    pub fn is_empty(&self) -> bool {
        self.inflight.is_empty()
    }
}
```

（保留 Step 2 的全部测试，在文件末尾 `#[cfg(test)] mod tests { ... }`。）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd noj-judge && cargo test --lib dual::tracker`
Expected: 全部通过（11 个测试）。随后 `cargo clippy --lib` 无警告。

- [ ] **Step 6: Commit**

```bash
cd noj-judge && cargo fmt && cd ..
jj describe -m "feat(judge): 新增调用级超时追踪器 InFlightTracker（issue #198）"
```

---

### Task 2: Evaluator SDK 扩展（call timeout_ms + register_capability cap_reg 帧）

**Files:**
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py`（`SolutionRunner.call`）
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/capability.py`（`register_capability`）
- Test: `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py`

**Interfaces:**
- Produces（Task 3/5/6 消费）：
  - `SolutionRunner.call(self, fn: str, *args: Any, timeout_ms: Optional[int] = None) -> Any`
    - `timeout_ms` 为 `None` → call 帧不带 `timeout_ms` 字段；正整数 → 帧带该字段；其他值 → `raise ValueError`
  - `register_capability(name: str, handler: Callable, timeout_ms: Optional[int] = None) -> None`
    - `timeout_ms` 非 None 时校验正整数，随后写一次性 `{"type":"cap_reg","name":...,"timeout_ms":...}` 帧到 stdout；`timeout_ms=None` 写 `{"type":"cap_reg","name":...}`（无 timeout_ms 字段）

- [ ] **Step 1: 先写 SDK 测试（在 test_runner.py 追加）**

在 `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py` 的 `TestSolutionRunnerCall` 中追加（参照现有 `test_basic_call_returns_value` 的 IpcHarness 用法）：

```python
def test_call_frame_with_timeout_ms(self):
    """指定 timeout_ms 时 call 帧应带该字段。"""
    harness = IpcHarness()
    try:
        def runner():
            harness.runner.call("solve", 1, timeout_ms=5000)
        t = threading.Thread(target=runner)
        t.start()
        frame = harness.last_call_frame()
        self.assertEqual(frame.get("timeout_ms"), 5000)
        harness.send_host_response(
            {"type": "result", "id": frame["id"], "value": 3}
        )
        t.join(timeout=2.0)
        self.assertFalse(t.is_alive(), "call 应已返回")
    finally:
        harness.teardown()

def test_call_frame_without_timeout_ms(self):
    """缺省 timeout_ms 时 call 帧不应带该字段（向后兼容）。"""
    harness = IpcHarness()
    try:
        def runner():
            harness.runner.call("solve", 1)
        t = threading.Thread(target=runner)
        t.start()
        frame = harness.last_call_frame()
        self.assertNotIn("timeout_ms", frame)
        harness.send_host_response(
            {"type": "result", "id": frame["id"], "value": 3}
        )
        t.join(timeout=2.0)
    finally:
        harness.teardown()

def test_call_invalid_timeout_ms_raises(self):
    """timeout_ms 为 0 / 负数 / 非 int 时抛 ValueError。"""
    harness = IpcHarness()
    try:
        for bad in (0, -1, "5000"):
            with self.assertRaises(ValueError):
                harness.runner.call("solve", 1, timeout_ms=bad)
        # 非法值不应发出 call 帧
        self.assertEqual(len(harness.all_call_frames()), 0)
    finally:
        harness.teardown()
```

在 `TestCapability` 中追加：

```python
def test_register_capability_with_timeout_emits_cap_reg(self):
    """注册时配置 timeout_ms → stdout 写 cap_reg 帧。"""
    from noj_evaluator_sdk import register_capability
    harness = IpcHarness()
    try:
        register_capability("ping", lambda x: x, timeout_ms=9000)
        frames = harness.all_call_frames()
        reg = [f for f in frames if f.get("type") == "cap_reg"]
        self.assertEqual(len(reg), 1)
        self.assertEqual(reg[0]["name"], "ping")
        self.assertEqual(reg[0]["timeout_ms"], 9000)
    finally:
        harness.teardown()

def test_register_capability_without_timeout_emits_cap_reg_no_field(self):
    from noj_evaluator_sdk import register_capability
    harness = IpcHarness()
    try:
        register_capability("ping2", lambda x: x)
        frames = harness.all_call_frames()
        reg = [f for f in frames if f.get("type") == "cap_reg"]
        self.assertEqual(len(reg), 1)
        self.assertEqual(reg[0]["name"], "ping2")
        self.assertNotIn("timeout_ms", reg[0])
    finally:
        harness.teardown()

def test_register_capability_invalid_timeout_raises(self):
    from noj_evaluator_sdk import register_capability
    with self.assertRaises(ValueError):
        register_capability("bad", lambda x: x, timeout_ms=0)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-judge/sdk/evaluator && python3 -m unittest noj_evaluator_sdk.tests.test_runner -v 2>&1 | tail -15`
Expected: 新测试因 `TypeError: call() got an unexpected keyword argument 'timeout_ms'` / `register_capability() got an unexpected keyword argument` 失败。

- [ ] **Step 3: 扩展 runner.py 的 call()**

```python
    def call(self, fn: str, *args: Any, timeout_ms: Optional[int] = None) -> Any:
        """调用 Solution host 中的函数 `fn`。

        `timeout_ms`：本次调用的超时（毫秒），None = 由 judge 回退题目级默认；
        正整数 = 按调用指定。0 / 负数 / 非 int 抛 ValueError。

        抛出：
            SolutionTimeoutError  - 单次调用超时（host 进程仍存活）
            NotFoundError         - 函数未注册
            RejectedError         - 参数/返回值类型不允许
            ConnectionError       - IPC 通道断开（host 进程崩溃）
            SystemError           - 其他 host 内部错误
        """
        if self._closed:
            raise ConnectionError("runner 已关闭")

        # 0. timeout_ms 校验（None 或正整数）
        if timeout_ms is not None:
            if not isinstance(timeout_ms, int) or timeout_ms <= 0:
                raise ValueError(
                    f"timeout_ms 必须是正整数或 None，实际 {timeout_ms!r}"
                )

        # 1. 参数校验
        for i, arg in enumerate(args):
            validate_type(arg, f"arg[{i}]")

        # 2. 构造 call 帧
        call_id = uuid.uuid4().hex
        frame = {
            "type": "call",
            "id": call_id,
            "fn": fn,
            "args": [encode_value(a) for a in args],
        }
        if timeout_ms is not None:
            frame["timeout_ms"] = timeout_ms
```

（其余逻辑不变；注意现有第 102-155 行的 `call` 方法体，仅替换签名 + 增加校验 + 帧构造。）

- [ ] **Step 4: 扩展 capability.py 的 register_capability()**

```python
from __future__ import annotations

import json
import sys
import threading
from typing import Any, Callable, Optional

_CAPABILITIES: dict[str, Callable] = {}
_LOCK = threading.RLock()
_OUT_LOCK = threading.Lock()


def register_capability(
    name: str, handler: Callable, timeout_ms: Optional[int] = None
) -> None:
    """注册 capability。

    重复注册同名时覆盖（最近注册生效）。

    `timeout_ms`：solution 调用该 capability 时的默认超时（毫秒）；
    None = judge 回退题目级 call_timeout_ms。注册时写一次性
    `cap_reg` 帧上报 judge（judge 侧私有协议，不转发给 solution）。
    """
    if not isinstance(name, str) or not name.strip():
        raise TypeError(f"capability 名称必须是非空字符串，实际 {type(name).__name__}")
    if not callable(handler):
        raise TypeError(f"handler 必须是 callable，实际 {type(handler).__name__}")
    if timeout_ms is not None and (
        not isinstance(timeout_ms, int) or timeout_ms <= 0
    ):
        raise ValueError(
            f"timeout_ms 必须是正整数或 None，实际 {timeout_ms!r}"
        )
    with _LOCK:
        _CAPABILITIES[name] = handler
    # 上报 judge（一次性 cap_reg 帧）
    frame = {"type": "cap_reg", "name": name}
    if timeout_ms is not None:
        frame["timeout_ms"] = timeout_ms
    line = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
    with _OUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
```

- [ ] **Step 5: 运行 SDK 测试确认通过**

Run: `cd noj-judge/sdk/evaluator && python3 -m unittest noj_evaluator_sdk.tests.test_runner -v 2>&1 | tail -15`
Expected: 全部通过（含新增 7 个测试）。

- [ ] **Step 6: Commit**

```bash
cd noj-judge && cargo fmt -- sdk 2>/dev/null; cd ..
jj describe -m "feat(judge): Evaluator SDK 支持调用级 timeout_ms 与 cap_reg 上报（issue #198）"
```

---

### Task 3: dual/mod.rs 执行层接入（超时感知转发）

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`（`run_dual_loop`、`handle_eval_chunk`、`handle_sol_chunk`、mod_test_helpers）
- Test: `noj-judge/src/dual/mod.rs` 的 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `crate::dual::tracker::{InFlightTracker, WaitingSide}`（Task 1）
- Produces:
  - `run_dual_loop(submission_id, evaluator_exec, solution_exec, evaluator_timeout_ms, default_call_timeout_ms: u64, rejudge_seq)` —— `_call_timeout_ms` 参数改名并实际生效
  - `handle_eval_chunk(parser, stderr_buf, stdout_full, sol_input, result_payload, tracker, chunk)` —— 新增 `sol_input` 与 `tracker` 参数
  - `handle_sol_chunk(parser, eval_input, chunk, solution_ready, tracker)` —— 新增 `tracker` 参数
  - 超时错误帧写入辅助 `write_timeout_frame(writer, id)` → `{"type":"error","id":id,"code":"Timeout","message":"call timeout"}`

- [ ] **Step 1: 先写失败测试（追加到 mod.rs 的 tests）**

```rust
#[tokio::test]
async fn test_eval_call_frame_tracked_and_forwarded() {
    // call 帧：登记 in-flight 并转发到 sol_input
    use bollard::container::LogOutput;
    use tokio::io::AsyncReadExt;
    use crate::dual::tracker::InFlightTracker;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(sink);

    let mut parser = LineParser::new();
    let mut stderr_buf = String::new();
    let mut stdout_full = String::new();
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(2000);

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"call\",\"id\":\"c1\",\"fn\":\"solve\",\"args\":[1],\"timeout_ms\":500}\n",
        ),
    };
    handle_eval_chunk(
        &mut parser,
        &mut stderr_buf,
        &mut stdout_full,
        &mut writer,
        &mut result_payload,
        &mut tracker,
        chunk,
    )
    .await
    .unwrap();

    // 转发到 sol_input
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(2), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(text.contains("\"type\":\"call\""));
    assert!(text.contains("\"timeout_ms\":500"), "帧应原样透传");

    // in-flight 已登记：响应命中可转发、超时后可摘除
    assert!(tracker.resolve_response("c1"), "c1 应被追踪");
}

#[tokio::test]
async fn test_eval_cap_reg_frame_not_forwarded() {
    use bollard::container::LogOutput;
    use tokio::io::AsyncReadExt;
    use crate::dual::tracker::InFlightTracker;

    let (sink, mut source) = tokio::io::duplex(8192);
    let mut writer: std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>> =
        Box::pin(sink);

    let mut parser = LineParser::new();
    let mut stderr_buf = String::new();
    let mut stdout_full = String::new();
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(2000);

    let chunk = LogOutput::StdOut {
        message: bytes::Bytes::from_static(
            b"{\"type\":\"cap_reg\",\"name\":\"ping\",\"timeout_ms\":9000}\n",
        ),
    };
    handle_eval_chunk(
        &mut parser, &mut stderr_buf, &mut stdout_full,
        &mut writer, &mut result_payload, &mut tracker, chunk,
    )
    .await
    .unwrap();

    // cap_reg 帧不转发
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(1), source.read(&mut buf))
        .await
        .expect("读取转发内容超时")
        .unwrap();
    let text = String::from_utf8_lossy(&buf[..n]).to_string();
    assert!(!text.contains("cap_reg"), "cap_reg 帧不应转发到 solution");
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-judge && cargo test --lib dual:: 2>&1 | tail -8`
Expected: 编译错误（`handle_eval_chunk` 签名不匹配 / 缺少参数）。

- [ ] **Step 3: 改造 handle_eval_chunk / handle_sol_chunk / run_dual_loop**

**handle_eval_chunk**（替换现有实现，注意签名新增 `sol_input` 与 `tracker`）：

```rust
/// 处理 Evaluator exec 的一个 chunk：解析 + 转发 call 帧 + 检测 RESULT 标记。
#[allow(clippy::too_many_arguments)]
async fn handle_eval_chunk(
    parser: &mut LineParser,
    stderr_buf: &mut String,
    stdout_full: &mut String,
    sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    result_payload: &mut Option<String>,
    tracker: &mut InFlightTracker,
    chunk: LogOutput,
) -> Result<()> {
    let (data, is_err) = match chunk {
        LogOutput::StdOut { message } => (message, false),
        LogOutput::StdErr { message } => (message, true),
        _ => return Ok(()),
    };

    if is_err {
        let s = String::from_utf8_lossy(&data);
        append_capped(stderr_buf, &s);
        eprint!("[eval-stderr] {}", s);
        return Ok(());
    }

    // stdout: feed 到 LineParser
    let lines = parser.feed(&data);
    let mut awaiting_result_payload = false;
    for line in lines {
        match line {
            EvaluatorLine::ResultMarker => {
                awaiting_result_payload = true;
                append_capped(stdout_full, "---RESULT---\n");
            }
            EvaluatorLine::Frame(v) => {
                // 协议帧处理：call / cap_reg 私有帧 / result-error（capability 响应）
                let ft = frame_type(&v).map(|s| s.to_string());
                match ft.as_deref() {
                    Some("call") => {
                        // 登记调用级超时（缺省回退题目级默认），原样转发
                        tracker.on_call_frame(&v, Instant::now());
                        forward_frame(sol_input, &v).await?;
                    }
                    Some("cap_reg") => {
                        // judge 与 evaluator 的私有协议：更新映射，不转发
                        tracker.on_cap_reg_frame(&v);
                    }
                    Some("result") | Some("error") => {
                        // capability 响应帧（solution 等待）：命中则转发，否则丢弃
                        if let Some(id) = v.get("id").and_then(Value::as_str) {
                            if tracker.resolve_response(id) {
                                forward_frame(sol_input, &v).await?;
                            } else {
                                warn!("丢弃迟到的 evaluator 响应帧（id={}）", id);
                            }
                        }
                    }
                    _ => {}
                }
                // 记录所有帧到 stdout 全文（供结果展示）
                let s = v.to_string();
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
            }
            EvaluatorLine::Unknown(s) => {
                // 普通 evaluate.py 输出，丢弃
                append_capped(stdout_full, &s);
                append_capped(stdout_full, "\n");
                if awaiting_result_payload && !s.trim().is_empty() {
                    *result_payload = Some(s.trim().to_string());
                    awaiting_result_payload = false;
                }
            }
        }
    }
    Ok(())
}
```

**handle_sol_chunk**（替换现有实现，签名新增 `tracker`）：

```rust
/// 处理 Solution exec 的一个 chunk：转发 NDJSON 帧到 evaluator stdin。
async fn handle_sol_chunk(
    parser: &mut LineParser,
    eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    chunk: LogOutput,
    solution_ready: &mut bool,
    tracker: &mut InFlightTracker,
) -> Result<()> {
    let data = match chunk {
        LogOutput::StdOut { message } => message,
        LogOutput::StdErr { message } => {
            let s = String::from_utf8_lossy(&message);
            eprint!("[sol-stderr] {}", s);
            return Ok(());
        }
        _ => return Ok(()),
    };

    let lines = parser.feed(&data);
    for line in lines {
        if let EvaluatorLine::Frame(v) = line {
            let ft = frame_type(&v).map(|s| s.to_string());
            if !*solution_ready {
                if ft.as_deref() == Some("ready") {
                    *solution_ready = true;
                }
                // ready 之前的所有帧忽略（防御）
                continue;
            }
            match ft.as_deref() {
                Some("capability") => {
                    // solution 请求 capability：查注册超时登记后转发 evaluator
                    tracker.on_capability_frame(&v, Instant::now());
                    forward_frame(eval_input, &v).await?;
                }
                Some("result") | Some("error") => {
                    // call 响应帧（evaluator 等待）：命中则转发，否则丢弃（迟到）
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if tracker.resolve_response(id) {
                            forward_frame(eval_input, &v).await?;
                        } else {
                            warn!("丢弃迟到的 solution 响应帧（id={}）", id);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}
```

**run_dual_loop**（签名 `_call_timeout_ms: u64` 改名为 `default_call_timeout_ms: u64` 并实际使用；两阶段 select 都加超时分支）：

```rust
/// 主循环：双向 NDJSON 转发 + 解析 Evaluator 输出。
#[allow(clippy::too_many_arguments)]
async fn run_dual_loop(
    submission_id: &str,
    evaluator_exec: ExecSession,
    solution_exec: ExecSession,
    evaluator_timeout_ms: u64,
    default_call_timeout_ms: u64,
    rejudge_seq: Option<i64>,
) -> Result<JudgeResult> {
    // ... 解构 exec（不变）...
    let mut eval_parser = LineParser::new();
    let mut eval_stderr_buf = String::new();
    let mut eval_stdout_full = String::new();
    let mut sol_parser = LineParser::new();
    let mut solution_ready = false;
    let mut result_payload: Option<String> = None;
    let mut tracker = InFlightTracker::new(default_call_timeout_ms);

    // 阶段 1 与阶段 2 复用：处理超时到期的 in-flight 调用
    //（写 Timeout 错误帧到等待方，并丢弃迟到响应）
    let mut handle_expired = |eval_input: &mut _, sol_input: &mut _| {
        // 每次 select 返回后调用；先摘除超时调用再写帧
    };

    // 阶段 1：启动等待（原逻辑），select 增加超时分支：
    //   _ = wait_until_deadline(&tracker) => {
    //       for (id, side) in tracker.expire_now(Instant::now()) {
    //           write_timeout_frame(match side { Evaluator => &mut eval_input, Solution => &mut sol_input }, &id).await?;
    //       }
    //   }
    // 阶段 2：正式评测，同样加入上述超时分支（其余逻辑不变）
    // ...
}
```

超时分支的精确写法（两个阶段各插入到 `tokio::select!` 中）：

```rust
                // 调用级超时（in-flight 到期）
                _ = async {
                    match tracker.next_deadline() {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    for (id, side) in tracker.expire_now(Instant::now()) {
                        match side {
                            WaitingSide::Evaluator => {
                                write_timeout_frame(&mut eval_input, &id).await?;
                            }
                            WaitingSide::Solution => {
                                write_timeout_frame(&mut sol_input, &id).await?;
                            }
                        }
                    }
                }
```

新增辅助函数：

```rust
/// 向等待方写调用级超时错误帧。
async fn write_timeout_frame(
    writer: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
    id: &str,
) -> Result<()> {
    let frame = serde_json::json!({
        "type": "error",
        "id": id,
        "code": "Timeout",
        "message": "call timeout",
    });
    forward_frame(writer, &frame).await
}
```

**调用处**（`evaluate_dual` 末尾）：`runtime_config.solution.call_timeout_ms` 传入 `run_dual_loop` 的 `default_call_timeout_ms`（原 `_call_timeout_ms` 参数位置）。mod_test_helpers 中两个 probe 函数签名同步更新（新增 tracker 参数）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-judge && cargo test --lib dual:: && cargo clippy --lib`
Expected: Task 1 与新增测试全部通过，clippy 无警告（注意 `evaluate_dual` 调用处与 mod_test_helpers 的签名同步）。

- [ ] **Step 5: 全量单元测试 + fmt**

Run: `cd noj-judge && cargo fmt && cargo test --all-targets`
Expected: 全部通过。

- [ ] **Step 6: Commit**

```bash
cd noj-judge && cargo fmt
cd ..
jj describe -m "feat(judge): dual 主循环接入调用级超时（in-flight 追踪 + Timeout 错误帧）（issue #198）"
```

---

### Task 4: judge E2E（真实容器并发调用不同超时 + 缺省回退）

**Files:**
- Modify: `noj-judge/tests/e2e_dual_container.rs`
- Test: 同一文件新增 `#[ignore]` + `#[serial_test::serial]` + `#[tokio::test]` 测试

**Interfaces:**
- Consumes: `evaluate_dual`（Task 3 改造后）、`common::ensure_test_image`、既有 helper（`create_sleep_container` / `get_docker` / `is_e2e_enabled`）

- [ ] **Step 1: 新增 E2E 测试（两个用例，追加到 e2e_dual_container.rs）**

用例 A（缺省回退）：evaluator 脚本调用 `runner.call("sleep_solution", timeout_ms=None)`，solution 侧 `time.sleep(0.3)`，题目级 `call_timeout_ms=100` → 断言结果含 `CallTimeout` 失败用例、评测继续、最终 `Accepted`。

用例 B（调用级覆盖 + 并发）：evaluator 脚本两个线程并发调用：
- 线程 1：`runner.call("sleep_solution", timeout_ms=50)`（solution `time.sleep(0.3)`）→ 应超时
- 线程 2：`runner.call("fast_solution", timeout_ms=5000)`（立即返回）→ 应成功
断言线程 1 抛 `SolutionTimeoutError`、线程 2 正常返回；最终结果 `Accepted`。

参考既有 `evaluate_dual_end_to_end`（613 行）的结构：`is_e2e_enabled()` 守卫 → `get_docker()` → `common::ensure_test_image()` → 构造 `RuntimeConfig`（evaluator command 为 `python3 -c "..."` 内联脚本，solution 为真实 host）→ 调用 `evaluate_dual(...)` → 断言 `JudgeResult`。

```rust
/// 缺省回退：call 帧不带 timeout_ms 时，题目级 call_timeout_ms 生效。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_call_timeout_fallback_to_problem_default() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    // evaluator：调用 sleep 函数，不带 timeout_ms（期望回退题目级 100ms）
    let evaluator_cmd = r#"python3 -c "
import sys, json
from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
try:
    runner.call('sleep_solution')
    result.accept(score=1000, details={'cases': [{'id':'c1','status':'Accepted'}]})
except Exception as e:
    result.accept(score=0, details={'cases': [{'id':'c1','status': type(e).__name__}]})
sys.stdout.write('---RESULT---\n')
sys.stdout.flush()
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 100,   // 题目级默认：100ms
            memory_limit_mb: 128,
        },
    };
    // solution 代码：sleep_solution 睡 300ms
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = evaluate_dual(
        docker.clone(),
        "e2e-timeout-fallback",
        &runtime_config,
        code,
        "solution.py",
        None,
        "",
        0,
        0,
        None,
    )
    .await
    .expect("评测应正常返回");

    assert_eq!(result.status, "Accepted");
    let cases = result.details["cases"].as_array().expect("details.cases");
    assert_eq!(cases[0]["status"].as_str().unwrap(), "SolutionTimeoutError");
}
```

```rust
/// 调用级超时 + 并发：同题两个线程不同超时，各自独立生效。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_call_timeout_per_call_concurrent() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_test_image(&docker).await.unwrap();

    let evaluator_cmd = r#"python3 -c "
import sys, json, threading
from noj_evaluator_sdk import SolutionRunner, result
runner = SolutionRunner()
out = {}
def slow():
    try:
        runner.call('sleep_solution', timeout_ms=50)   # 50ms 超时 vs 300ms 睡眠
        out['slow'] = 'ok'
    except Exception as e:
        out['slow'] = type(e).__name__
def fast():
    try:
        v = runner.call('fast_solution', timeout_ms=5000)  # 立即返回
        out['fast'] = ('ok', v)
    except Exception as e:
        out['fast'] = type(e).__name__
t1 = threading.Thread(target=slow); t2 = threading.Thread(target=fast)
t1.start(); t2.start(); t1.join(); t2.join()
result.accept(score=1000, details={'cases': out})
sys.stdout.write('---RESULT---\n')
sys.stdout.flush()
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-judge-test-runner:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 5000,   // 题目级默认宽松；验证调用级 50ms 覆盖
            memory_limit_mb: 128,
        },
    };
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\ndef fast_solution():\n    return 42\n";

    let result = evaluate_dual(
        docker.clone(),
        "e2e-timeout-per-call",
        &runtime_config,
        code,
        "solution.py",
        None,
        "",
        0,
        0,
        None,
    )
    .await
    .expect("评测应正常返回");

    assert_eq!(result.status, "Accepted");
    let cases = result.details["cases"].as_object().expect("details.cases");
    assert_eq!(cases["slow"].as_str().unwrap(), "SolutionTimeoutError");
    assert_eq!(cases["fast"].as_array().unwrap(), &vec![serde_json::json!("ok"), serde_json::json!(42)]);
}
```

> 注：`evaluate_dual` 的确切参数个数以当前 `judge/runner.rs` 为准（`docker, submission_id, runtime_config, user_code, file_name, support_pkg, cache_dir, cache_max_items, cache_max_mb, rejudge_seq`）；执行时按真实签名核对。

- [ ] **Step 2: 编译检查**

Run: `cd noj-judge && cargo check --tests`
Expected: 编译通过（测试为 `#[ignore]`，不会默认执行）。

- [ ] **Step 3: 运行 E2E（需要 Docker daemon）**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_call_timeout -- --ignored --nocapture`
Expected: 两个用例通过（各容器内 `SolutionTimeoutError` 断言成立）。

- [ ] **Step 4: Commit**

```bash
cd noj-judge && cargo fmt
cd ..
jj describe -m "test(judge): 调用级超时 E2E（缺省回退 + 并发不同超时）（issue #198）"
```

---

### Task 5: noj-tests 全链路 E2E

**Files:**
- Create: `noj-tests/e2e/26_call_timeout.test.ts`（参照 `15_dual_container_judge.test.ts` 的模式与 helper）
- Test: 同上

**Interfaces:**
- Consumes: noj-tests helper（`15_dual_container_judge.test.ts` 中使用的创建题目/提交/轮询提交状态的函数，直接复用同目录模式）
- Produces: 验证 issue #198 端到端行为（API 层题目 runtime_config + judge 调用级超时）

- [ ] **Step 1: 新建 26_call_timeout.test.ts**

参照 `15_dual_container_judge.test.ts` 的既有结构（Deno.test + helper.ts 的登录/建题/提交/轮询），完整骨架：

```typescript
/**
 * 调用级超时（issue #198）全链路 E2E：
 * - 调用级 timeout_ms 覆盖题目级默认（慢调用按调用超时）
 * - 缺省时回退题目级 call_timeout_ms（兼容旧行为）
 */
import { assertEquals, assert } from "jsr:@std/assert";

// 参照 15_dual_container_judge.test.ts 顶部：helper.ts 的
// loginAs / createProblem / submitCode / waitSubmission 等既有导出（按实际调整）

Deno.test("call_timeout: 调用级 timeout_ms 生效，慢调用记为失败用例且评测继续", async () => {
  // 1) admin 登录并创建双容器题目（P 型），evaluator command 内联：
  //    runner.call('sleep_solution', timeout_ms=100)；solution 睡 0.3s
  //    evaluate.py 捕获异常记 details 后 result.accept
  //    参考 15 号文件第 110-186 行（admin 建题含 runtime_config 的写法）
  // 2) 提交用户代码（solution.py 定义 sleep_solution: time.sleep(0.3); return 1）
  // 3) 轮询提交状态至终态，断言：
  //    - status === "Accepted"（评测继续完成）
  //    - details.cases[0].status === "SolutionTimeoutError"（超时用例被捕获记录）
});

Deno.test("call_timeout: 缺省回退题目级 call_timeout_ms", async () => {
  // 同上，但 evaluate.py 不传 timeout_ms，题目级 call_timeout_ms 设为 100
  // 断言结果同上（SolutionTimeoutError）
});
```

执行时：
- evaluator command 用 `python3 -c "..."` 内联（与 Task 4 用例 A/B 相同脚本逻辑），或支持包方式（`problems:build`）——**优先内联 command 以最小依赖**；
- 轮询断言参考 `15_dual_container_judge.test.ts` 中"普通用户提交双容器题目 → 走 dual 评测"用例（330 行起）；
- `runtime_config.solution.call_timeout_ms` 与 `timeout_ms` 覆盖值按上面用例写死。

- [ ] **Step 2: 本地运行确认通过**

Run: `cd noj-tests && deno task test --filter call_timeout`
Expected: 两个用例通过。若本机无完整评测栈（PG/Redis/judge），说明需在 CI `e2e.yml` 全链路环境运行——本地至少保证 `deno check` 通过。

- [ ] **Step 3: Commit**

```bash
cd noj-tests && deno fmt
cd ..
jj describe -m "test(core,judge): 调用级超时全链路 E2E（issue #198）"
```

---

### Task 6: 文档与注释同步

**Files:**
- Modify: `noj-docs/docs/problemsetters/evaluator-sdk.md`
- Modify: `noj-docs/docs/problemsetters/rpc.md`
- Modify: `noj-docs/docs/problemsetters/web-editor.md`
- Modify: `noj-core/src/types/index.ts`（`SolutionRuntime.call_timeout_ms` 注释）
- Modify: `noj-core/src/services/problems-types.ts`（校验错误消息/注释说明默认值角色）

- [ ] **Step 1: evaluator-sdk.md**

在"调用用户函数"节补充：

```markdown
`runner.call()` 支持**调用级超时**：`timeout_ms` 为正整数时该次调用按指定毫秒数计时，缺省（`None`）时由 Judge Worker 回退到题目的 `runtime_config.solution.call_timeout_ms`。

```python
answer = runner.call("solve", 1, 2)                    # 用题目级默认超时
answer = runner.call("solve", 1, 2, timeout_ms=5000)   # 本次调用 5s 超时
```

`timeout_ms` 必须为正整数或 `None`，其他值抛 `ValueError`。超时后抛 `SolutionTimeoutError`，可捕获后记为失败用例继续评测。
```

在"注册 capability"节补充 `timeout_ms` 默认值语义：

```markdown
`register_capability(name, handler, timeout_ms=None)`：`timeout_ms` 为正整数时，solution 每次调用该 capability 的超时按此值（经 `cap_reg` 帧上报 Judge）；缺省时回退题目级 `call_timeout_ms`。
```

- [ ] **Step 2: rpc.md**

- "调用请求"节：call 帧 JSON 示例与字段表增加 `timeout_ms`（可选，正整数；缺省由 Judge 回退题目级 `call_timeout_ms`；该字段仅 Judge 计时用，不传给 Solution Host 执行逻辑）；
- "错误响应"节错误来源表：`CallTimeout` 行更新为"单次调用超过调用级 timeout_ms 或题目级 call_timeout_ms"；
- 新增小节说明 `cap_reg` 帧（Evaluator → Judge 私有协议，不转发）：`{"type":"cap_reg","name":...,"timeout_ms":...}`，`timeout_ms` 缺省表示删除映射回退默认。

- [ ] **Step 3: web-editor.md**

第 26-28 行说明更新：

```markdown
- **Solution**（用户代码 `solution.py`）：调用超时 `call_timeout_ms`（**题目级默认值**，出题人可在 `evaluate.py` 中用 `runner.call(..., timeout_ms=...)` 按调用覆盖）、`memory_limit_mb`
```

并补充一句：调用级超时缺省时回退该默认值，防止用户代码死循环拖垮整场评测（见[评测模型](judge-model.md)）。

- [ ] **Step 4: noj-core 注释同步**

`noj-core/src/types/index.ts`：

```typescript
  /** 单次 SDK 调用的时间上限（毫秒），作为调用级超时的默认值（runner.call 可传 timeout_ms 覆盖）。单次超时不影响 host 进程 */
  call_timeout_ms: number;
```

`noj-core/src/services/problems-types.ts:136` 错误消息不变（仍是必填正整数），在 `s` 解构上方加注释：

```typescript
  // call_timeout_ms：题目级默认调用超时；evaluator 的 runner.call(..., timeout_ms) 可按调用覆盖
```

- [ ] **Step 5: 自查 + 提交**

对照设计规格第"文档同步"节逐项核对，随后：

```bash
cd noj-core && deno fmt --check src/types/index.ts src/services/problems-types.ts
cd ..
jj describe -m "docs(root,core): 同步调用级超时文档与注释（issue #198）"
```

---

## Self-Review 记录

- **Spec 覆盖**：SDK 签名扩展 → Task 2；RPC 帧 timeout_ms + cap_reg → Task 2/3；Judge 参数化 tokio 超时 → Task 1/3；缺省回退 → Task 1（resolve_timeout）/3；capability 注册默认值 → Task 2/3；迟到响应丢弃 → Task 3（resolve_response 未命中丢弃）；文档同步 → Task 6；测试（并发不同超时 / 缺省回退）→ Task 4/5。全部覆盖。
- **占位符扫描**：各步骤含真实代码与命令；evaluator 内联脚本为完整可执行 Python。
- **类型一致性**：`InFlightTracker` 方法签名在 Task 1 定义、Task 3 消费，`WaitingSide` 两处一致；`handle_eval_chunk` / `handle_sol_chunk` 新参数名在 Task 3 内一致；`evaluate_dual` 签名以真实代码为准已注明。
