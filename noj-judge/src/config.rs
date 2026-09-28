use std::path::Path;

use sha2::{Digest, Sha256};
use tracing::warn;

/// noj-judge 运行时配置。
///
/// 所有配置项均从环境变量读取，提供合理的默认值。
#[derive(Clone)]
pub struct Config {
    /// Redis 连接 URL
    pub redis_url: String,
    /// 评测任务队列名前缀（实际队列为 `{prefix}:high/:medium/:low`）
    pub judge_queue: String,
    /// 评测结果列表名
    pub result_queue: String,
    /// 优先级轮询时每个队列 BRPOPLPUSH 的超时秒数
    pub priority_poll_timeout_secs: f64,
    /// 临时工作目录
    pub work_dir: String,
    /// 支持包 HTTP 下载超时秒数（默认: 60）
    pub support_package_download_timeout_secs: u64,
    /// 支持包缓存目录（默认: /tmp/noj-judge/support-cache）
    pub support_cache_dir: String,
    /// 支持包缓存最大文件数（默认: 500）
    pub support_cache_max_items: usize,
    /// 支持包缓存最大磁盘占用 MB（默认: 2048）
    pub support_cache_max_mb: u64,
    /// 实例标识（`noj-{hash12}`，确定性派生，用于启动时清理本实例孤儿容器）
    pub instance_id: String,
    /// 实例标识的来源（排障用：env / file / derived）
    pub instance_id_source: InstanceIdSource,
    /// 受信评测镜像名前缀（镜像最后一段必须以此开头）
    pub image_prefix: String,
    /// 受信评测命令可执行文件白名单（逗号分隔）
    pub command_whitelist: Vec<String>,
    /// 是否允许消息开启 evaluator 网络（默认拒绝；E2E 可显式开启）
    pub allow_evaluator_network: bool,
    /// evaluator 开启联网时使用的 Docker 网络模式（默认 "noj-eval-net"；
    /// 生产环境禁止 "bridge"/"host"，见 [`Config::validate`]）
    pub evaluator_network_mode: String,
    /// 是否允许通过 HTTP 下载 S3 支持包（默认拒绝；自建 MinIO 内网 HTTP 场景可开启）
    pub allow_http_s3: bool,
    /// 同时执行的评测任务数（默认: 2）
    pub max_concurrent_judges: usize,
    /// 每个评测容器的 CPU 上限（单位：millicores，默认: 1000 = 1 核）
    pub cpu_limit_millicores: u64,
    /// Evaluator 单次评测时间硬上限（毫秒，默认: 300000）
    pub max_evaluator_time_ms: u64,
    /// Solution 单次调用超时硬上限（毫秒，默认: 60000）
    pub max_solution_call_timeout_ms: u64,
    /// Docker daemon Unix endpoint（默认: unix:///var/run/docker.sock）
    pub docker_host: String,
    /// 是否拒绝连接默认宿主 Docker socket（生产环境应开启）
    pub require_isolated_docker: bool,
    /// 每用户评测占用 claim 的 Redis key 前缀（默认与队列前缀一致）
    ///
    /// 跨 worker 公平调度用：所有 worker 共享同一前缀下的占用状态，
    /// 因此部署多 worker 时「同一用户同时最多 1 个评测」仍然成立。
    pub user_claim_prefix: String,
    /// 每用户 claim 的过期阈值（毫秒，默认: 3600000 = 1 小时）
    ///
    /// **必须大于单次评测的最长可能耗时**，否则长评测会被误判为过期而破坏互斥。
    /// 默认 1h 远大于 evaluator 硬上限（默认 300s）。worker 崩溃留下的 claim
    /// 会在超过该阈值后被其他 worker 自动清理。
    pub user_claim_ttl_ms: i64,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("redis_url", &"<redacted>")
            .field("judge_queue", &self.judge_queue)
            .field("result_queue", &self.result_queue)
            .field(
                "priority_poll_timeout_secs",
                &self.priority_poll_timeout_secs,
            )
            .field("work_dir", &self.work_dir)
            .field(
                "support_package_download_timeout_secs",
                &self.support_package_download_timeout_secs,
            )
            .field("support_cache_dir", &self.support_cache_dir)
            .field("support_cache_max_items", &self.support_cache_max_items)
            .field("support_cache_max_mb", &self.support_cache_max_mb)
            .field("instance_id", &self.instance_id)
            .field("instance_id_source", &self.instance_id_source)
            .field("image_prefix", &self.image_prefix)
            .field("command_whitelist", &self.command_whitelist)
            .field("allow_evaluator_network", &self.allow_evaluator_network)
            .field("evaluator_network_mode", &self.evaluator_network_mode)
            .field("allow_http_s3", &self.allow_http_s3)
            .field("max_concurrent_judges", &self.max_concurrent_judges)
            .field("cpu_limit_millicores", &self.cpu_limit_millicores)
            .field("max_evaluator_time_ms", &self.max_evaluator_time_ms)
            .field(
                "max_solution_call_timeout_ms",
                &self.max_solution_call_timeout_ms,
            )
            .field("docker_host", &self.docker_host)
            .field("require_isolated_docker", &self.require_isolated_docker)
            .finish()
    }
}

