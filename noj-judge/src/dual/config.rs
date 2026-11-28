//! 双容器运行时配置：镜像/命令/网络白名单复验、资源上限收敛与命令解析。

use std::path::Path;

use anyhow::{Context, Result};
use bollard::query_parameters::StatsOptionsBuilder;
use futures_util::StreamExt;

use crate::sandbox::container::{
    extract_zip_entries_from_file, inject_zip_entries_to_container, parse_command, ZipEntry,
};
use crate::types::{PublicJudgeError, RuntimeConfig};

/// 校验镜像名最后一段是否匹配受信前缀。
pub(crate) fn image_allowed(image: &str, prefix: &str) -> bool {
    if image.is_empty() || image.contains("..") || image.contains('\0') {
        return false;
    }
    let basename = image.rsplit('/').next().unwrap_or(image);
    let name = basename.split(':').next().unwrap_or(basename);
    name.starts_with(prefix)
}

/// 白名单复验失败时回传给提交详情页的公开文案（不含镜像名/命令等动态内容）。
pub(crate) const MSG_IMAGE_NOT_ALLOWED: &str =
    "评测环境配置错误：题目的评测镜像不在评测机白名单内，请联系管理员检查题目运行时配置";
pub(crate) const MSG_COMMAND_NOT_ALLOWED: &str =
    "评测环境配置错误：题目的评测命令不在评测机白名单内，请联系管理员检查题目运行时配置";
pub(crate) const MSG_NETWORK_NOT_ALLOWED: &str =
    "评测环境配置错误：题目需要评测容器联网，但评测机未开启联网（JUDGE_ALLOW_EVALUATOR_NETWORK），请联系管理员";

/// NOJ-190：judge 侧对 MQ 消息中的镜像/命令/网络做白名单复验。
///
/// 失败时返回以 [`PublicJudgeError`] 为根的错误：`Display` 为详细原因（写日志），
/// 提交详情页只展示固定的公开文案。
pub(crate) fn validate_runtime_config(
    submission_id: &str,
    runtime_config: &RuntimeConfig,
    allow_evaluator_network: bool,
    image_prefix: &str,
    command_whitelist: &[String],
) -> Result<()> {
    if !image_allowed(&runtime_config.evaluator.image, image_prefix) {
        return Err(PublicJudgeError(MSG_IMAGE_NOT_ALLOWED).with_detail(format!(
            "submission {}: evaluator 镜像不在白名单前缀内: {}",
            submission_id, runtime_config.evaluator.image
        )));
    }
    // prediction 模式没有 Solution 容器，solution 缺省时跳过其镜像复验。
    if let Some(solution) = &runtime_config.solution {
        if !image_allowed(&solution.image, image_prefix) {
            return Err(PublicJudgeError(MSG_IMAGE_NOT_ALLOWED).with_detail(format!(
                "submission {}: solution 镜像不在白名单前缀内: {}",
                submission_id, solution.image
            )));
        }
    }

    let argv = parse_command(&runtime_config.evaluator.command);
    if argv.is_empty() {
        return Err(PublicJudgeError(MSG_COMMAND_NOT_ALLOWED)
            .with_detail(format!("submission {}: evaluator 命令为空", submission_id)));
    }
    let executable = &argv[0];
    if !command_whitelist.iter().any(|w| w == executable) {
        return Err(
            PublicJudgeError(MSG_COMMAND_NOT_ALLOWED).with_detail(format!(
                "submission {}: evaluator 可执行文件不在白名单内: {}",
                submission_id, executable
            )),
        );
    }

    let network_enabled = runtime_config
        .evaluator
        .network
        .as_ref()
        .map(|n| n.enabled)
        .unwrap_or(false);
    if network_enabled && !allow_evaluator_network {
        return Err(PublicJudgeError(MSG_NETWORK_NOT_ALLOWED).with_detail(format!(
            "submission {}: 消息请求开启 evaluator 网络，但 judge 未允许（JUDGE_ALLOW_EVALUATOR_NETWORK=false）",
            submission_id
        )));
    }
    Ok(())
}

/// 对任务中的资源限制字段执行硬上限收敛，防止 core 配置缺失或消息被篡改。
pub(crate) fn clamp_runtime_config(
    rc: &RuntimeConfig,
    max_evaluator_time_ms: u64,
    max_solution_call_timeout_ms: u64,
) -> RuntimeConfig {
    let mut clamped = rc.clone();
    if max_evaluator_time_ms > 0 {
        clamped.evaluator.time_limit_ms =
            clamped.evaluator.time_limit_ms.min(max_evaluator_time_ms);
    }
    // 内存硬上限与容器创建逻辑保持一致（0 由容器层规范化为 512MB，上限 4096MB）。
    clamped.evaluator.memory_limit_mb = clamped.evaluator.memory_limit_mb.min(4096);
    if let Some(solution) = clamped.solution.as_mut() {
        if max_solution_call_timeout_ms > 0 {
            solution.call_timeout_ms = solution.call_timeout_ms.min(max_solution_call_timeout_ms);
        }
        solution.memory_limit_mb = solution.memory_limit_mb.min(4096);
    }
    clamped
}

