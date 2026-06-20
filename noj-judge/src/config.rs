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
    /// 最大并发评测数
    pub max_concurrent: usize,
    /// 临时工作目录
    pub work_dir: String,
}

impl Config {
    /// 从环境变量加载配置。
    ///
    /// 缺失的字段使用默认值，不会失败。
    /// 后续可添加配置文件读取支持。
    pub fn from_env() -> Self {
        Self {
            redis_url: std::env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://127.0.0.1/".to_string()),
            judge_queue: std::env::var("JUDGE_QUEUE")
                .unwrap_or_else(|_| "noj:judge:queue".to_string()),
            result_queue: std::env::var("RESULT_QUEUE")
                .unwrap_or_else(|_| "noj:judge:results".to_string()),
            max_concurrent: std::env::var("MAX_CONCURRENT")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(2),
            work_dir: std::env::var("WORK_DIR")
                .unwrap_or_else(|_| "/tmp/noj-judge".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// 环境变量测试全局互斥锁。
    ///
    /// `from_env()` 读取 `std::env::var`，而 Rust 测试默认并行执行，
    /// 不加锁会导致 env var 竞态。此处将所有 env 测试串行化。
    static ENV_TEST_MUTEX: Mutex<()> = std::sync::Mutex::new(());

    /// 临时设置环境变量，测试完自动恢复。
    struct EnvGuard {
        restored: Vec<(String, Option<String>)>,
    }

    impl EnvGuard {
        fn set(kvs: Vec<(&str, &str)>) -> Self {
            let mut restored = Vec::new();
            for (k, v) in &kvs {
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
        let _guard = EnvGuard::set(vec![]);
        for key in &["REDIS_URL", "JUDGE_QUEUE", "RESULT_QUEUE", "MAX_CONCURRENT", "WORK_DIR"] {
            std::env::remove_var(key);
        }
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://127.0.0.1/");
        assert_eq!(cfg.judge_queue, "noj:judge:queue");
        assert_eq!(cfg.result_queue, "noj:judge:results");
        assert_eq!(cfg.max_concurrent, 2);
        assert_eq!(cfg.work_dir, "/tmp/noj-judge");
    }

    #[test]
    fn test_config_custom_values() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![
            ("REDIS_URL", "redis://custom:6379"),
            ("JUDGE_QUEUE", "custom:queue"),
            ("RESULT_QUEUE", "custom:results"),
            ("MAX_CONCURRENT", "8"),
            ("WORK_DIR", "/custom/path"),
        ]);
        let cfg = Config::from_env();
        assert_eq!(cfg.redis_url, "redis://custom:6379");
        assert_eq!(cfg.judge_queue, "custom:queue");
        assert_eq!(cfg.result_queue, "custom:results");
        assert_eq!(cfg.max_concurrent, 8);
        assert_eq!(cfg.work_dir, "/custom/path");
    }

    #[test]
    fn test_config_invalid_max_concurrent_falls_back() {
        let _lock = ENV_TEST_MUTEX.lock().unwrap();
        let _guard = EnvGuard::set(vec![("MAX_CONCURRENT", "not_a_number")]);
        let cfg = Config::from_env();
        assert_eq!(cfg.max_concurrent, 2);
    }
}
