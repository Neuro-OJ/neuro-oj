//! 传统 OI 题的配置、状态与确定性子任务计分。

#[cfg(target_os = "linux")]
mod compiler_fs;
mod docker_exec;
pub mod go_judge;
pub mod progress;
pub mod resource_lease;
pub mod runner;
pub mod standard;
pub mod toolchain;
pub mod wasm;
// Worker 二进制不调用独立分析入口；lib/bin wasm-analyze 使用。
#[allow(dead_code)]
pub mod wasm_analyze;
mod wasm_compile;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::types::JudgeResult;

/// WASM 运行时的可信成本快照，由 core 在构造任务时注入。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OiCostProfile {
    pub schema_version: u32,
    pub runtime_version: String,
    #[serde(default)]
    pub costs: HashMap<String, u8>,
    #[serde(default)]
    pub variable_costs: HashMap<String, u8>,
    pub io_fuel_per_byte: u64,
    pub fuel_per_ms: f64,
    pub hash: String,
    #[serde(default)]
    pub toolchain: Option<String>,
    #[serde(default)]
    pub benchmark: Option<String>,
    #[serde(default)]
    pub hardware: Option<String>,
}

impl OiCostProfile {
    /// 验证成本表边界，避免题目消息用极小或无限 fuel 伪造限制。
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || self.runtime_version != "wasmtime-49" {
            return Err("成本表版本或运行时版本无效".to_string());
        }
        if self.hash.len() != 64
            || !self
                .hash
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("成本表摘要必须为 64 位十六进制字符串".to_string());
        }
        if self.costs.len() != 1
            || self.costs.get("default") != Some(&1)
            || self.costs.values().any(|v| *v == 0)
            || self
                .variable_costs
                .keys()
                .any(|key| !is_supported_variable_cost(key))
            || self.variable_costs.values().any(|v| *v == 0)
            || self.io_fuel_per_byte == 0
            || !self.fuel_per_ms.is_finite()
            || self.fuel_per_ms <= 0.0
        {
            return Err("成本表必须包含正的、有限的成本".to_string());
        }
        Ok(())
    }
}

/// 成本表字段必须能映射到当前 Wasmtime 版本的公开变量成本字段；未知字段
/// 若被静默接受，会导致校准报告与实际 fuel 计量不一致。
pub fn is_supported_variable_cost(name: &str) -> bool {
    matches!(
        name,
        "memory_copy_per_byte"
            | "memory_fill_per_byte"
            | "memory_init_per_byte"
            | "memory_grow_per_page"
            | "table_copy_per_element"
            | "table_fill_per_element"
            | "table_init_per_element"
            | "table_grow_per_element"
            | "array_copy_per_element"
            | "array_fill_per_element"
            | "array_new_data_per_element"
            | "array_init_data_per_element"
            | "array_new_elem_per_element"
            | "array_init_elem_per_element"
            | "array_new_default_per_element"
            | "array_new_per_element"
    )
}

/// testlib 0 为通过，1/2 为错答或格式不符；3（FAIL）及其他未知退出码
/// 属于 checker/题包故障，不能归咎于选手。三个后端共用此映射。
pub(crate) fn testlib_verdict_from_exit(code: Option<i64>) -> OiStatus {
    match code {
        Some(0) => OiStatus::Accepted,
        Some(1 | 2) => OiStatus::WrongAnswer,
        _ => OiStatus::SystemError,
    }
}

