use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 评测系统级状态枚举。
///
/// 新协议下 evaluate.py 结果 JSON 不再输出 status，judge 统一映射为
/// `finished` / `error`；`JudgeStatus` 仅覆盖 judge 侧自行判定的系统级状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JudgeStatus {
    /// 超出时间限制
    TimeLimitExceeded,
    /// 系统错误（评测环境异常）
    SystemError,
}

impl JudgeStatus {
    /// 返回状态的字符串表示，用于测试和日志记录。
    #[cfg(test)]
    pub fn as_str(&self) -> &'static str {
        match self {
            JudgeStatus::TimeLimitExceeded => "TimeLimitExceeded",
            JudgeStatus::SystemError => "SystemError",
        }
    }
}

/// 双容器模式下的 Runtime 配置（与 noj-core/src/types/index.ts 的 RuntimeConfig 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub evaluator: EvaluatorRuntime,
    pub solution: SolutionRuntime,
}

/// Evaluator 容器网络配置（可选，缺省 = 无网）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorNetwork {
    /// 是否启用网络（true = Docker bridge 模式联网）。
    #[serde(default)]
    pub enabled: bool,
}

/// 双容器模式下的 Evaluator 运行时配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorRuntime {
    pub image: String,
    pub command: String,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    /// 网络配置；缺省/None = 容器保持 `network_mode: none`（与旧行为一致）。
    #[serde(default)]
    pub network: Option<EvaluatorNetwork>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionRuntime {
    pub image: String,
    /// 单次 SDK 调用的时间上限（毫秒）。
    pub call_timeout_ms: u64,
    pub memory_limit_mb: u64,
}

/// LLM 评测任务字段（与 noj-core 的 JudgeTaskLlm 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeTaskLlm {
    pub gateway_url: String,
    pub eval_token: String,
    pub provider_id: String,
    pub allowed_models: Vec<String>,
}

/// 评测任务——从 noj-core 发送到 noj-judge 的消息。
///
/// 字段对齐 noj-core/src/types/index.ts 的 JudgeTask 接口。
/// 所有评测统一使用双容器模式（Evaluator + Solution），由 `runtime_config` 提供配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeTask {
    /// 提交 UUID
    pub submission_id: String,
    /// 题目 UUID（消息协议字段，与 noj-core 的 JudgeTask 对齐；judge 当前不消费）
    #[allow(dead_code)]
    pub problem_id: String,
    /// 支持包下载 URL（`noj-download://` 格式）
    pub download_url: Option<String>,
    /// artifact 提交的下载 URL（`noj-download://` 格式），仅 artifact 模式携带
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_download_url: Option<String>,
    /// 双容器 Runtime 配置（必填）
    pub runtime_config: RuntimeConfig,
    /// 编程语言标识
    pub language: String,
    /// 用户源代码
    pub code: String,
    /// 用户代码的文件名
    pub file_name: Option<String>,
    /// 重测序列号（透传回 JudgeResult）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejudge_seq: Option<i64>,
    /// LLM 评测字段（启用 LLM 的题目携带）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm: Option<JudgeTaskLlm>,
    /// 用户 BYOK LLM 字段；仅由 judge 处理，不注入 Evaluator 环境。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_llm: Option<JudgeTaskLlm>,
}

/// 评测结果——从 noj-judge 返回到 noj-core 的消息。
///
/// 字段对齐 noj-core/src/types/index.ts 的 JudgeResult 接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeResult {
    /// 提交 UUID
    pub submission_id: String,
    /// 评测状态
    pub status: String,
    /// 得分 ×100
    pub score: i32,
    /// 评测命令的 stdout/stderr 完整输出
    pub output: String,
    /// 结构化结果（透传 evaluate.py details，含 cases 数组）
    pub details: Value,
    /// 总运行耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_ms: Option<u64>,
    /// 峰值内存（KB）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_kb: Option<u64>,
    /// 重测序列号（由 noj-core 设置，透传回 saveEvaluationResult 做竞态校验）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejudge_seq: Option<i64>,
}

impl JudgeResult {
    fn empty_details() -> Value {
        json!({})
    }