/// 实例 ID 环境变量名（优先级最高）。
pub const INSTANCE_ID_ENV: &str = "JUDGE_INSTANCE_ID";

/// 实例 ID 持久化文件名（位于 `WORK_DIR` 下）。
pub const INSTANCE_ID_FILE: &str = ".instance_id";

/// 实例 ID 前缀（纯度约束：最终形态仅含 `[a-z0-9-]`）。
pub const INSTANCE_ID_PREFIX: &str = "noj-";

/// 短 hash 长度（十六进制字符数）。
pub const INSTANCE_ID_HASH_LEN: usize = 12;

/// 实例 ID 的来源，用于启动日志与排障。
///
/// VULN-15：实例标签若绑定易变 PID，Worker 崩溃重启后 PID 变化会导致启动清扫
/// 标签不匹配、孤儿容器永久残留。实例 ID 必须**确定性**，因此这里显式记录来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstanceIdSource {
    /// 环境变量 `JUDGE_INSTANCE_ID`（显式配置，最高优先级）
    Env,
    /// `WORK_DIR/.instance_id` 文件（复用上次解析结果）
    File,
    /// 由规范化 work dir + hostname + machine-id 派生，并已落盘
    Derived,
}

impl InstanceIdSource {
    /// 返回来源的短字符串（日志用）。
    pub fn as_str(self) -> &'static str {
        match self {
            InstanceIdSource::Env => "env",
            InstanceIdSource::File => "file",
            InstanceIdSource::Derived => "derived",
        }
    }
}

/// 计算实例 ID：`noj-` + SHA-256(seed) 前 12 位小写十六进制。
///
/// 输出纯度由构造方式保证：只包含 `[a-z0-9-]`，不含 `:`、`=`、空格等
/// 会污染 docker filter / Redis key 的字符。
pub fn instance_id_from_seed(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(INSTANCE_ID_HASH_LEN);
    // 12 位十六进制 = 6 字节，逐字节格式化后必然是小写十六进制。
    for byte in digest.iter().take(INSTANCE_ID_HASH_LEN / 2) {
        hex.push_str(&format!("{:02x}", byte));
    }
    format!("{}{}", INSTANCE_ID_PREFIX, hex)
}

/// 判断字符串是否已是最终形态的实例 ID（`noj-{12 位小写十六进制}`）。
pub fn is_canonical_instance_id(value: &str) -> bool {
    match value.strip_prefix(INSTANCE_ID_PREFIX) {
        Some(rest) => {
            rest.len() == INSTANCE_ID_HASH_LEN
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }
        None => false,
    }
}

/// 规范化 work dir：`canonicalize` 失败（目录尚不存在等）时回退原始路径字符串。
pub fn canonical_work_dir(work_dir: &str) -> String {
    std::fs::canonicalize(work_dir)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| work_dir.to_string())
}

/// 读取机器标识（`/etc/machine-id` → `/var/lib/dbus/machine-id` → `unknown`）。
fn machine_id() -> String {
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "unknown".to_string()
}