/// Hydro testlib 部分分：比例大于 1 时按百分数解释，测试点分数向下取整。
pub(crate) fn testlib_points(
    code: Option<i64>,
    stderr: &[u8],
    maximum: f64,
) -> (OiStatus, Option<f64>) {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim_start();
    let partially = text.starts_with("partially correct (");
    let raw = if let Some(rest) = text.strip_prefix("points ") {
        rest.split_whitespace().next()
    } else if let Some(rest) = text.strip_prefix("partially correct (") {
        rest.split(')').next()
    } else {
        None
    };
    if matches!(code, Some(0 | 1 | 2 | 7)) || code.is_some_and(|code| (16..=116).contains(&code)) {
        if let Some(raw) = raw {
            let Ok(mut ratio) = raw.parse::<f64>() else {
                return (OiStatus::SystemError, None);
            };
            if ratio > 1.0 {
                ratio /= 100.0;
            }
            if !ratio.is_finite() || !(0.0..=1.0).contains(&ratio) {
                return (OiStatus::SystemError, None);
            }
            return (
                if ratio == 1.0 && !partially {
                    OiStatus::Accepted
                } else {
                    OiStatus::WrongAnswer
                },
                Some((maximum * ratio).floor()),
            );
        }
    }
    (testlib_verdict_from_exit(code), None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OiStatus {
    #[serde(rename = "AC")]
    Accepted,
    #[serde(rename = "WA")]
    WrongAnswer,
    #[serde(rename = "TLE")]
    TimeLimitExceeded,
    #[serde(rename = "MLE")]
    MemoryLimitExceeded,
    #[serde(rename = "OLE")]
    OutputLimitExceeded,
    #[serde(rename = "RE")]
    RuntimeError,
    #[serde(rename = "CE")]
    CompileError,
    #[serde(rename = "SE")]
    SystemError,
    #[serde(rename = "FE")]
    FormatError,
    #[serde(rename = "IGN")]
    Ignored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OiBackend {
    Native,
    Wasm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OiLanguage {
    C,
    #[serde(rename = "cc")]
    Cpp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OiCheckerType {
    Default,
    Strict,
    Testlib,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiChecker {
    #[serde(rename = "type")]
    pub kind: OiCheckerType,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiCase {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    pub input: String,
    pub output: String,
    #[serde(default)]
    pub time_limit_ms: Option<u64>,
    #[serde(default)]
    pub memory_limit_mb: Option<u64>,
}

/// 与 Hydro 一致的子任务聚合；旧 all 配置解释为 min。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OiScoring {
    #[default]
    #[serde(alias = "all")]
    Min,
    Max,
    Sum,
}

impl OiStatus {
    /// Hydro 状态优先级；正常短路的 IGN 不参与失败状态汇总。
    fn priority(self) -> u8 {
        match self {
            Self::Accepted | Self::Ignored => 1,
            Self::WrongAnswer => 2,
            Self::TimeLimitExceeded => 3,
            Self::MemoryLimitExceeded => 4,
            Self::OutputLimitExceeded => 5,
            Self::RuntimeError => 6,
            Self::CompileError => 7,
            Self::SystemError => 8,
            Self::FormatError => 31,
        }
    }
}

impl OiSubtask {
    /// 默认整数等分，余数由最后几个测试点获得。
    pub fn case_max_scores(&self) -> Vec<f64> {
        if self.scoring != OiScoring::Sum {
            return self
                .cases
                .iter()
                .map(|case| case.score.unwrap_or(self.score))
                .collect();
        }
        let explicit: f64 = self.cases.iter().filter_map(|case| case.score).sum();
        let missing = self
            .cases
            .iter()
            .filter(|case| case.score.is_none())
            .count();
        let remaining = (self.score - explicit).max(0.0);
        let base = if missing == 0 {
            0.0
        } else {
            (remaining / missing as f64).floor()
        };
        let remainder = remaining - base * missing as f64;
        let mut index = 0;
        self.cases
            .iter()
            .map(|case| {
                case.score.unwrap_or_else(|| {
                    let score = base + (remainder - (missing - 1 - index) as f64).clamp(0.0, 1.0);
                    index += 1;
                    score
                })
            })
            .collect()
    }

    /// 只有达到 Hydro 短路条件时才允许停止后续点；sum 的 WA 不短路。
    pub fn should_stop(&self, results: &[OiCaseResult]) -> bool {
        let maximums = self.case_max_scores();
        let mut score = if self.scoring == OiScoring::Min {
            self.score
        } else {
            0.0
        };
        for result in results {
            let Some(index) = self
                .cases
                .iter()
                .position(|case| case.input == result.input)
            else {
                continue;
            };
            if result.status == OiStatus::Ignored {
                continue;
            }
            let points = result
                .score
                .unwrap_or(if result.status == OiStatus::Accepted {
                    maximums[index]
                } else {
                    0.0
                });
            score = match self.scoring {
                OiScoring::Min => score.min(points),
                OiScoring::Max => score.max(points),
                OiScoring::Sum => score + points,
            };
        }
        (self.scoring == OiScoring::Min && score == 0.0)
            || (self.scoring == OiScoring::Max && (score - self.score).abs() < 1e-7)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiSubtask {
    pub id: String,
    /// 子任务分数，允许与 core 契约一致的最多两位小数（总和为 100）。
    pub score: f64,
    #[serde(default)]
    pub scoring: OiScoring,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub time_limit_ms: Option<u64>,
    #[serde(default)]
    pub memory_limit_mb: Option<u64>,
    pub cases: Vec<OiCase>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiRuntimeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_test: Option<OiSelfTestConfig>,
    #[serde(default)]
    pub scoring_version: Option<u32>,
    pub backend: OiBackend,
    pub languages: Vec<OiLanguage>,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    pub checker: OiChecker,
    pub subtasks: Vec<OiSubtask>,
    /// Hydro 兼容的文件输入前缀；为空时使用 stdin/stdout。
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub compile_extra_files: Vec<String>,
    /// 仅注入受信 checker 编译/运行沙箱；Hydro judge_extra_files 映射到这里。
    #[serde(default)]
    pub checker_extra_files: Vec<String>,
    #[serde(default)]
    pub user_extra_files: Vec<String>,
}

/// Core 独立自测入口注入，正式题目配置禁止携带。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiSelfTestConfig {
    pub no_compare_inputs: Vec<String>,
}

/// 可单独反序列化的 OI 任务视图，供执行器消费。
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiJudgeTask {
    pub submission_id: String,
    pub problem_id: String,
    pub user_id: String,
    pub judge_type: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub download_url: Option<String>,
    pub runtime_config: OiRuntimeConfig,
    pub language: String,
    pub code: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub rejudge_seq: Option<i64>,
}

#[allow(dead_code)]
fn default_priority() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiCaseResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_truncated: Option<bool>,
    /// checker 返回的分数，以题目分值为单位；普通 AC/WA 由 scorer 推导。
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub max_score: Option<f64>,
    #[serde(default)]
    pub case_id: Option<String>,
    pub input: String,
    pub status: OiStatus,
    pub time_ms: Option<u64>,
    pub memory_kb: Option<u64>,
    #[serde(default)]
    pub cpu_time_ms: Option<u64>,
    #[serde(default)]
    pub wall_time_ms: Option<u64>,
    #[serde(default)]
    pub equivalent_time_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuel_consumed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuel_budget: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiSubtaskResult {
    pub id: String,
    /// 分数 ×100，与现有 JudgeResult.score 一致。
    pub score: i32,
    pub max_score: i32,
    pub status: OiStatus,
    pub cases: Vec<OiCaseResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiEvaluation {
    pub status: OiStatus,
    /// 分数 ×100，与现有 JudgeResult.score 一致。
    pub score: i32,
    pub subtasks: Vec<OiSubtaskResult>,
}

/// 取消用例不伪装成超时；未执行时资源和流输出保持缺省。
pub(crate) fn cancelled_case(case: &OiCase) -> OiCaseResult {
    OiCaseResult {
        input: case.input.clone(),
        case_id: case.id.clone(),
        status: OiStatus::Ignored,
        score: Some(0.0),
        max_score: None,
        stdout: None,
        stderr: None,
        stdout_truncated: None,
        stderr_truncated: None,
        time_ms: None,
        memory_kb: None,
        cpu_time_ms: None,
        wall_time_ms: None,
        equivalent_time_ms: None,
        fuel_consumed: None,
        fuel_budget: None,
        termination_reason: Some("cancelled".to_string()),
    }
}

/// 返回满足依赖关系的稳定拓扑顺序。声明顺序只用于打破同层并列关系，
/// 因此题包可以先声明高阶子任务，再在 `depends_on` 中引用前置子任务。
pub(crate) fn subtask_execution_order(config: &OiRuntimeConfig) -> Result<Vec<usize>, String> {
    let mut pending: Vec<usize> = (0..config.subtasks.len()).collect();
    let mut scheduled = HashSet::new();
    let mut order = Vec::with_capacity(pending.len());
    while !pending.is_empty() {
        let next = pending.iter().position(|&index| {
            config.subtasks[index]
                .depends_on
                .iter()
                .all(|dependency| scheduled.contains(dependency.as_str()))
        });
        let Some(position) = next else {
            return Err("子任务依赖存在环".to_string());
        };
        let index = pending.remove(position);
        scheduled.insert(config.subtasks[index].id.as_str());
        order.push(index);
    }
    Ok(order)
}

impl OiEvaluation {
    /// 转为现有 MQ 结果封套，细分状态与测试点保存在 details 中。
    pub fn to_judge_result(
        &self,
        submission_id: &str,
        rejudge_seq: Option<i64>,
        time_ms: Option<u64>,
        memory_kb: Option<u64>,
    ) -> JudgeResult {
        let verdict = self.status;
        JudgeResult {
            submission_id: submission_id.to_string(),
            status: if self.status == OiStatus::SystemError {
                "error"
            } else {
                "finished"
            }
            .to_string(),
            score: self.score,
            output: String::new(),
            details: json!({
                "oi_status": verdict,
                "scoring_version": 2,
                "subtasks": &self.subtasks,
                "oi": {
                    "verdict": verdict,
                    "scoring_version": 2,
                    "backend": "native",
                    "score": self.score,
                    "max_score": 10000,
                    "subtasks": &self.subtasks,
                }
            }),
            time_ms,
            memory_kb,
            rejudge_seq,
        }
    }
}

/// 按依赖拓扑顺序计分，结果仍按题目声明顺序返回。
pub fn score_submission(
    config: &OiRuntimeConfig,
    case_results: &[OiCaseResult],
) -> Result<OiEvaluation, String> {
    if config.scoring_version.is_some_and(|version| version != 2) {
        return Err("不支持的 OI 评分协议，请重测".to_string());
    }
    if config.subtasks.is_empty() {
        return Err("OI 题至少需要一个子任务".to_string());
    }
    let mut known_subtasks = HashSet::new();
    let mut known_inputs = HashSet::new();
    let mut total_points = 0.0_f64;
    for subtask in &config.subtasks {
        if subtask.id.is_empty() || !known_subtasks.insert(subtask.id.as_str()) {
            return Err(format!("重复或为空的子任务 ID: {}", subtask.id));
        }
        if !subtask.score.is_finite()
            || subtask.score <= 0.0
            || (subtask.score * 100.0 - (subtask.score * 100.0).round()).abs() > 1e-6
            || subtask.cases.is_empty()
        {
            return Err(format!("子任务 {} 的分数或测试点无效", subtask.id));
        }
        total_points += subtask.score;
        for case in &subtask.cases {
            if case.score.is_some_and(|score| {
                !score.is_finite()
                    || score < 0.0
                    || score > subtask.score
                    || (score * 100.0 - (score * 100.0).round()).abs() > 1e-6
            }) {
                return Err(format!("测试点 {} 分值非法", case.input));
            }
            if case.input.is_empty() || !known_inputs.insert(case.input.as_str()) {
                return Err(format!("重复或为空的测试点输入: {}", case.input));
            }
        }
    }
    if (total_points - 100.0).abs() > 1e-6 {
        return Err(format!("子任务总分必须为 100，当前为 {total_points}"));
    }
    for subtask in &config.subtasks {
        let mut unique_dependencies = HashSet::new();
        for dependency in &subtask.depends_on {
            if !known_subtasks.contains(dependency.as_str())
                || dependency == &subtask.id
                || !unique_dependencies.insert(dependency.as_str())
            {
                return Err(format!("子任务 {} 的依赖无效: {}", subtask.id, dependency));
            }
        }
    }

    let order = subtask_execution_order(config)?;

    let mut results = HashMap::new();
    for result in case_results {
        if !known_inputs.contains(result.input.as_str()) {
            return Err(format!("未知测试点结果: {}", result.input));
        }
        if results.insert(result.input.as_str(), result).is_some() {
            return Err(format!("重复测试点结果: {}", result.input));
        }
    }

    let mut passed = HashSet::new();
    let mut subtasks = vec![None; config.subtasks.len()];
    let mut score = 0_i32;
    let mut status = OiStatus::Accepted;
    for index in order {
        let subtask = &config.subtasks[index];
        let maximums = subtask.case_max_scores();
        let blocked = subtask
            .depends_on
            .iter()
            .any(|dependency| !passed.contains(dependency.as_str()));
        let mut cases = Vec::with_capacity(subtask.cases.len());
        let mut subtask_status = OiStatus::Accepted;
        let mut points = if subtask.scoring == OiScoring::Min {
            subtask.score
        } else {
            0.0
        };
        for (case_index, case) in subtask.cases.iter().enumerate() {
            let maximum = maximums[case_index];
            // 已经执行的并发结果仍必须汇总；只有缺失结果且已达到短路条件才补 IGN。
            let result = if blocked {
                None
            } else {
                results.get(case.input.as_str()).copied()
            };
            let Some(result) = result else {
                if !blocked && !subtask.should_stop(&cases) {
                    return Err(format!("缺少测试点结果: {}", case.input));
                }
                cases.push(OiCaseResult {
                    stdout: None,
                    stderr: None,
                    stdout_truncated: None,
                    stderr_truncated: None,
                    case_id: Some(
                        case.id
                            .clone()
                            .unwrap_or_else(|| format!("{}_{}", subtask.id, case_index + 1)),
                    ),
                    input: case.input.clone(),
                    status: OiStatus::Ignored,
                    score: Some(0.0),
                    max_score: Some(maximum),
                    time_ms: None,
                    memory_kb: None,
                    cpu_time_ms: None,
                    wall_time_ms: None,
                    equivalent_time_ms: None,
                    fuel_consumed: None,
                    fuel_budget: None,
                    termination_reason: Some(
                        if blocked {
                            "dependency_failed"
                        } else {
                            "scoring_short_circuit"
                        }
                        .to_string(),
                    ),
                });
                continue;
            };
            let mut result = result.clone();
            result.case_id = Some(
                case.id
                    .clone()
                    .unwrap_or_else(|| format!("{}_{}", subtask.id, case_index + 1)),
            );
            result.max_score = Some(maximum);
            let earned = result
                .score
                .unwrap_or(if result.status == OiStatus::Accepted {
                    maximum
                } else {
                    0.0
                });
            if !earned.is_finite() || earned < 0.0 || earned > maximum {
                return Err(format!("测试点 {} 返回非法分数", case.input));
            }
            result.score = Some(earned);
            if result.status != OiStatus::Ignored {
                points = match subtask.scoring {
                    OiScoring::Min => points.min(earned),
                    OiScoring::Max => points.max(earned),
                    OiScoring::Sum => points + earned,
                };
                if result.status.priority() > subtask_status.priority() {
                    subtask_status = result.status;
                }
                if result.status.priority() > status.priority() {
                    status = result.status;
                }
            }
            cases.push(result);
        }
        if blocked {
            points = 0.0;
            subtask_status = OiStatus::Ignored;
        } else if subtask_status == OiStatus::Accepted {
            passed.insert(subtask.id.as_str());
        }
        let subtask_score = (points * 100.0).round() as i32;
        score += subtask_score;
        subtasks[index] = Some(OiSubtaskResult {
            id: subtask.id.clone(),
            score: subtask_score,
            max_score: (subtask.score * 100.0).round() as i32,
            status: subtask_status,
            cases,
        });
    }
    Ok(OiEvaluation {
        status,
        score,
        subtasks: subtasks.into_iter().map(Option::unwrap).collect(),
    })
}

#[cfg(test)]
mod hydro_checker_tests {
    use super::*;
    #[test]
    fn checker_partial_points_preserve_hydro_rounding_and_status() {
        assert_eq!(
            testlib_points(Some(7), b"points 0.5 partial", 33.0),
            (OiStatus::WrongAnswer, Some(16.0))
        );
        assert_eq!(
            testlib_points(Some(7), b"points 100 correct", 33.0),
            (OiStatus::Accepted, Some(33.0))
        );
        assert_eq!(
            testlib_points(Some(16), b"partially correct (50) half", 33.0),
            (OiStatus::WrongAnswer, Some(16.0))
        );
        assert_eq!(
            testlib_points(Some(7), b"points NaN invalid", 100.0),
            (OiStatus::SystemError, None)
        );
        assert_eq!(
            testlib_points(Some(3), b"points 1 checker failure", 100.0),
            (OiStatus::SystemError, None)
        );
    }
}
