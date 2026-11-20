//! 调用级超时追踪（judge 侧 RPC 超时实现，纯逻辑、零容器依赖）。
//!
//! 负责：
//! - call / capability 帧的超时登记（按帧内 timeout_ms，缺省回退题目级默认；
//!   帧值受 judge 硬上限 `max_call_timeout_ms` 截断，0 表示不限制）
//! - cap_reg 帧维护 capability → timeout_ms 映射
//! - 响应帧按 id 命中判定（未命中 = 迟到/未知响应，应丢弃）
//! - 已超时调用批量摘除（供调用方写 Timeout 错误帧）
//! - 统计 Solution 忙碌时长：任一 evaluator → solution 调用 in-flight 的区间并集，
//!   作为双容器评测上报给做题人的 `time_ms`（不含容器创建/销毁、评测脚本自身与
//!   LLM 调用等与选手代码无关的开销）

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
    /// judge 侧硬上限：evaluator 帧里的 timeout_ms 不能超过它（0 表示不限制）。
    max_call_timeout_ms: u64,
    /// 已结束的 Solution 忙碌区间累计时长。
    solution_busy: Duration,
    /// 当前忙碌区间起点（有 evaluator 等待中的调用时为 Some）。
    busy_since: Option<Instant>,
    /// 是否登记过 evaluator → solution 调用（从未调用时不上报耗时）。
    solution_called: bool,
}

impl InFlightTracker {
    /// 以题目级默认超时与 judge 硬上限创建追踪器。
    ///
    /// `max_call_timeout_ms` 对应 `JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS`，0 表示不限制
    /// （与 `clamp_runtime_config` 语义一致）：evaluator 由题目作者编写，不能在帧里
    /// 用任意大的 `timeout_ms` 绕过硬上限把评测挂住。
    pub fn new(default_call_timeout_ms: u64, max_call_timeout_ms: u64) -> Self {
        Self {
            inflight: HashMap::new(),
            cap_timeouts: HashMap::new(),
            default_call_timeout_ms,
            max_call_timeout_ms,
            solution_busy: Duration::ZERO,
            busy_since: None,
            solution_called: false,
        }
    }

    /// 是否仍有 evaluator 等待 solution 的调用。
    fn has_evaluator_waiting(&self) -> bool {
        self.inflight
            .values()
            .any(|e| e.waiting == WaitingSide::Evaluator)
    }

    /// evaluator 调用全部结束时关闭当前忙碌区间。
    fn close_busy_if_idle(&mut self, now: Instant) {
        if self.has_evaluator_waiting() {
            return;
        }
        if let Some(since) = self.busy_since.take() {
            self.solution_busy += now.saturating_duration_since(since);
        }
    }

    /// Solution 忙碌总时长（毫秒）：所有 evaluator → solution 调用 in-flight 区间的并集，
    /// 并发调用不重复计时；调用中 solution 反向等待 capability 的时间计入其中。
    /// 从未发生调用时返回 None（如启动失败、评测脚本未调用选手代码）。
    pub fn solution_time_ms(&self, now: Instant) -> Option<u64> {
        if !self.solution_called {
            return None;
        }
        let open = self
            .busy_since
            .map(|since| now.saturating_duration_since(since))
            .unwrap_or_default();
        Some((self.solution_busy + open).as_millis() as u64)
    }

    /// 取 judge 硬上限截断后的超时值（上限为 0 时原样返回）。
    fn cap_timeout(&self, ms: u64) -> u64 {
        if self.max_call_timeout_ms > 0 {
            ms.min(self.max_call_timeout_ms)
        } else {
            ms
        }
    }

    /// 从帧中读取 timeout_ms（正整数才生效，否则回退默认），再按硬上限截断。
    fn resolve_timeout(&self, frame: &Value) -> u64 {
        let requested = frame
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .filter(|&t| t > 0)
            .unwrap_or(self.default_call_timeout_ms);
        self.cap_timeout(requested)
    }

