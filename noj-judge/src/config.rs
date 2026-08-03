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
            support_package_download_timeout_secs: env_var_parse(
                "SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT",
            )
            .unwrap_or(60),
            support_cache_dir: env_or("SUPPORT_CACHE_DIR", "/tmp/noj-judge/support-cache"),
            support_cache_max_items: env_var_parse("SUPPORT_CACHE_MAX_ITEMS").unwrap_or(500),
            support_cache_max_mb: env_var_parse("SUPPORT_CACHE_MAX_MB").unwrap_or(2048),
        }
    }
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
        for key in &["REDIS_URL", "JUDGE_QUEUE", "RESULT_QUEUE", "WORK_DIR"] {
            std::env::remove_var(key);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://127.0.0.1/");
        assert_eq!(cfg.judge_queue, "noj:judge:queue");
        assert_eq!(cfg.work_dir, "/tmp/noj-judge");
    }

    #[test]
    fn test_config_custom_values() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![
            ("REDIS_URL", "redis://custom:6379"),
            ("JUDGE_QUEUE", "custom:queue"),
            ("RESULT_QUEUE", "custom:results"),
            ("WORK_DIR", "/custom/path"),
        ]);
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://custom:6379");
        assert_eq!(cfg.judge_queue, "custom:queue");
        assert_eq!(cfg.result_queue, "custom:results");
        assert_eq!(cfg.work_dir, "/custom/path");
    }
}