    /// 构造一个系统错误结果（对用户隐藏内部错误细节）。
    ///
    /// 内部错误详情由调用方负责记录日志；`output` 是返回给用户的友好信息。
    pub fn error(submission_id: &str, rejudge_seq: Option<i64>) -> Self {
        // 对用户隐藏内部错误细节，避免信息泄露
        Self::system_error(
            submission_id,
            &format!("系统内部错误 (submission: {})", submission_id),
            rejudge_seq,
        )
    }

    /// 构造一个超时结果（统一映射为 error）。
    pub fn timeout(submission_id: &str, output: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: "error".to_string(),
            score: 0,
            output: output.to_string(),
            details: Self::empty_details(),
            time_ms: None,
            memory_kb: None,
            rejudge_seq,
        }
    }

    /// 构造一个系统错误结果（评测环境/脚本异常，非用户代码问题）。
    pub fn system_error(submission_id: &str, output: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: "error".to_string(),
            score: 0,
            output: output.to_string(),
            details: Self::empty_details(),
            time_ms: None,
            memory_kb: None,
            rejudge_seq,
        }
    }
}

/// 通用评测用例结果。
///
/// 由 evaluate.py 在 details.cases 数组中填充，用于前端统一渲染。
/// 所有 output 字段均为可选的——有些题目不适合展示具体输入输出。
///
/// 作为协议文档类型保留：judge 生产路径不直接消费，仅对外契约参考与测试使用。
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseResult {
    /// 用例标识
    pub case_id: String,
    /// 该用例评测状态
    pub status: String,
    /// 该用例耗时（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_ms: Option<u64>,
    /// 该用例内存（KB）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_kb: Option<u64>,
    /// 输入内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// 期望输出
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<String>,
    /// 实际输出
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_output: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // ── JudgeStatus ──

    #[test]
    fn test_judge_status_as_str() {
        assert_eq!(JudgeStatus::TimeLimitExceeded.as_str(), "TimeLimitExceeded");
        assert_eq!(JudgeStatus::SystemError.as_str(), "SystemError");
    }

    // ── JudgeTask 反序列化 ──

    #[test]
    fn test_judge_task_deserialize_minimal() {
        let json = json!({
            "submission_id": "sid-123",
            "problem_id": "1001",
            "runtime_config": {
                "evaluator": {"image": "noj-evaluator-python", "command": "python3 /workspace/evaluate.py", "time_limit_ms": 5000, "memory_limit_mb": 512},
                "solution": {"image": "noj-solution-python", "call_timeout_ms": 2000, "memory_limit_mb": 512}
            },
            "language": "python3",
            "code": "print('hello')",
        });
        let task: JudgeTask = serde_json::from_value(json).unwrap();
        assert_eq!(task.submission_id, "sid-123");
        assert_eq!(task.problem_id, "1001");
        assert_eq!(task.runtime_config.evaluator.image, "noj-evaluator-python");
        assert_eq!(task.language, "python3");
        assert!(task.download_url.is_none());
        assert!(task.file_name.is_none());
    }

    #[test]
    fn test_judge_task_deserialize_with_all_fields() {
        let json = json!({
            "submission_id": "sid-456",
            "problem_id": "2001",
            "runtime_config": {
                "evaluator": {"image": "noj-evaluator-python", "command": "python3 /workspace/evaluate.py", "time_limit_ms": 5000, "memory_limit_mb": 512},
                "solution": {"image": "noj-solution-python", "call_timeout_ms": 2000, "memory_limit_mb": 512}
            },
            "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA",
            "language": "python3",
            "code": "print('hello')",
            "file_name": "solution.py",
        });
        let task: JudgeTask = serde_json::from_value(json).unwrap();
        assert_eq!(task.submission_id, "sid-456");
        assert_eq!(
            task.download_url.as_deref(),
            Some("noj-download://base64/?content=UEsDBBQAAAAIA")
        );
        assert_eq!(task.file_name.as_deref(), Some("solution.py"));
    }

    #[test]
    fn test_judge_task_deserialize_empty_base64() {
        let json = json!({
            "submission_id": "sid-789",
            "problem_id": "1001",
            "runtime_config": {
                "evaluator": {"image": "noj-evaluator-python", "command": "python3 /workspace/evaluate.py", "time_limit_ms": 5000, "memory_limit_mb": 512},
                "solution": {"image": "noj-solution-python", "call_timeout_ms": 2000, "memory_limit_mb": 512}
            },
            "download_url": "",
            "language": "python3",
            "code": "",
        });
        let task: JudgeTask = serde_json::from_value(json).unwrap();
        assert_eq!(task.download_url, Some(String::new()));
    }

    // ── JudgeResult 序列化 ──

    #[test]
    fn test_judge_result_serialize_full() {
        let result = JudgeResult {
            submission_id: "sid-123".to_string(),
            status: "finished".to_string(),
            score: 1000,
            output: "---RESULT---\n{}".to_string(),
            details: json!({"score_content": 8.0}),
            time_ms: Some(2340),
            memory_kb: Some(18432),
            rejudge_seq: Some(1),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["submission_id"], "sid-123");
        assert_eq!(json["status"], "finished");
        assert_eq!(json["score"], 1000);
        assert_eq!(json["time_ms"], 2340);
        assert_eq!(json["memory_kb"], 18432);
        assert_eq!(json["details"]["score_content"], 8.0);
        assert_eq!(json["rejudge_seq"], 1);
    }

    #[test]
    fn test_judge_result_serialize_skip_optionals() {
        let result = JudgeResult {
            submission_id: "sid-456".to_string(),
            status: "finished".to_string(),
            score: 500,
            output: "".to_string(),
            details: json!({}),
            time_ms: None,
            memory_kb: None,
            rejudge_seq: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["score"], 500);
        assert!(json.get("time_ms").is_none());
        assert!(json.get("memory_kb").is_none());
        assert_eq!(json["output"], "");
    }

    // ── JudgeResult 工厂函数 ──

    #[test]
    fn test_judge_result_error() {
        let r = JudgeResult::error("sid-err", Some(9));
        assert_eq!(r.submission_id, "sid-err");
        assert_eq!(r.status, "error");
        assert_eq!(r.score, 0);
        assert_eq!(r.details, json!({}));
        assert_eq!(r.rejudge_seq, Some(9));
    }

    #[test]
    fn test_judge_result_timeout() {
        let r = JudgeResult::timeout("sid-tle", "timeout output", Some(3));
        assert_eq!(r.status, "error");
        assert_eq!(r.score, 0);
        assert_eq!(r.output, "timeout output");
        assert_eq!(r.rejudge_seq, Some(3));
    }

    #[test]
    fn test_judge_result_system_error() {
        let r = JudgeResult::system_error("sid-se", "评测脚本未输出结果标记", Some(6));
        assert_eq!(r.status, "error");
        assert_eq!(r.score, 0);
        assert_eq!(r.output, "评测脚本未输出结果标记");
        assert_eq!(r.rejudge_seq, Some(6));
    }

    // ── CaseResult ──

    #[test]
    fn test_case_result_round_trip() {
        let case = CaseResult {
            case_id: "case-001".to_string(),
            status: "Accepted".to_string(),
            time_ms: Some(42),
            memory_kb: Some(8192),
            input: Some("test input".to_string()),
            expected_output: Some("expected".to_string()),
            actual_output: Some("actual".to_string()),
        };
        let json = serde_json::to_value(&case).unwrap();
        let deserialized: CaseResult = serde_json::from_value(json).unwrap();
        assert_eq!(deserialized.case_id, "case-001");
        assert_eq!(deserialized.status, "Accepted");
        assert_eq!(deserialized.time_ms, Some(42));
        assert_eq!(deserialized.input, Some("test input".to_string()));
    }

    #[test]
    fn test_case_result_all_optional_none() {
        let case = CaseResult {
            case_id: "case-002".to_string(),
            status: "WrongAnswer".to_string(),
            time_ms: None,
            memory_kb: None,
            input: None,
            expected_output: None,
            actual_output: None,
        };
        let json = serde_json::to_value(&case).unwrap();
        // 可选字段应被跳过
        assert!(json.get("time_ms").is_none());
        assert!(json.get("input").is_none());
        assert!(json.get("expected_output").is_none());
        assert_eq!(json["case_id"], "case-002");
        assert_eq!(json["status"], "WrongAnswer");
    }
}
