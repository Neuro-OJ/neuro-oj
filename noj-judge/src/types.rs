use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 评测状态枚举。
///
/// 注意：evaluate.py 输出的 status 是自由字符串，
/// `JudgeStatus` 仅覆盖 judge 侧可自行判定的系统级状态。
/// 其他状态（如 Accepted / WrongAnswer）由 evaluate.py 输出透传。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum JudgeStatus {
    /// 评测通过
    Accepted,
    /// 结果错误
    WrongAnswer,
    /// 超出时间限制
    TimeLimitExceeded,
    /// 超出内存限制
    MemoryLimitExceeded,
    /// 运行时错误（非零退出码）
    RuntimeError,
    /// 系统错误（评测环境异常）
    SystemError,
}

impl JudgeStatus {
    /// 返回状态的字符串表示，用于序列化和日志记录。
    pub fn as_str(&self) -> &'static str {
        match self {
            JudgeStatus::Accepted => "Accepted",
            JudgeStatus::WrongAnswer => "WrongAnswer",
            JudgeStatus::TimeLimitExceeded => "TimeLimitExceeded",
            JudgeStatus::MemoryLimitExceeded => "MemoryLimitExceeded",
            JudgeStatus::RuntimeError => "RuntimeError",
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluatorRuntime {
    pub image: String,
    pub command: String,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolutionRuntime {
    pub image: String,
    /// Solution 容器内入口文件名（例如 `solution.py`）。
    pub entry: String,
    /// 单次 SDK 调用的时间上限（毫秒）。
    pub call_timeout_ms: u64,
    pub memory_limit_mb: u64,
}

/// 评测任务——从 noj-core 发送到 noj-judge 的消息。
///
/// 字段对齐 noj-core/src/types/index.ts 的 JudgeTask 接口。
/// 所有评测统一使用双容器模式（Evaluator + Solution），由 `runtime_config` 提供配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JudgeTask {
    /// 提交 UUID
    pub submission_id: String,
    /// 题目 UUID
    #[allow(dead_code)]
    pub problem_id: String,
    /// 支持包下载 URL（`noj-download://` 格式）
    pub download_url: Option<String>,
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
}

/// 评测结果——从 noj-judge 返回到 noj-core 的消息。
///
/// 字段对齐 noj-core/src/types/index.ts 的 JudgeResult 接口。
#[derive(Debug, Clone, Serialize)]
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
    /// `message` 是内部错误详情，仅记录到日志；`output` 是返回给用户的友好信息。
    pub fn error(submission_id: &str, _message: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: JudgeStatus::SystemError.as_str().to_string(),
            score: 0,
            // 对用户隐藏内部错误细节，避免信息泄露
            output: format!("系统内部错误 (submission: {})", submission_id),
            details: Self::empty_details(),
            time_ms: None,
            memory_kb: None,
            rejudge_seq,
        }
    }

    /// 构造一个超时结果。
    pub fn timeout(submission_id: &str, output: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: JudgeStatus::TimeLimitExceeded.as_str().to_string(),
            score: 0,
            output: output.to_string(),
            details: Self::empty_details(),
            time_ms: None,
            memory_kb: None,
            rejudge_seq,
        }
    }

    /// 构造一个内存溢出结果。
    pub fn memory_exceeded(submission_id: &str, output: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: JudgeStatus::MemoryLimitExceeded.as_str().to_string(),
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
            status: JudgeStatus::SystemError.as_str().to_string(),
            score: 0,
            output: output.to_string(),
            details: Self::empty_details(),
            time_ms: None,
            memory_kb: None,
            rejudge_seq,
        }
    }

    /// 构造一个运行时错误结果。
    pub fn runtime_error(submission_id: &str, output: &str, rejudge_seq: Option<i64>) -> Self {
        Self {
            submission_id: submission_id.to_string(),
            status: JudgeStatus::RuntimeError.as_str().to_string(),
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
        assert_eq!(JudgeStatus::Accepted.as_str(), "Accepted");
        assert_eq!(JudgeStatus::WrongAnswer.as_str(), "WrongAnswer");
        assert_eq!(JudgeStatus::TimeLimitExceeded.as_str(), "TimeLimitExceeded");
        assert_eq!(
            JudgeStatus::MemoryLimitExceeded.as_str(),
            "MemoryLimitExceeded"
        );
        assert_eq!(JudgeStatus::RuntimeError.as_str(), "RuntimeError");
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
                "solution": {"image": "noj-solution-python", "entry": "submission_sample.py", "call_timeout_ms": 2000, "memory_limit_mb": 512}
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
                "solution": {"image": "noj-solution-python", "entry": "submission_sample.py", "call_timeout_ms": 2000, "memory_limit_mb": 512}
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
                "solution": {"image": "noj-solution-python", "entry": "submission_sample.py", "call_timeout_ms": 2000, "memory_limit_mb": 512}
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
            status: "Accepted".to_string(),
            score: 1000,
            output: "---RESULT---\n{}".to_string(),
            details: json!({"score_content": 8.0}),
            time_ms: Some(2340),
            memory_kb: Some(18432),
            rejudge_seq: Some(1),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["submission_id"], "sid-123");
        assert_eq!(json["status"], "Accepted");
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
            status: "WrongAnswer".to_string(),
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
        let r = JudgeResult::error("sid-err", "something went wrong", Some(9));
        assert_eq!(r.submission_id, "sid-err");
        assert_eq!(r.status, "SystemError");
        assert_eq!(r.score, 0);
        assert_eq!(r.details, json!({}));
        assert_eq!(r.rejudge_seq, Some(9));
    }

    #[test]
    fn test_judge_result_timeout() {
        let r = JudgeResult::timeout("sid-tle", "timeout output", Some(3));
        assert_eq!(r.status, "TimeLimitExceeded");
        assert_eq!(r.score, 0);
        assert_eq!(r.output, "timeout output");
        assert_eq!(r.rejudge_seq, Some(3));
    }

    #[test]
    fn test_judge_result_memory_exceeded() {
        let r = JudgeResult::memory_exceeded("sid-mle", "oom", Some(4));
        assert_eq!(r.status, "MemoryLimitExceeded");
        assert_eq!(r.rejudge_seq, Some(4));
    }

    #[test]
    fn test_judge_result_runtime_error() {
        let r = JudgeResult::runtime_error("sid-re", "traceback", Some(5));
        assert_eq!(r.status, "RuntimeError");
        assert_eq!(r.output, "traceback");
        assert_eq!(r.rejudge_seq, Some(5));
    }

    #[test]
    fn test_judge_result_system_error() {
        let r = JudgeResult::system_error("sid-se", "评测脚本未输出结果标记", Some(6));
        assert_eq!(r.status, "SystemError");
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