/// `<WORK_DIR>/.instance_id` 路径。
fn instance_id_file_path(work_dir: &str) -> std::path::PathBuf {
    Path::new(work_dir).join(INSTANCE_ID_FILE)
}

/// best-effort 落盘实例 ID（失败只告警：派生路径本身已确定性，不影响正确性）。
fn persist_instance_id(work_dir: &str, instance_id: &str) {
    let dir = Path::new(work_dir);
    if let Err(e) = std::fs::create_dir_all(dir) {
        warn!(
            work_dir = %dir.display(),
            error = %e,
            "创建 WORK_DIR 失败，实例 ID 无法持久化（本次仍按确定性派生值运行）"
        );
        return;
    }
    let path = instance_id_file_path(work_dir);
    if let Err(e) = std::fs::write(&path, format!("{}\n", instance_id)) {
        warn!(
            path = %path.display(),
            error = %e,
            "写入实例 ID 文件失败（本次仍按确定性派生值运行）"
        );
    }
}

/// 解析实例 ID（确定性级联回退，VULN-15）。
///
/// 优先级：
/// 1. 环境变量 `JUDGE_INSTANCE_ID` 非空 → 种子 `env:{id}`；
/// 2. `<WORK_DIR>/.instance_id` 文件存在且非空 → 已是最终形态则直接复用，
///    否则按同一 hash 规则收敛并把最终形态写回文件；
/// 3. `auto:{canonical_work_dir}:{hostname}:{machine_id}` 作为种子派生，
///    并写入 `<WORK_DIR>/.instance_id`，使后续重启 100% 确定。
///
/// 三个分支的返回值都满足 `noj-{12 位小写十六进制}`，且重启后稳定。
pub fn resolve_instance_id(work_dir: &str) -> (String, InstanceIdSource) {
    // 优先级 1：环境变量（显式配置，最高优先级）
    if let Ok(raw) = std::env::var(INSTANCE_ID_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let id = instance_id_from_seed(&format!("env:{}", trimmed));
            return (id, InstanceIdSource::Env);
        }
    }

    // 优先级 2：WORK_DIR/.instance_id
    if let Ok(content) = std::fs::read_to_string(instance_id_file_path(work_dir)) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            if is_canonical_instance_id(trimmed) {
                // 已是最终形态：直接复用，重启后 100% 确定。
                return (trimmed.to_string(), InstanceIdSource::File);
            }
            // 文件内容为任意种子（人工写入/旧格式）：按同一 hash 规则收敛，
            // 并把最终形态写回，保证后续重启稳定。
            let id = instance_id_from_seed(trimmed);
            persist_instance_id(work_dir, &id);
            return (id, InstanceIdSource::File);
        }
    }

    // 优先级 3：确定性派生 + 落盘
    let seed = format!(
        "auto:{}:{}:{}",
        canonical_work_dir(work_dir),
        hostname(),
        machine_id()
    );
    let id = instance_id_from_seed(&seed);
    persist_instance_id(work_dir, &id);
    (id, InstanceIdSource::Derived)
}

/// 未配置或配置无效时的评测并发上限。
pub const DEFAULT_MAX_CONCURRENT_JUDGES: usize = 2;

/// 未配置或配置无效时的评测容器 CPU 上限。
pub const DEFAULT_CPU_LIMIT_MILLICORES: u64 = 1000;

/// CPU 配置的最小值（100m = 0.1 核）。
pub const MIN_CPU_LIMIT_MILLICORES: u64 = 100;

/// CPU 配置的最大值（16 核），防止错误配置绕过资源边界。
pub const MAX_CPU_LIMIT_MILLICORES: u64 = 16_000;

/// Evaluator 单次评测时间硬上限（毫秒）。
pub const DEFAULT_MAX_EVALUATOR_TIME_MS: u64 = 300_000;

/// Solution 单次调用超时硬上限（毫秒）。
pub const DEFAULT_MAX_SOLUTION_CALL_TIMEOUT_MS: u64 = 60_000;

/// 每用户评测占用 claim 的默认过期阈值（毫秒）。
///
/// 取 1 小时：必须**远大于**单次评测的最长可能耗时（evaluator 硬上限默认 300s），
/// 否则长评测会被误判为过期而破坏互斥；同时又不至于让崩溃 worker 的残留 claim
/// 长时间阻塞该用户。
pub const DEFAULT_USER_CLAIM_TTL_MS: i64 = 3_600_000;

