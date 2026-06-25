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
    /// 容器池配置
    pub pool: PoolConfig,
}

/// 容器池配置。
///
/// 当 `enabled=false` 时回退到旧 Semaphore 模型，
/// 使用 `MAX_CONCURRENT` 环境变量控制并发。
#[derive(Debug, Clone)]
pub struct PoolConfig {
    /// 是否启用容器池（默认: true）
    pub enabled: bool,
    /// 启动时每个镜像预创建的容器数（默认: 2）
    pub initial_size: usize,
    /// 池最大深度（默认: 16）
    pub max_size: usize,
    /// 池最小深度（默认: 1）
    pub min_size: usize,
    /// 容器内存硬上限 MB（默认: 256）
    pub memory_mb: u64,
    /// CPU 核数（0=无限制，默认: 0）
    pub cpu: f64,
    /// 需要预热的镜像列表（逗号分隔，默认: "noj-judge-python"）
    pub images: Vec<String>,
    /// Per-image 内存配置：image_name -> memory_mb
    pub per_image_memory: std::collections::HashMap<String, u64>,
    /// 空闲容器超时秒数（默认: 300）
    #[allow(dead_code)]
    pub idle_timeout_secs: u64,
    /// 扩缩容评估间隔秒数（默认: 60）
    #[allow(dead_code)]
    pub scale_interval_secs: u64,
    /// 支持包最大 MB（默认: 25）
    pub max_archive_mb: u64,
    /// 超时 kill 的 SIGTERM→SIGKILL 等待秒数（默认: 2）
    pub kill_grace_secs: u64,
    /// Docker 容器标签前缀（默认: "com.noj.judge"）
    pub label_prefix: String,
    /// Metrics HTTP 监听地址（默认 127.0.0.1:9100）
    ///
    /// 默认绑定 loopback 而非 0.0.0.0 以避免将内部容器池状态
    /// （任务总数、错误数、池深度、版本信息等）暴露给未授权网络。
    /// 外部 Prometheus 抓取时通过 sidecar 或 SSH 隧道。
    pub metrics_bind: String,
    /// Metrics 端点可选 bearer token
    ///
    /// 设置后，访问 /metrics 需在 Authorization 头携带 `Bearer <token>`。
    /// 未设置则仅依赖 IP 层保护（127.0.0.1 限制）。
    pub metrics_auth_token: Option<String>,
}

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
            pool: PoolConfig::from_env(),
        }
    }

    /// 获取并发上限（兼容旧 Semaphore 模型）。
    ///
    /// - 池启用时：返回 `pool.max_size`
    /// - 池禁用时：读取 `MAX_CONCURRENT` 环境变量（默认 2）
    pub fn max_concurrent(&self) -> usize {
        if self.pool.enabled {
            self.pool.max_size
        } else {
            env_var_parse("MAX_CONCURRENT").unwrap_or(2)
        }
    }
}

