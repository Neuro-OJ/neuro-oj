//! 调用级超时追踪（judge 侧 RPC 超时实现，纯逻辑、零容器依赖）。
//!
//! 负责：
//! - call / capability 帧的超时登记（按帧内 timeout_ms，缺省回退题目级默认）
//! - cap_reg 帧维护 capability → timeout_ms 映射
//! - 响应帧按 id 命中判定（未命中 = 迟到/未知响应，应丢弃）
//! - 已超时调用批量摘除（供调用方写 Timeout 错误帧）

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
        match frame
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .filter(|&t| t > 0)
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
