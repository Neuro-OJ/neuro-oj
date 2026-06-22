//! Prometheus 格式的指标暴露端点。
//!
//! 提供 `/metrics` HTTP 端点，返回容器池的 Prometheus 文本格式指标。
//! 使用 axum 轻量级 HTTP 服务器。

use std::sync::Arc;

use axum::{routing::get, Router};
use tokio::net::TcpListener;
use tracing::{error, info};

use crate::pool::PoolManager;

/// 默认 metrics 监听端口。
const METRICS_PORT: u16 = 9100;

/// 启动 metrics HTTP 服务器。
///
/// 在 `0.0.0.0:{port}` 上监听 `/metrics` 端点。
pub async fn start_metrics_server(pool: Arc<PoolManager>, port: Option<u16>) {
    let port = port.unwrap_or(METRICS_PORT);
    let app = Router::new().route("/metrics", get(move || metrics_handler(pool.clone())));

    let addr = format!("0.0.0.0:{}", port);
    info!("Metrics HTTP 服务启动: http://{}/metrics", addr);

    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Metrics 服务绑定端口 {} 失败: {}", port, e);
            return;
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        error!("Metrics 服务运行失败: {}", e);
    }
}

/// 处理 `/metrics` 请求，返回 Prometheus 文本格式指标。
async fn metrics_handler(pool: Arc<PoolManager>) -> String {
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