impl PoolConfig {
    fn from_env() -> Self {
        let enabled = env_var_parse::<bool>("POOL_ENABLED").unwrap_or(true);
        let raw_images = env_or("POOL_IMAGES", "noj-judge-python");
        let images: Vec<String> = raw_images
            .split(',')
            .map(|s| s.trim().to_string())
            .collect();

        // 收集 per-image 内存配置（POOL_MEMORY_MB_{IMAGE_NAME}）
        let mut per_image_memory = std::collections::HashMap::new();
        for img in &images {
            let norm = img.to_uppercase().replace('-', "_");
            let key = format!("POOL_MEMORY_MB_{}", norm);
            if let Some(val) = env_var_parse::<u64>(&key) {
                // 使用归一化后的镜像名作为 key（strip :latest）
                let normalized = if let Some(stripped) = img.strip_suffix(":latest") {
                    stripped.to_string()
                } else {
                    img.clone()
                };
                per_image_memory.insert(normalized, val);
            }
        }

        PoolConfig {
            enabled,
            initial_size: env_var_parse("POOL_INITIAL_SIZE").unwrap_or(2),
            max_size: env_var_parse("POOL_MAX_SIZE").unwrap_or(16),
            min_size: env_var_parse("POOL_MIN_SIZE").unwrap_or(1),
            memory_mb: env_var_parse("POOL_MEMORY_MB").unwrap_or(256),
            cpu: env_var_parse("POOL_CPU").unwrap_or(0.0),
            images,
            per_image_memory,
            idle_timeout_secs: env_var_parse("POOL_IDLE_TIMEOUT").unwrap_or(300),
            scale_interval_secs: env_var_parse("POOL_SCALE_INTERVAL").unwrap_or(60),
            max_archive_mb: env_var_parse("POOL_MAX_ARCHIVE_MB").unwrap_or(25),
            kill_grace_secs: env_var_parse("POOL_KILL_GRACE_SECONDS").unwrap_or(2),
            label_prefix: env_or("POOL_LABEL_PREFIX", "com.noj.judge"),
            metrics_bind: env_or("METRICS_BIND", "127.0.0.1:9100"),
            metrics_auth_token: std::env::var("METRICS_AUTH_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        }
    }

    /// 获取指定镜像的内存限制 MB。
    ///
    /// 优先返回 per-image 配置（`POOL_MEMORY_MB_{IMAGE}`），
    /// 不存在则返回全局默认值。
    /// 查找时自动归一化镜像名（strip `:latest`）。
    pub fn memory_mb_for_image(&self, image: &str) -> u64 {
        let normalized = if let Some(stripped) = image.strip_suffix(":latest") {
            stripped
        } else {
            image
        };
        self.per_image_memory
            .get(normalized)
            .copied()
            .unwrap_or(self.memory_mb)
    }
}

/// 读取环境变量，不存在时返回默认值。
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// 读取环境变量并解析为指定类型。
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
            "POOL_ENABLED",
            "POOL_INITIAL_SIZE",
            "POOL_MAX_SIZE",
            "POOL_MIN_SIZE",
            "POOL_MEMORY_MB",
            "POOL_CPU",
            "POOL_IMAGES",
            "POOL_IDLE_TIMEOUT",
            "POOL_SCALE_INTERVAL",
            "POOL_MAX_ARCHIVE_MB",
            "POOL_KILL_GRACE_SECONDS",
            "POOL_LABEL_PREFIX",
        ] {
            std::env::remove_var(key);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://127.0.0.1/");
        assert_eq!(cfg.judge_queue, "noj:judge:queue");
        assert_eq!(cfg.work_dir, "/tmp/noj-judge");

        let p = &cfg.pool;
        assert!(p.enabled);
        assert_eq!(p.initial_size, 2);
        assert_eq!(p.max_size, 16);
        assert_eq!(p.min_size, 1);
        assert_eq!(p.memory_mb, 256);
        assert_eq!(p.cpu, 0.0);
        assert_eq!(p.images, vec!["noj-judge-python"]);
        assert_eq!(p.idle_timeout_secs, 300);
        assert_eq!(p.scale_interval_secs, 60);
        assert_eq!(p.max_archive_mb, 25);
        assert_eq!(p.kill_grace_secs, 2);
        assert_eq!(p.label_prefix, "com.noj.judge");
    }

    #[test]
    fn test_config_custom_values() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![
            ("REDIS_URL", "redis://custom:6379"),
            ("JUDGE_QUEUE", "custom:queue"),
            ("RESULT_QUEUE", "custom:results"),
            ("WORK_DIR", "/custom/path"),
            ("POOL_ENABLED", "true"),
            ("POOL_INITIAL_SIZE", "4"),
            ("POOL_MAX_SIZE", "32"),
            ("POOL_MIN_SIZE", "2"),
            ("POOL_MEMORY_MB", "512"),
            ("POOL_CPU", "2.0"),
            ("POOL_IMAGES", "noj-judge-python,noj-judge-cpp"),
            ("POOL_IDLE_TIMEOUT", "600"),
            ("POOL_SCALE_INTERVAL", "120"),
            ("POOL_MAX_ARCHIVE_MB", "50"),
            ("POOL_KILL_GRACE_SECONDS", "5"),
            ("POOL_LABEL_PREFIX", "org.example"),
        ]);
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://custom:6379");

        let p = &cfg.pool;
        assert!(p.enabled);
        assert_eq!(p.initial_size, 4);
        assert_eq!(p.max_size, 32);
        assert_eq!(p.min_size, 2);
        assert_eq!(p.memory_mb, 512);
        assert_eq!(p.cpu, 2.0);
        assert_eq!(p.images, vec!["noj-judge-python", "noj-judge-cpp"]);
        assert_eq!(p.idle_timeout_secs, 600);
        assert_eq!(p.scale_interval_secs, 120);
        assert_eq!(p.max_archive_mb, 50);
        assert_eq!(p.kill_grace_secs, 5);
        assert_eq!(p.label_prefix, "org.example");
    }

    #[test]
    fn test_max_concurrent_legacy_fallback() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![("POOL_ENABLED", "false"), ("MAX_CONCURRENT", "8")]);
        let cfg = Config::from_env();
        // POOL_ENABLED=false 时 max_concurrent 读取 MAX_CONCURRENT
        assert!(!cfg.pool.enabled);
        assert_eq!(cfg.max_concurrent(), 8);
    }

    #[test]
    fn test_max_concurrent_pool_max_size() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![
            ("POOL_ENABLED", "true"),
            ("POOL_MAX_SIZE", "12"),
            ("MAX_CONCURRENT", "8"),
        ]);
        let cfg = Config::from_env();
        // POOL_ENABLED=true 时 max_concurrent 返回 pool.max_size
        assert!(cfg.pool.enabled);
        assert_eq!(cfg.max_concurrent(), 12);
    }
}
