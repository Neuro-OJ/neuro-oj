/// noj-judge 运行时配置。
///
/// 所有配置项均从环境变量读取，提供合理的默认值。
#[derive(Debug, Clone)]
pub struct Config {
    /// Redis 连接 URL
    pub redis_url: String,
    /// 评测任务队列名
    pub judge_queue: String,
    /// 评测结果列表名
    pub result_queue: String,
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
    /// 实例标识（用于启动时清理本实例孤儿容器，默认 hostname-pid）
    pub instance_id: String,
    /// 受信评测镜像名前缀（镜像最后一段必须以此开头）
    pub image_prefix: String,
    /// 受信评测命令可执行文件白名单（逗号分隔）
    pub command_whitelist: Vec<String>,
    /// 是否允许消息开启 evaluator 网络（默认拒绝；E2E 可显式开启）
    pub allow_evaluator_network: bool,
    /// evaluator 开启联网时使用的 Docker 网络模式（默认 "bridge"；生产可设为 compose 网络名如 "noj-net"）
    pub evaluator_network_mode: String,
    /// 是否允许通过 HTTP 下载 S3 支持包（默认拒绝；自建 MinIO 内网 HTTP 场景可开启）
    pub allow_http_s3: bool,
    /// 同时执行的评测任务数（默认: 2）
    pub max_concurrent_judges: usize,
    /// 每个评测容器的 CPU 上限（单位：millicores，默认: 1000 = 1 核）
    pub cpu_limit_millicores: u64,
    /// Docker daemon Unix endpoint（默认: unix:///var/run/docker.sock）
    pub docker_host: String,
    /// 是否拒绝连接默认宿主 Docker socket（生产环境应开启）
    pub require_isolated_docker: bool,
}

/// 未配置或配置无效时的评测并发上限。
pub const DEFAULT_MAX_CONCURRENT_JUDGES: usize = 2;

/// 未配置或配置无效时的评测容器 CPU 上限。
pub const DEFAULT_CPU_LIMIT_MILLICORES: u64 = 1000;

/// CPU 配置的最小值（100m = 0.1 核）。
pub const MIN_CPU_LIMIT_MILLICORES: u64 = 100;

/// CPU 配置的最大值（16 核），防止错误配置绕过资源边界。
pub const MAX_CPU_LIMIT_MILLICORES: u64 = 16_000;

/// 防止错误配置创建过大的 semaphore 或占满调度资源。
const MAX_CONFIGURED_CONCURRENT_JUDGES: usize = 1024;

impl Config {
    /// 从环境变量加载配置。
    ///
    /// 缺失的字段使用默认值，不会失败。
    pub fn from_env() -> Self {
        Self {
            redis_url: env_or("REDIS_URL", "redis://127.0.0.1/"),
            judge_queue: env_or("JUDGE_QUEUE", "noj:judge:queue"),
            result_queue: env_or("RESULT_QUEUE", "noj:judge:results"),
            work_dir: env_or("WORK_DIR", "/tmp/noj-judge"),
            support_package_download_timeout_secs: env_var_parse(
                "SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT",
            )
            .unwrap_or(60),
            support_cache_dir: env_or("SUPPORT_CACHE_DIR", "/tmp/noj-judge/support-cache"),
            support_cache_max_items: env_var_parse("SUPPORT_CACHE_MAX_ITEMS").unwrap_or(500),
            support_cache_max_mb: env_var_parse("SUPPORT_CACHE_MAX_MB").unwrap_or(2048),
            instance_id: env_or(
                "JUDGE_INSTANCE_ID",
                &format!("{}-{}", hostname(), std::process::id()),
            ),
            image_prefix: env_or("JUDGE_IMAGE_PREFIX", "noj-"),
            command_whitelist: env_or("JUDGE_COMMAND_WHITELIST", "python3,deno,node,bash,sh")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            allow_evaluator_network: env_var_parse::<bool>("JUDGE_ALLOW_EVALUATOR_NETWORK")
                .unwrap_or(false),
            evaluator_network_mode: env_or("JUDGE_EVALUATOR_NETWORK", "bridge"),
            allow_http_s3: env_var_parse::<bool>("JUDGE_ALLOW_HTTP_S3").unwrap_or(false),
            max_concurrent_judges: env_var_parse::<usize>("JUDGE_MAX_CONCURRENT_JUDGES")
                .filter(|value| (1..=MAX_CONFIGURED_CONCURRENT_JUDGES).contains(value))
                .unwrap_or(DEFAULT_MAX_CONCURRENT_JUDGES),
            cpu_limit_millicores: env_var_parse::<u64>("JUDGE_CPU_LIMIT_MILLICORES")
                .filter(|value| {
                    (MIN_CPU_LIMIT_MILLICORES..=MAX_CPU_LIMIT_MILLICORES).contains(value)
                })
                .unwrap_or(DEFAULT_CPU_LIMIT_MILLICORES),
            docker_host: env_or("JUDGE_DOCKER_HOST", crate::docker::DEFAULT_DOCKER_HOST),
            require_isolated_docker: env_var_parse::<bool>("JUDGE_REQUIRE_ISOLATED_DOCKER")
                .unwrap_or(false),
        }
    }

    /// 优雅关闭排空超时：至少 30s，且覆盖支持包下载超时 + 结果推送余量。
    pub fn drain_timeout_secs(&self) -> u64 {
        (30u64).max(
            self.support_package_download_timeout_secs
                .saturating_add(30),
        )
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
        ] {
            std::env::remove_var(key);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://127.0.0.1/");
        assert_eq!(cfg.judge_queue, "noj:judge:queue");
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
        ]);
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://custom:6379");
        assert_eq!(cfg.judge_queue, "custom:queue");
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
}
