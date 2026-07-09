/// Redis RPC 客户端，用于 core↔judge 双向通信。
///
/// # 协议
///
/// 基于 Redis List 实现轻量请求/响应模式：
///
/// 命名空间：
///   noj:rpc:v1:judge:core          ← List: judge → core 请求
///   noj:rpc:v1:judge:{id}:response  ← List: core → 指定 judge 的回复
///
/// 消息格式 (JSON)：
///   请求: { "id": "<uuid>", "method": "<name>", "params": {...}, "timestamp": <int> }
///   响应: { "id": "<uuid>", "result": {...}, "error": null, "timestamp": <int> }
use std::time::Duration;

use anyhow::{Context, Result};
use redis::AsyncCommands;
use serde_json::Value;
use tracing::{info, warn};

/// Redis RPC 客户端。
pub struct RpcClient {
    /// Redis connection（共享 main.rs 中已有连接）
    conn: redis::aio::MultiplexedConnection,
    /// 当前 judge 实例标识
    judge_id: String,
}

impl RpcClient {
    /// 创建 RPC 客户端。
    ///
    /// `judge_id` 用于响应队列：`noj:rpc:v1:judge:{judge_id}:response`
    pub fn new(conn: redis::aio::MultiplexedConnection, judge_id: String) -> Self {
        Self { conn, judge_id }
    }

    /// 获取 judge_id 的引用。
    #[allow(dead_code)]
    pub fn judge_id(&self) -> &str {
        &self.judge_id
    }

    /// 发送 RPC 请求并等待响应。
    ///
    /// 将请求消息 LPUSH 到 `noj:rpc:v1:judge:core`，
    /// 然后 BRPOP 等待响应，超时后返回 Err。
    pub async fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout_secs: u64,
    ) -> Result<Value> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let request = serde_json::json!({
            "id": request_id.clone(),
            "method": method,
            "params": params,
            "timestamp": timestamp,
            "judge_id": self.judge_id.clone(),
        });

        let request_queue = "noj:rpc:v1:judge:core".to_string();
        let response_queue = format!("noj:rpc:v1:judge:{}:response", self.judge_id);

        // 发送请求
        let request_json = serde_json::to_string(&request).context("序列化 RPC 请求失败")?;

        self.conn
            .lpush::<&str, String, usize>(&request_queue, request_json)
            .await
            .context("LPUSH RPC 请求失败")?;

        info!(
            rpc = "request",
            method = method,
            request_id = %request_id,
            "已发送 RPC 请求"
        );

        // 等待响应（带超时）
        let deadline = Duration::from_secs(timeout_secs);
        let result = tokio::time::timeout(deadline, async {
            loop {
                let resp: Option<(String, String)> = self
                    .conn
                    .brpop(&response_queue, timeout_secs as f64)
                    .await
                    .context("BRPOP RPC 响应失败")?;

                match resp {
                    Some((_key, value)) => {
                        if let Ok(parsed) = serde_json::from_str::<Value>(&value) {
                            if parsed.get("id").and_then(|v| v.as_str()) == Some(&request_id) {
                                return Ok::<_, anyhow::Error>(parsed);
                            }
                            warn!(
                                rpc = "response_mismatch",
                                expected = %request_id,
                                got = %parsed.get("id").and_then(|v| v.as_str()).unwrap_or("unknown"),
                                "收到不匹配的 RPC 响应，丢弃"
                            );
                        }
                    }
                    None => {
                        anyhow::bail!("BRPOP 超时");
                    }
                }

                // sleep briefly before retrying BRPOP
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await;

        match result {
            Ok(Ok(response)) => {
                if let Some(error_msg) = response.get("error").and_then(|v| v.as_str()) {
                    anyhow::bail!("RPC 错误 (method={}): {}", method, error_msg);
                }
                if let Some(result_val) = response.get("result") {
                    info!(
                        rpc = "response",
                        method = method,
                        request_id = %request_id,
                        "收到 RPC 响应"
                    );
                    Ok(result_val.clone())
                } else {
                    anyhow::bail!("RPC 响应缺少 result 字段 (method={})", method);
                }
            }
            Ok(Err(e)) => Err(e),
            Err(_elapsed) => {
                anyhow::bail!(
                    "RPC 请求超时 (method={}, timeout={}s)",
                    method,
                    timeout_secs
                );
            }
        }
    }

    /// 获取镜像白名单（dual-container-judge §5）。
    ///
    /// 调用 core 的 `get_image_allowlist` 方法，返回结构升级后含 `kind` 字段：
    /// `{"images": [{"image": "noj-judge-python", "kind": "evaluator", "mode": "exact"}, ...]}`
    ///
    /// 返回分类后的镜像列表（evaluator / solution），便于 judge 启动时按 kind
    /// 分别预热容器池。
    pub async fn get_image_allowlist(
        &mut self,
    ) -> Result<ImageAllowlist> {
        let result = self.request("get_image_allowlist", None, 5).await?;

        let arr = result
            .get("images")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut evaluator = Vec::new();
        let mut solution = Vec::new();

        for entry in &arr {
            // 新格式：对象含 image / kind / mode
            if let Some(image) = entry.get("image").and_then(|v| v.as_str()) {
                let kind = entry
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("evaluator");
                match kind {
                    "solution" => solution.push(image.to_string()),
                    _ => evaluator.push(image.to_string()),
                }
            } else if let Some(s) = entry.as_str() {
                // 旧格式兜底：纯字符串视为 evaluator
                evaluator.push(s.to_string());
            }
        }

        Ok(ImageAllowlist { evaluator, solution })
    }
}

/// core `get_image_allowlist` 响应的分类结构。
#[derive(Debug, Clone, Default)]
pub struct ImageAllowlist {
    /// kind='evaluator' 的镜像列表（进入容器池预热）
    pub evaluator: Vec<String>,
    /// kind='solution' 的镜像列表（不入池，仅记录）
    pub solution: Vec<String>,
}