/// 防止错误配置创建过大的 semaphore 或占满调度资源。
const MAX_CONFIGURED_CONCURRENT_JUDGES: usize = 1024;

/// VULN-20：Evaluator 联网时使用的**专用** Docker 网络名默认值。
///
/// 原默认值 `bridge` 会让评测容器加入 Docker 默认桥接网络（可横向访问同宿主
/// 其他容器与宿主服务），因此改为专用自定义网络；生产校验禁止 `bridge`/`host`。
pub const DEFAULT_EVALUATOR_NETWORK: &str = "noj-eval-net";

/// VULN-20：禁止用于评测容器的 Docker 网络模式。
///
/// - `bridge`：Docker 默认桥接网络，可访问同宿主其他容器（含数据库等业务容器）；
/// - `host`：与宿主共享网络栈，评测代码可直接访问宿主全部服务。
const FORBIDDEN_EVALUATOR_NETWORK_MODES: [&str; 2] = ["bridge", "host"];

/// 校验 evaluator 联网网络模式（生产环境禁止 `bridge`/`host`）。
///
/// 合法值需满足 Docker 网络名规则 `[a-zA-Z0-9][a-zA-Z0-9_.-]*`，
/// 且不得是 `bridge` / `host`（`none` 允许，语义上等于不联网）。
pub fn validate_evaluator_network_mode(mode: &str) -> std::result::Result<(), String> {
    let trimmed = mode.trim();
    if trimmed.is_empty() {
        return Err(
            "JUDGE_EVALUATOR_NETWORK 不得为空（应指向专用评测网络，如 noj-eval-net）".to_string(),
        );
    }
    if trimmed != mode {
        return Err(format!(
            "JUDGE_EVALUATOR_NETWORK 不得包含首尾空白: {:?}",
            mode
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if FORBIDDEN_EVALUATOR_NETWORK_MODES.contains(&lower.as_str()) {
        return Err(format!(
            "生产环境禁止将 JUDGE_EVALUATOR_NETWORK 设为 {}（评测容器会获得对宿主/其他业务容器的网络访问）；\
             请改用专用网络 {}，由基础设施创建并只挂载评测容器",
            trimmed, DEFAULT_EVALUATOR_NETWORK
        ));
    }
    let mut chars = trimmed.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !first_ok || !rest_ok {
        return Err(format!(
            "JUDGE_EVALUATOR_NETWORK 不是合法的 Docker 网络名: {:?}",
            trimmed
        ));
    }
    Ok(())
}

impl Config {
    /// 从环境变量加载配置。
    ///
    /// 缺失的字段使用默认值，不会失败。
    pub fn from_env() -> Self {
        let judge_queue = env_or("JUDGE_QUEUE", "noj:judge:queue");
        // claim 前缀缺省由队列名派生：`noj:judge:queue` → `noj:judge`。
        // 这样同一部署下的所有 worker（共享 JUDGE_QUEUE）自动落到同一命名空间，
        // 无需额外约定；显式设置 JUDGE_USER_CLAIM_PREFIX 可覆盖。
        let claim_prefix = judge_queue
            .rsplit_once(':')
            .map(|(head, _)| head.to_string())
            .unwrap_or_else(|| judge_queue.clone());

        let work_dir = env_or("WORK_DIR", "/tmp/noj-judge");
        // VULN-15：实例 ID 走确定性级联回退（env → 文件 → 派生+落盘），
        // 不再使用 `{hostname}-{pid}`（PID 变化会使重启后的孤儿清扫完全失效）。
        let (instance_id, instance_id_source) = resolve_instance_id(&work_dir);

        Self {
            redis_url: env_or("REDIS_URL", "redis://127.0.0.1/"),
            judge_queue,
            result_queue: env_or("RESULT_QUEUE", "noj:judge:results"),
            priority_poll_timeout_secs: env_var_parse::<f64>("JUDGE_PRIORITY_POLL_TIMEOUT_MS")
                .map(|ms| ms / 1000.0)
                .unwrap_or(0.1),
            work_dir,
            support_package_download_timeout_secs: env_var_parse(
                "SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT",
            )
            .unwrap_or(60),
            support_cache_dir: env_or("SUPPORT_CACHE_DIR", "/tmp/noj-judge/support-cache"),
            support_cache_max_items: env_var_parse("SUPPORT_CACHE_MAX_ITEMS").unwrap_or(500),
            support_cache_max_mb: env_var_parse("SUPPORT_CACHE_MAX_MB").unwrap_or(2048),
            instance_id,
            instance_id_source,
            image_prefix: env_or("JUDGE_IMAGE_PREFIX", "noj-"),
            command_whitelist: env_or("JUDGE_COMMAND_WHITELIST", "python3,deno,node,bash,sh")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            allow_evaluator_network: env_var_parse::<bool>("JUDGE_ALLOW_EVALUATOR_NETWORK")
                .unwrap_or(false),
            evaluator_network_mode: env_or("JUDGE_EVALUATOR_NETWORK", DEFAULT_EVALUATOR_NETWORK),
            allow_http_s3: env_var_parse::<bool>("JUDGE_ALLOW_HTTP_S3").unwrap_or(false),
            max_concurrent_judges: env_var_parse::<usize>("JUDGE_MAX_CONCURRENT_JUDGES")
                .filter(|value| (1..=MAX_CONFIGURED_CONCURRENT_JUDGES).contains(value))
                .unwrap_or(DEFAULT_MAX_CONCURRENT_JUDGES),
            cpu_limit_millicores: env_var_parse::<u64>("JUDGE_CPU_LIMIT_MILLICORES")
                .filter(|value| {
                    (MIN_CPU_LIMIT_MILLICORES..=MAX_CPU_LIMIT_MILLICORES).contains(value)
                })
                .unwrap_or(DEFAULT_CPU_LIMIT_MILLICORES),
            max_evaluator_time_ms: env_var_parse::<u64>("JUDGE_MAX_EVALUATOR_TIME_MS")
                .unwrap_or(DEFAULT_MAX_EVALUATOR_TIME_MS),
            max_solution_call_timeout_ms: env_var_parse::<u64>(
                "JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS",
            )
            .unwrap_or(DEFAULT_MAX_SOLUTION_CALL_TIMEOUT_MS),
            docker_host: env_or("JUDGE_DOCKER_HOST", crate::docker::DEFAULT_DOCKER_HOST),
            require_isolated_docker: env_var_parse::<bool>("JUDGE_REQUIRE_ISOLATED_DOCKER")
                .unwrap_or(false),
            // 缺省与队列前缀一致：同一部署下所有 worker 自然共享同一 claim 命名空间。
            // `judge_queue` 形如 `noj:judge:queue`，取其父命名空间作为 claim 前缀。
            user_claim_prefix: env_or("JUDGE_USER_CLAIM_PREFIX", &claim_prefix),
            user_claim_ttl_ms: env_var_parse::<i64>("JUDGE_USER_CLAIM_TTL_MS")
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_USER_CLAIM_TTL_MS),
        }
    }

    /// 返回三个评测任务队列名（high / medium / low）。
    pub fn judge_queues(&self) -> [String; 3] {
        [
            format!("{}:high", self.judge_queue),
            format!("{}:medium", self.judge_queue),
            format!("{}:low", self.judge_queue),
        ]
    }

    /// 优雅关闭排空超时：至少 30s，且覆盖支持包下载超时 + 结果推送余量。
    pub fn drain_timeout_secs(&self) -> u64 {
        (30u64).max(
            self.support_package_download_timeout_secs
                .saturating_add(30),
        )
    }

    /// 启动期配置校验（生产环境安全护栏，main 启动路径必须调用）。
    ///
    /// VULN-20：禁止 evaluator 加入 `bridge`（默认桥接网络，可横向访问同宿主
    /// 业务容器）或 `host`（共享宿主网络栈）。
    pub fn validate(&self) -> anyhow::Result<()> {
        validate_evaluator_network_mode(&self.evaluator_network_mode)
            .map_err(|e| anyhow::anyhow!("配置校验失败：{}", e))?;
        Ok(())
    }
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "unknown".to_string())
}

/// 读取环境变量，不存在时返回默认值。
///
/// 若环境变量未设置，返回 `default` 的 to_string() 结果。
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 读取环境变量并解析为指定类型。
///
/// 若环境变量未设置或解析失败（如非数字字符串解析为整数），返回 None。
/// 支持的类型：`bool`、`u64`、`f64` 等实现 `FromStr` 的类型。
fn env_var_parse<T: std::str::FromStr>(key: &str) -> Option<T> {
    std::env::var(key).ok().and_then(|v| v.parse().ok())
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    static ENV_TEST_MUTEX: Mutex<()> = std::sync::Mutex::new(());

    struct EnvGuard {
        restored: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn set(kvs: Vec<(&str, &str)>) -> Self {
            let mut restored = Vec::new();
            for &(k, v) in &kvs {
                let key = k.to_string();
                let original = std::env::var(&key).ok();
                restored.push((key, original));
                std::env::set_var(k, v);
            }
            EnvGuard { restored }
        }

        /// 临时移除环境变量（用于验证缺省/回退路径）。
        fn remove(keys: &[&str]) -> Self {
            let mut restored = Vec::new();
            for &k in keys {
                let key = k.to_string();
                let original = std::env::var(&key).ok();
                restored.push((key, original));
                std::env::remove_var(k);
            }
            EnvGuard { restored }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, original) in &self.restored {
                match original {
                    Some(ref val) => std::env::set_var(key, val),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn test_config_defaults() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        for key in &[
            "REDIS_URL",
            "JUDGE_QUEUE",
            "RESULT_QUEUE",
            "WORK_DIR",
            "JUDGE_MAX_CONCURRENT_JUDGES",
            "JUDGE_CPU_LIMIT_MILLICORES",
            "JUDGE_DOCKER_HOST",
            "JUDGE_REQUIRE_ISOLATED_DOCKER",
            "JUDGE_PRIORITY_POLL_TIMEOUT_MS",
            // 实例 ID 必须由环境变量隔离，否则会读到宿主/其他测试的值
            "JUDGE_INSTANCE_ID",
            "JUDGE_EVALUATOR_NETWORK",
        ] {
            std::env::remove_var(key);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://127.0.0.1/");
        assert_eq!(cfg.judge_queue, "noj:judge:queue");
        assert_eq!(
            cfg.evaluator_network_mode, DEFAULT_EVALUATOR_NETWORK,
            "VULN-20：默认网络应为专用评测网络，而非 bridge"
        );
        assert!(cfg.validate().is_ok());
        assert_eq!(
            cfg.judge_queues(),
            [
                "noj:judge:queue:high".to_string(),
                "noj:judge:queue:medium".to_string(),
                "noj:judge:queue:low".to_string(),
            ]
        );
        assert!((cfg.priority_poll_timeout_secs - 0.1).abs() < f64::EPSILON);
        assert_eq!(cfg.work_dir, "/tmp/noj-judge");
        assert_eq!(cfg.max_concurrent_judges, DEFAULT_MAX_CONCURRENT_JUDGES);
        assert_eq!(cfg.cpu_limit_millicores, DEFAULT_CPU_LIMIT_MILLICORES);
        assert_eq!(cfg.docker_host, crate::docker::DEFAULT_DOCKER_HOST);
        assert!(!cfg.require_isolated_docker);
    }

    #[test]
    fn test_config_custom_values() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![
            ("REDIS_URL", "redis://custom:6379"),
            ("JUDGE_QUEUE", "custom:queue"),
            ("RESULT_QUEUE", "custom:results"),
            ("WORK_DIR", "/custom/path"),
            ("JUDGE_MAX_CONCURRENT_JUDGES", "3"),
            ("JUDGE_CPU_LIMIT_MILLICORES", "2500"),
            ("JUDGE_DOCKER_HOST", "unix:///run/noj-judge/docker.sock"),
            ("JUDGE_REQUIRE_ISOLATED_DOCKER", "true"),
            ("JUDGE_PRIORITY_POLL_TIMEOUT_MS", "250"),
        ]);
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://custom:6379");
        assert_eq!(cfg.judge_queue, "custom:queue");
        assert_eq!(
            cfg.judge_queues(),
            [
                "custom:queue:high".to_string(),
                "custom:queue:medium".to_string(),
                "custom:queue:low".to_string(),
            ]
        );
        assert!((cfg.priority_poll_timeout_secs - 0.25).abs() < f64::EPSILON);
        assert_eq!(cfg.result_queue, "custom:results");
        assert_eq!(cfg.work_dir, "/custom/path");
        assert_eq!(cfg.max_concurrent_judges, 3);
        assert_eq!(cfg.cpu_limit_millicores, 2500);
        assert_eq!(cfg.docker_host, "unix:///run/noj-judge/docker.sock");
        assert!(cfg.require_isolated_docker);
    }

    #[test]
    fn test_config_invalid_concurrency_falls_back_to_default() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        for value in ["0", "not-a-number", "999999999999999999999999999"] {
            let _guard = EnvGuard::set(vec![("JUDGE_MAX_CONCURRENT_JUDGES", value)]);
            let cfg = Config::from_env();
            assert_eq!(cfg.max_concurrent_judges, DEFAULT_MAX_CONCURRENT_JUDGES);
        }
    }

    #[test]
    fn test_config_invalid_cpu_limit_falls_back_to_default() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        for value in ["0", "99", "16001", "not-a-number"] {
            let _guard = EnvGuard::set(vec![("JUDGE_CPU_LIMIT_MILLICORES", value)]);
            let cfg = Config::from_env();
            assert_eq!(cfg.cpu_limit_millicores, DEFAULT_CPU_LIMIT_MILLICORES);
        }
    }

    // ── VULN-15：实例 ID 确定性 / 纯度 / 优先级 / 文件复用 ──

    /// 纯度：实例 ID 只含 `[a-z0-9-]`（否则 docker filter / Redis key 会被
    /// `:`、`=`、空格等字符切割出歧义）。
    fn assert_pure_instance_id(id: &str) {
        assert!(
            id.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "实例 ID 含非法字符: {:?}",
            id
        );
        assert!(
            id.starts_with(INSTANCE_ID_PREFIX),
            "实例 ID 前缀错误: {}",
            id
        );
        assert!(
            is_canonical_instance_id(id),
            "实例 ID 不是 noj-{{hash12}} 形态: {}",
            id
        );
    }

    #[test]
    fn test_instance_id_hash_is_sha256_prefix() {
        // 固定向量：SHA-256("hello") = 2cf24dba5fb0a30e... → 取前 6 字节 = 2cf24dba5fb0
        assert_eq!(instance_id_from_seed("hello"), "noj-2cf24dba5fb0");
        assert!(is_canonical_instance_id("noj-2cf24dba5fb0"));
        assert!(!is_canonical_instance_id("noj-2CF24DBA5FB0"), "必须小写");
        assert!(
            !is_canonical_instance_id("noj-2cf24dba5fb"),
            "长度必须为 12"
        );
        assert!(!is_canonical_instance_id("2cf24dba5fb0"));
    }

    #[test]
    fn test_instance_id_purity_for_hostile_env_value() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![(
            INSTANCE_ID_ENV,
            "host name:with=colon/and 空格/中文",
        )]);
        let (id, source) = resolve_instance_id("/tmp/noj-judge-instance-test");
        assert_eq!(source, InstanceIdSource::Env);
        assert_pure_instance_id(&id);
    }

    #[test]
    fn test_instance_id_is_deterministic_and_persisted() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::remove(&[INSTANCE_ID_ENV]);
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tmp.path().to_string_lossy().to_string();

        let (first, source) = resolve_instance_id(&work_dir);
        assert_eq!(source, InstanceIdSource::Derived, "首次解析应走派生路径");
        assert_pure_instance_id(&first);

        // 落盘内容即最终形态；再次解析（模拟重启后读取文件）必须完全一致。
        let persisted = std::fs::read_to_string(tmp.path().join(INSTANCE_ID_FILE)).unwrap();
        assert_eq!(persisted.trim(), first);

        let (second, source2) = resolve_instance_id(&work_dir);
        assert_eq!(source2, InstanceIdSource::File);
        assert_eq!(first, second, "同一 work_dir 重启后实例 ID 必须一致");
    }

    #[test]
    fn test_instance_id_reuses_seed_from_file() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::remove(&[INSTANCE_ID_ENV]);
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tmp.path().to_string_lossy().to_string();
        let file = tmp.path().join(INSTANCE_ID_FILE);

        // 文件里存任意种子 → 按同一 hash 规则收敛为 noj-{hash12}，并回写最终形态
        std::fs::write(&file, "人工写入的任意种子\n").unwrap();
        let (id, source) = resolve_instance_id(&work_dir);
        assert_eq!(source, InstanceIdSource::File);
        assert_eq!(id, instance_id_from_seed("人工写入的任意种子"));
        assert_pure_instance_id(&id);
        assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), id);

        // 回写后再解析：稳定复用，不再变化
        let (again, _) = resolve_instance_id(&work_dir);
        assert_eq!(again, id);
    }

    #[test]
    fn test_instance_id_reuses_canonical_file_content() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::remove(&[INSTANCE_ID_ENV]);
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join(INSTANCE_ID_FILE), "noj-0123456789ab\n").unwrap();

        let (id, source) = resolve_instance_id(&work_dir);
        assert_eq!(source, InstanceIdSource::File);
        assert_eq!(id, "noj-0123456789ab", "已是最终形态时必须原样复用");
    }

    #[test]
    fn test_instance_id_env_takes_priority_over_file() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tmp.path().to_string_lossy().to_string();
        let file = tmp.path().join(INSTANCE_ID_FILE);
        std::fs::write(&file, "noj-aaaaaaaaaaaa\n").unwrap();
        let _guard = EnvGuard::set(vec![(INSTANCE_ID_ENV, "worker-7")]);

        let (id, source) = resolve_instance_id(&work_dir);
        assert_eq!(source, InstanceIdSource::Env);
        assert_eq!(id, instance_id_from_seed("env:worker-7"));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap().trim(),
            "noj-aaaaaaaaaaaa",
            "环境变量优先时不应改写文件"
        );
    }

    #[test]
    fn test_instance_id_empty_env_falls_back_to_file() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let work_dir = tmp.path().to_string_lossy().to_string();
        std::fs::write(tmp.path().join(INSTANCE_ID_FILE), "noj-bbbbbbbbbbbb\n").unwrap();
        let _guard = EnvGuard::set(vec![(INSTANCE_ID_ENV, "   ")]);

        let (id, source) = resolve_instance_id(&work_dir);
        assert_eq!(source, InstanceIdSource::File);
        assert_eq!(id, "noj-bbbbbbbbbbbb");
    }

    #[test]
    fn test_canonical_work_dir_falls_back_for_missing_path() {
        let missing = "/tmp/noj-judge-definitely-missing-dir-xyz";
        assert_eq!(canonical_work_dir(missing), missing);
    }

    // ── VULN-20：网络模式校验 ──

    #[test]
    fn test_validate_evaluator_network_mode_rejects_bridge_and_host() {
        for mode in ["bridge", "host", "BRIDGE", "Host"] {
            let err = validate_evaluator_network_mode(mode).unwrap_err();
            assert!(
                err.contains("禁止"),
                "mode={} 应被拒绝，实际: {}",
                mode,
                err
            );
        }
    }

    #[test]
    fn test_validate_evaluator_network_mode_rejects_invalid_names() {
        for mode in ["", "  ", "noj eval", "noj:eval", "noj/eval", "-leading"] {
            assert!(
                validate_evaluator_network_mode(mode).is_err(),
                "mode={:?} 应被拒绝",
                mode
            );
        }
    }

    #[test]
    fn test_validate_evaluator_network_mode_accepts_dedicated_network() {
        for mode in [
            DEFAULT_EVALUATOR_NETWORK,
            "none",
            "noj-net",
            "noj_eval.net-1",
        ] {
            assert!(
                validate_evaluator_network_mode(mode).is_ok(),
                "mode={} 应被接受",
                mode
            );
        }
    }
}
