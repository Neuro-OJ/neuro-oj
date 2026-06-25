//! Prometheus 格式的指标暴露端点。
//!
//! 提供 `/metrics` HTTP 端点，返回容器池的 Prometheus 文本格式指标。
//! 使用 axum 轻量级 HTTP 服务器。
//!
//! ## 安全
//!
//! - 默认绑定 loopback（127.0.0.1），仅本机 Prometheus 抓取
//! - 可通过 `METRICS_BIND` 覆盖（注意：设为 0.0.0.0 将暴露内部状态）
//! - 可选 `METRICS_AUTH_TOKEN`：设置后 `/metrics` 需要 `Authorization: Bearer <token>`

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use tokio::net::TcpListener;
use tracing::{error, info};

use crate::pool::PoolManager;

/// 启动 metrics HTTP 服务器。
///
/// 绑定地址由 `bind` 指定（默认 127.0.0.1:9100）。
/// `auth_token` 设置后，`/metrics` 端点要求 `Authorization: Bearer <token>`。
#[allow(dead_code)]
pub async fn start_metrics_server(
    pool: Arc<PoolManager>,
    bind: Option<String>,
    auth_token: Option<String>,
) {
    let addr = bind.unwrap_or_else(|| "127.0.0.1:9100".to_string());
    info!("Metrics HTTP 服务启动: http://{}/metrics", addr);

    let app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(pool)
        .layer(middleware::from_fn_with_state(
            auth_token,
            require_bearer_auth,
        ));

    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Metrics 服务绑定端口 {} 失败: {}", addr, e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        error!("Metrics 服务运行失败: {}", e);
    }
}

/// Bearer token 鉴权中间件。
///
/// 若 token 配置为空（None 或空字符串），则放行所有请求。
/// 若 token 已配置，则要求 `Authorization: Bearer <token>`。
async fn require_bearer_auth(
    State(expected): State<Option<String>>,
    req: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Response {
    let expected = match expected {
        Some(t) if !t.is_empty() => t,
        _ => return next.run(req).await,
    };

    let auth_header = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(value) if value.starts_with("Bearer ") => {
            let token = &value[7..];
            if token == expected {
                next.run(req).await
            } else {
                (StatusCode::UNAUTHORIZED, "invalid token").into_response()
            }
        }
        _ => (StatusCode::UNAUTHORIZED, "missing bearer token").into_response(),
    }
}

/// 处理 `/metrics` 请求，返回 Prometheus 文本格式指标。
#[allow(dead_code)]
async fn metrics_handler(State(pool): State<Arc<PoolManager>>) -> String {
    let mut output = String::new();

    // ── Counter 指标 ──────────────────────────────────
    output.push_str("# HELP noj_judge_tasks_total 累积评测任务数\n");
    output.push_str("# TYPE noj_judge_tasks_total counter\n");
    output.push_str(&format!("noj_judge_tasks_total {}\n", pool.tasks_total()));

    output.push_str("# HELP noj_judge_errors_total 累积评测错误数\n");
    output.push_str("# TYPE noj_judge_errors_total counter\n");
    output.push_str(&format!("noj_judge_errors_total {}\n", pool.errors_total()));

    output.push_str("# HELP noj_judge_timeouts_total 累积超时数\n");
    output.push_str("# TYPE noj_judge_timeouts_total counter\n");
    output.push_str(&format!(
        "noj_judge_timeouts_total {}\n",
        pool.timeouts_total()
    ));

    output.push_str("# HELP noj_judge_pool_misses_total 累积池 miss 数\n");
    output.push_str("# TYPE noj_judge_pool_misses_total counter\n");
    output.push_str(&format!(
        "noj_judge_pool_misses_total {}\n",
        pool.pool_misses_total()
    ));

    // ── Gauge 指标 ────────────────────────────────────
    output.push_str("# HELP noj_pool_leaked_containers 最终泄漏的容器数\n");
    output.push_str("# TYPE noj_pool_leaked_containers gauge\n");
    let leaked = pool.leaked_containers().lock().await.len();
    output.push_str(&format!("noj_pool_leaked_containers {}\n", leaked));

    // 每个池的指标
    let pools = pool.all_pools().await;
    for p in &pools {
        let (idle, in_flight, total) = p.snapshot().await;
        let target = p.target_depth();
        let image = p.image();

        // 安全转义 label value
        let image_label = image.replace('\\', "\\\\").replace('"', "\\\"");

        output.push_str(&format!(
            "# HELP noj_pool_idle_containers 空闲容器数\n\
             # TYPE noj_pool_idle_containers gauge\n\
             noj_pool_idle_containers{{image=\"{}\"}} {}\n",
            image_label, idle
        ));
        output.push_str(&format!(
            "# HELP noj_pool_in_flight 使用中的容器数\n\
             # TYPE noj_pool_in_flight gauge\n\
             noj_pool_in_flight{{image=\"{}\"}} {}\n",
            image_label, in_flight
        ));
        output.push_str(&format!(
            "# HELP noj_pool_total_containers 总容器数\n\
             # TYPE noj_pool_total_containers gauge\n\
             noj_pool_total_containers{{image=\"{}\"}} {}\n",
            image_label, total
        ));
        output.push_str(&format!(
            "# HELP noj_pool_target_depth 目标池深度\n\
             # TYPE noj_pool_target_depth gauge\n\
             noj_pool_target_depth{{image=\"{}\"}} {}\n",
            image_label, target
        ));
    }

    output
}