    /// 处理 evaluator 的 call 帧：登记 deadline，返回 (call_id, 生效超时)。
    /// 无 id 的帧返回 None（调用方照常转发，不追踪）。
    pub fn on_call_frame(&mut self, frame: &Value, now: Instant) -> Option<(String, u64)> {
        let id = frame.get("id").and_then(Value::as_str)?.to_string();
        let timeout_ms = self.resolve_timeout(frame);
        self.solution_called = true;
        if self.busy_since.is_none() {
            self.busy_since = Some(now);
        }
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
        match frame
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .filter(|&t| t > 0)
            .map(|ms| self.cap_timeout(ms))
        {
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
        // 注册时已按硬上限截断；缺省回退默认值同样截断（默认值可能来自题目帧或配置）。
        let timeout_ms = self.cap_timeout(
            self.cap_timeouts
                .get(name)
                .copied()
                .unwrap_or(self.default_call_timeout_ms),
        );
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
    pub fn resolve_response(&mut self, id: &str, now: Instant) -> bool {
        let hit = self.inflight.remove(id).is_some();
        if hit {
            self.close_busy_if_idle(now);
        }
        hit
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
        if !out.is_empty() {
            self.close_busy_if_idle(now);
        }
        out
    }

    /// 当前最早 deadline（无 in-flight 返回 None）。
    pub fn next_deadline(&self) -> Option<Instant> {
        self.inflight.values().map(|e| e.deadline).min()
    }
}

#[cfg(test)]
impl InFlightTracker {
    /// 是否有 in-flight 调用（生产路径通过 `next_deadline` 判断）。
    pub fn is_empty(&self) -> bool {
        self.inflight.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        let mut t = InFlightTracker::new(2000, 0);
        let (id, ms) = t.on_call_frame(&call_frame("a", None), now).unwrap();
        assert_eq!(id, "a");
        assert_eq!(ms, 2000);
    }

    #[test]
    fn test_call_frame_explicit_timeout_wins() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        let (_, ms) = t.on_call_frame(&call_frame("b", Some(500)), now).unwrap();
        assert_eq!(ms, 500);
    }

    #[test]
    fn test_call_frame_invalid_timeout_falls_back() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
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
        let mut t = InFlightTracker::new(2000, 0);
        let f = json!({"type": "call", "fn": "solve", "args": []});
        assert!(t.on_call_frame(&f, now).is_none());
    }

