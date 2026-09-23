//! Evaluator 的 LLM 环境变量构造。
//!
//! 从 `dual/mod.rs` 拆出（单文件规模棘轮：巨型文件不得继续变大）。

use crate::types::JudgeTaskLlm;

/// 构造 Evaluator 的 LLM 环境变量（Solution 容器始终不注入）。
///
/// 除网关地址与 eval_token 外，一并注入提交标识与重测序号，
/// 让题目侧 evaluator 能据此做**确定性随机**（同一提交重测结果一致，
/// 不同提交抽到不同剧本）；缺失时题目侧退化为固定默认值。
pub fn build_llm_env(
    llm: &JudgeTaskLlm,
    submission_id: &str,
    rejudge_seq: Option<i64>,
) -> Vec<String> {
    vec![
        format!("NOJ_LLM_GATEWAY_URL={}", llm.gateway_url),
        format!("NOJ_LLM_TOKEN={}", llm.eval_token),
        format!("NOJ_LLM_PROVIDER_ID={}", llm.provider_id),
        format!("NOJ_LLM_ALLOWED_MODELS={}", llm.allowed_models.join(",")),
        format!("NOJ_SUBMISSION_ID={}", submission_id),
        format!("NOJ_REJUDGE_SEQ={}", rejudge_seq.unwrap_or(0)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_llm_env() {
        let llm = JudgeTaskLlm {
            gateway_url: "http://llm-gateway:8001".to_string(),
            eval_token: "token-abc".to_string(),
            provider_id: "prov-1".to_string(),
            allowed_models: vec!["qwen-plus".to_string(), "qwen-max".to_string()],
        };
        let env = build_llm_env(&llm, "sub-9", Some(7));
        assert!(env.contains(&"NOJ_LLM_GATEWAY_URL=http://llm-gateway:8001".to_string()));
        assert!(env.contains(&"NOJ_LLM_TOKEN=token-abc".to_string()));
        assert!(env.contains(&"NOJ_LLM_PROVIDER_ID=prov-1".to_string()));
        assert!(env.contains(&"NOJ_LLM_ALLOWED_MODELS=qwen-plus,qwen-max".to_string()));
        // 提交标识与重测序号一并注入，供题目侧做确定性随机（同提交重测一致）。
        assert!(env.contains(&"NOJ_SUBMISSION_ID=sub-9".to_string()));
        assert!(env.contains(&"NOJ_REJUDGE_SEQ=7".to_string()));
    }

    #[test]
    fn test_build_llm_env_without_rejudge_seq() {
        let llm = JudgeTaskLlm {
            gateway_url: "http://llm-gateway:8001".to_string(),
            eval_token: "token-abc".to_string(),
            provider_id: "prov-1".to_string(),
            allowed_models: vec![],
        };
        let env = build_llm_env(&llm, "sub-1", None);
        assert!(env.contains(&"NOJ_REJUDGE_SEQ=0".to_string()));
    }
}
