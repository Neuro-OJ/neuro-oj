//! 传统 OI 题的配置、状态与确定性子任务计分。

pub mod calibration;
pub mod runner;
pub mod wasm;

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
        if self.schema_version != 1 || self.runtime_version.trim().is_empty() {
            return Err("成本表版本或运行时版本无效".to_string());
        }
        if self.hash.len() != 64
            || !self.hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("成本表摘要必须为 64 位十六进制字符串".to_string());
        }
        if self.costs.is_empty()
            || self.costs.values().any(|v| *v == 0)
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
    pub input: String,
    pub output: String,
    #[serde(default)]
    pub time_limit_ms: Option<u64>,
    #[serde(default)]
    pub memory_limit_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiSubtask {
    pub id: String,
    pub score: u32,
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
    pub backend: OiBackend,
    pub languages: Vec<OiLanguage>,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    pub checker: OiChecker,
    pub subtasks: Vec<OiSubtask>,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OiSubtaskResult {
    pub id: String,
    /// 分数 ×100，与现有 JudgeResult.score 一致。
    pub score: i32,
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
                "oi": {
                    "verdict": verdict,
                    "score": self.score,
                    "max_score": 10000,
                    "subtasks": self.subtasks,
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
    if config.subtasks.is_empty() {
        return Err("OI 题至少需要一个子任务".to_string());
    }
    let mut known_subtasks = HashSet::new();
    let mut known_inputs = HashSet::new();
    let mut total_points = 0_u32;
    for subtask in &config.subtasks {
        if subtask.id.is_empty() || !known_subtasks.insert(subtask.id.as_str()) {
            return Err(format!("重复或为空的子任务 ID: {}", subtask.id));
        }
        if subtask.score == 0 || subtask.cases.is_empty() {
            return Err(format!("子任务 {} 的分数或测试点无效", subtask.id));
        }
        total_points = total_points
            .checked_add(subtask.score)
            .ok_or_else(|| "子任务分数溢出".to_string())?;
        for case in &subtask.cases {
            if case.input.is_empty() || !known_inputs.insert(case.input.as_str()) {
                return Err(format!("重复或为空的测试点输入: {}", case.input));
            }
        }
    }
    if total_points != 100 {
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
        if subtask
            .depends_on
            .iter()
            .any(|dependency| !passed.contains(dependency.as_str()))
        {
            subtasks[index] = Some(OiSubtaskResult {
                id: subtask.id.clone(),
                score: 0,
                status: OiStatus::Ignored,
                cases: vec![],
            });
            continue;
        }
        let mut cases = Vec::with_capacity(subtask.cases.len());
        let mut subtask_status = OiStatus::Accepted;
        for case in &subtask.cases {
            let result = results
                .get(case.input.as_str())
                .ok_or_else(|| format!("缺少测试点结果: {}", case.input))?;
            if subtask_status == OiStatus::Accepted && result.status != OiStatus::Accepted {
                subtask_status = result.status;
                if status == OiStatus::Accepted {
                    status = result.status;
                }
            }
            cases.push((*result).clone());
        }
        let subtask_score = if subtask_status == OiStatus::Accepted {
            passed.insert(subtask.id.as_str());
            (subtask.score as i32) * 100
        } else {
            0
        };
        score += subtask_score;
        subtasks[index] = Some(OiSubtaskResult {
            id: subtask.id.clone(),
            score: subtask_score,
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