/// 取不小于 `idx` 的最小字符边界。
///
/// 保证 `&s[n..]` 不会 panic（`String` 的字节切片要求下标落在 UTF-8 字符边界上），
/// 且 `s.len() - n <= s.len() - idx` —— 即"丢弃的字节数不少于预期"，
/// 从而让 `MAX_OUTPUT_BYTES` 成为真正的硬上限。
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    let mut i = idx;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// 追加到累积缓冲：超过上限时丢弃头部、只保留尾部（诊断信息优先）。
///
/// 修复记录（2026-09-12 架构评审 §2.2）：原实现为
/// `*buf = buf[start..].to_string()`，`start` 由字节长度相减得到，可能落在多字节
/// 字符（**中文评测输出是常态**）内部 → `byte index N is not a char boundary` panic。
/// panic 发生在 `tokio::spawn` 的任务内，`JoinHandle` 的 Err 只被 `error!` 记录
/// （main.rs），于是结果永不推送、任务永不 ACK，提交永久停在 judging；
/// core sweeper 重投后再次 panic，形成无限循环。
///
/// 现在截断点一律对齐到字符边界，且总长度硬性不超过 `MAX_OUTPUT_BYTES`。
pub(crate) fn append_capped(buf: &mut String, s: &str) {
    if s.len() >= super::MAX_OUTPUT_BYTES {
        // 单次追加本身就超限（极端恶意输出）：只保留 s 的尾部。
        let start = ceil_char_boundary(s, s.len() - super::MAX_OUTPUT_BYTES);
        buf.clear();
        buf.push_str(&s[start..]);
        return;
    }
    if buf.len() + s.len() <= super::MAX_OUTPUT_BYTES {
        buf.push_str(s);
        return;
    }
    let keep = super::MAX_OUTPUT_BYTES - s.len();
    let start = ceil_char_boundary(buf, buf.len().saturating_sub(keep));
    buf.replace_range(..start, "");
    buf.push_str(s);
}

/// 注入支持包（zip）到 Evaluator 容器的 /workspace 目录。
///
/// VULN-17：先同步提取 zip 中所有文件到内存，再用**一次**批量注入
/// （单个 tar 流 + 单次 `docker exec`）解包，消除 N 次串行 exec。
pub(crate) async fn inject_support_package_to_evaluator(
    docker: &bollard::Docker,
    container_id: &str,
    zip_path: &Path,
) -> Result<()> {
    // 直接以磁盘文件作为 zip 读取源，避免先把整个 zip 读进内存再 to_vec 拷贝。
    // ZipFile 不是 Send，因此仍在 spawn_blocking 中做同步解压，但输入是文件流。
    let entries = tokio::task::spawn_blocking({
        let path = zip_path.to_path_buf();
        move || extract_zip_entries_from_file(&path)
    })
    .await
    .context("spawn_blocking 提取 zip 失败")??;

    // 目录条目由 tar 解压自动创建，无需注入；文件**按值消费**注入
    // （NOJ-A1：边写边释放条目数据，峰值内存不再随"条目 + tar"翻倍）。
    let entry_count = entries.len();
    let files: Vec<ZipEntry> = entries.into_iter().filter(|entry| !entry.is_dir).collect();
    let file_count = files.len();

    inject_zip_entries_to_container(docker, container_id, files)
        .await
        .context("批量注入支持包文件失败")?;

    tracing::info!(
        "支持包注入完成 (共 {} 个条目，其中 {} 个文件，单次 exec)",
        entry_count,
        file_count
    );
    Ok(())
}

/// 双容器路径必须携带 Solution 运行时；缺失时返回明确的守卫错误（纯函数，便于单测）。
pub(crate) fn require_solution<'a>(
    submission_id: &str,
    runtime_config: &'a RuntimeConfig,
) -> Result<&'a crate::types::SolutionRuntime> {
    runtime_config.solution.as_ref().ok_or_else(|| {
        anyhow::anyhow!("submission {}: 双容器路径缺少 solution 配置", submission_id)
    })
}

/// 从容器读取一次内存峰值（KB）。
///
/// Docker `stats` 的 `memory_stats.max_usage` 仅 cgroups v1 可用；
/// cgroups v2 下该字段缺失，回退到 `usage` 近似值。读取失败或容器已销毁时
/// 返回 `None`（不阻断评测主流程）。
pub(crate) async fn read_container_memory_peak_kb(
    docker: &bollard::Docker,
    container_id: &str,
) -> Option<u64> {
    let options = StatsOptionsBuilder::default()
        .stream(false)
        .one_shot(true)
        .build();
    let mut stream = docker.stats(container_id, Some(options));

    let stat = match tokio::time::timeout(std::time::Duration::from_secs(3), stream.next()).await {
        Ok(Some(Ok(stat))) => stat,
        _ => return None,
    };

    let memory = stat.memory_stats?;
    // max_usage 单位字节；cgroups v2 无 max_usage 时退回 usage。
    let peak_bytes = memory.max_usage.or(memory.usage)?;
    Some(peak_bytes / 1024)
}
