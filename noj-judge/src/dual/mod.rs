//! 双容器编排核心（设计稿 §1）。
//!
//! 关键路径：
//! 1. 创建 Evaluator + Solution 容器（Solution 恒无网；Evaluator 按配置可选联网）
//! 2. 注入支持包到 Evaluator（如有）与用户代码到 Solution
//! 3. 启动两个 exec（Evaluator 跑 evaluate.py；Solution 跑 host.py）
//! 4. 阶段 1：等待 Evaluator 首条输出（30s 启动超时，不计入题目时限）
//! 5. 阶段 2：双向消息转发（evaluator stdout ↔ solution stdin/stderr）+ 调用级超时
//! 6. 等待 Evaluator stdout 出现 `---RESULT---` 标记，解析结果
//! 7. 未出 RESULT 时按 finalize_outcome 判定（总超时 → SystemError；曾发 CallTimeout → TLE）
//! 8. RAII 清理两个容器
//!
//! 子模块职责：`config` 运行时配置复验/收敛与通用辅助；`frames` exec 输出帧处理；
//! `orchestrator` 评测入口与主循环；`payload`/`pipe`/`result` 结果解析与管道写入。

pub mod container;
pub mod inject;
pub mod llm_env;
pub mod protocol;
pub mod tracker;

mod config;
mod frames;
mod orchestrator;
mod payload;
mod pipe;
mod result;

#[cfg(test)]
mod tests;

#[cfg(test)]
use crate::dual::protocol::LineParser;
#[cfg(test)]
use crate::dual::tracker::InFlightTracker;
#[cfg(test)]
use crate::types::{JudgeResult, JudgeStatus, RuntimeConfig};
#[cfg(test)]
use bollard::container::LogOutput;
#[cfg(test)]
use std::time::{Duration, Instant};

pub(crate) use config::{
    append_capped, clamp_runtime_config, inject_support_package_to_evaluator,
    read_container_memory_peak_kb, validate_runtime_config,
};
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use config::{
    image_allowed, require_solution, MSG_COMMAND_NOT_ALLOWED, MSG_IMAGE_NOT_ALLOWED,
    MSG_NETWORK_NOT_ALLOWED,
};
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use frames::drain_eval_tail;
pub(crate) use frames::{handle_eval_chunk, handle_sol_chunk};
pub(crate) use inject::inject_file_stream_to_container;
pub use orchestrator::evaluate_dual_with_cpu_limit;
#[cfg(test)]
pub(crate) use orchestrator::{finalize_outcome, TimeoutKind};
pub use payload::ResultPayload;
pub(crate) use result::build_judge_result;

/// 评测输出全文/错误累积上限（1 MiB）。恶意提交可无限打印，
/// 若无限 append 会拖垮 judge 进程（容器内存限制不约束 judge）。
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// Solution 容器入口文件名（评测内部约定，硬编码；与 noj_solution_sdk.host
/// 的 `--entry` 路径一致，模块名固定为 `user_solution`，文件名不影响评测）。
pub const SOLUTION_ENTRY_FILE: &str = "main.py";

/// 集成测试辅助（tests/ 目录 E2E 使用，复用真实转发逻辑）。
///
/// 封装 [`handle_eval_chunk`] / [`handle_sol_chunk`]，跳过 stdout/stderr 收集，
/// 让 E2E 测试直接驱动 judge 转发语义。
#[allow(dead_code)] // 仅 tests/ 集成测试引用（lib 目标下必然未使用）
pub mod mod_test_helpers {
    use super::*;
    use crate::dual::protocol::LineParser;
    use crate::dual::tracker::InFlightTracker;
    use bollard::container::LogOutput;

    /// 等价 `handle_eval_chunk`，忽略 stderr/stdout 全文收集。
    pub async fn handle_eval_chunk_probe(
        parser: &mut LineParser,
        sol_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        result_payload: &mut ResultPayload,
        tracker: &mut InFlightTracker,
        chunk: LogOutput,
    ) {
        let mut stderr_buf = String::new();
        let mut stdout_full = String::new();
        let _ = super::handle_eval_chunk(
            parser,
            &mut stderr_buf,
            &mut stdout_full,
            sol_input,
            result_payload,
            tracker,
            chunk,
        )
        .await;
    }

    /// 等价 `handle_sol_chunk`。
    pub async fn handle_sol_chunk_probe(
        parser: &mut LineParser,
        eval_input: &mut std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>,
        chunk: LogOutput,
        solution_ready: &mut bool,
        tracker: &mut InFlightTracker,
    ) {
        let _ = super::handle_sol_chunk(parser, eval_input, chunk, solution_ready, tracker).await;
    }
}