    #[test]
    fn test_capability_uses_registered_timeout() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "ping", "timeout_ms": 9000}));
        let f = json!({"type": "capability", "id": "cap-1", "name": "ping", "args": []});
        let (_, ms) = t.on_capability_frame(&f, now).unwrap();
        assert_eq!(ms, 9000);
    }

    #[test]
    fn test_capability_falls_back_when_not_registered() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        let f = json!({"type": "capability", "id": "cap-2", "name": "unknown", "args": []});
        let (_, ms) = t.on_capability_frame(&f, now).unwrap();
        assert_eq!(ms, 2000);
    }

    #[test]
    fn test_cap_reg_re_registration_overwrites_and_none_deletes() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
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
        let mut t = InFlightTracker::new(2000, 0);
        t.on_call_frame(&call_frame("r1", None), now).unwrap();
        assert!(t.resolve_response("r1", Instant::now()));
        assert!(
            !t.resolve_response("r1", Instant::now()),
            "已移除，二次命中应为 false"
        );
    }

    #[test]
    fn test_resolve_response_unknown_false() {
        let mut t = InFlightTracker::new(2000, 0);
        assert!(!t.resolve_response("ghost", Instant::now()));
    }

    #[test]
    fn test_expire_now_returns_expired_and_removes() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        t.on_call_frame(&call_frame("fast", Some(10)), now).unwrap();
        t.on_call_frame(&call_frame("slow", Some(10_000)), now)
            .unwrap();
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
        let mut t = InFlightTracker::new(2000, 0);
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
        let mut t = InFlightTracker::new(2000, 0);
        assert!(t.next_deadline().is_none());
        t.on_call_frame(&call_frame("x", Some(100)), now).unwrap();
        t.on_call_frame(&call_frame("y", Some(50)), now).unwrap();
        let d = t.next_deadline().unwrap();
        assert_eq!(d, now + Duration::from_millis(50));
    }

    #[test]
    fn test_frame_timeout_capped_by_max() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 5000);
        let (_, ms) = t
            .on_call_frame(&call_frame("big", Some(600_000)), now)
            .unwrap();
        assert_eq!(ms, 5000, "帧值超过硬上限必须被截断");
        // 未超上限时原样生效
        let (_, ms2) = t
            .on_call_frame(&call_frame("small", Some(1000)), now)
            .unwrap();
        assert_eq!(ms2, 1000);
    }

    #[test]
    fn test_capability_timeout_capped_by_max() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 5000);
        t.on_cap_reg_frame(&json!({"type": "cap_reg", "name": "slow", "timeout_ms": 600_000}));
        let f = json!({"type": "capability", "id": "cap-big", "name": "slow", "args": []});
        assert_eq!(t.on_capability_frame(&f, now).unwrap().1, 5000);
    }

    #[test]
    fn test_zero_max_means_unlimited() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        let (_, ms) = t
            .on_call_frame(&call_frame("big", Some(600_000)), now)
            .unwrap();
        assert_eq!(ms, 600_000, "上限为 0 表示不限制");
    }

    #[test]
    fn test_missing_timeout_falls_back_to_default_then_capped() {
        let now = Instant::now();
        // 默认值本身超过上限时也要截断
        let mut t = InFlightTracker::new(9000, 5000);
        let (_, ms) = t.on_call_frame(&call_frame("no-ts", None), now).unwrap();
        assert_eq!(ms, 5000);
        // 默认值在上限内时使用默认值
        let mut t2 = InFlightTracker::new(2000, 5000);
        let (_, ms2) = t2.on_call_frame(&call_frame("no-ts-2", None), now).unwrap();
        assert_eq!(ms2, 2000);
    }

    #[test]
    fn test_concurrent_calls_have_independent_deadlines() {
        let now = Instant::now();
        let mut t = InFlightTracker::new(2000, 0);
        t.on_call_frame(&call_frame("c1", Some(30)), now).unwrap();
        t.on_call_frame(&call_frame("c2", Some(200)), now).unwrap();
        // 30ms 时只有 c1 过期
        let e1 = t.expire_now(now + Duration::from_millis(30));
        assert_eq!(e1.len(), 1);
        assert_eq!(e1[0].0, "c1");
        // c2 仍可正常命中
        assert!(t.resolve_response("c2", Instant::now()));
    }

    // ── Solution 忙碌时长 ──

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn test_solution_time_none_without_calls() {
        let t = InFlightTracker::new(5000, 0);
        assert_eq!(t.solution_time_ms(Instant::now()), None);
    }

    #[test]
    fn test_solution_time_sums_sequential_calls() {
        let base = Instant::now();
        let mut t = InFlightTracker::new(5000, 0);
        t.on_call_frame(&call_frame("c1", None), base);
        assert!(t.resolve_response("c1", base + ms(30)));
        // 两次调用之间 evaluator 自身耗时（如调用 LLM）不计入
        t.on_call_frame(&call_frame("c2", None), base + ms(1000));
        assert!(t.resolve_response("c2", base + ms(1020)));
        assert_eq!(t.solution_time_ms(base + ms(9000)), Some(50));
    }

    #[test]
    fn test_solution_time_counts_overlapping_calls_once() {
        let base = Instant::now();
        let mut t = InFlightTracker::new(5000, 0);
        t.on_call_frame(&call_frame("c1", None), base);
        t.on_call_frame(&call_frame("c2", None), base + ms(10));
        assert!(t.resolve_response("c1", base + ms(40)));
        assert!(t.resolve_response("c2", base + ms(60)));
        assert_eq!(t.solution_time_ms(base + ms(100)), Some(60));
    }

    #[test]
    fn test_solution_time_includes_open_and_expired_calls() {
        let base = Instant::now();
        let mut t = InFlightTracker::new(100, 0);
        t.on_call_frame(&call_frame("c1", None), base);
        // 进行中的调用按当前时刻计入
        assert_eq!(t.solution_time_ms(base + ms(40)), Some(40));
        // 超时摘除后区间关闭，之后不再增长
        assert_eq!(t.expire_now(base + ms(100)).len(), 1);
        assert_eq!(t.solution_time_ms(base + ms(500)), Some(100));
    }

    #[test]
    fn test_capability_alone_does_not_count_as_solution_time() {
        let base = Instant::now();
        let mut t = InFlightTracker::new(5000, 0);
        let f = json!({"type": "capability", "id": "cap-1", "name": "ping", "args": []});
        t.on_capability_frame(&f, base);
        assert!(t.resolve_response("cap-1", base + ms(50)));
        assert_eq!(t.solution_time_ms(base + ms(100)), None);
    }
}
