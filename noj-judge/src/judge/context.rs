//! Judge worker 与单次运行的显式上下文。
//!
//! 资源、路径和实例身份属于 WorkerContext；任务归属、取消状态和本次运行标识属于
//! RunContext。这样执行后端不需要继续在调用栈中散落一组相互独立的生命周期参数。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::types::JudgeTask;

#[derive(Debug, Clone)]
pub struct WorkerContext {
    pub instance_id: String,
    pub work_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub image_prefix: String,
}

impl WorkerContext {
    pub fn new(
        instance_id: impl Into<String>,
        work_dir: impl Into<PathBuf>,
        cache_dir: impl Into<PathBuf>,
        image_prefix: impl Into<String>,
    ) -> Self {
        Self {
            instance_id: instance_id.into(),
            work_dir: work_dir.into(),
            cache_dir: cache_dir.into(),
            image_prefix: image_prefix.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RunContext {
    pub task_kind: String,
    pub submission_id: String,
    pub run_id: String,
    pub worker_instance_id: String,
    cancelled: Arc<AtomicBool>,
}

impl RunContext {
    pub fn new(task: &JudgeTask, worker: &WorkerContext) -> Result<Self> {
        task.validate_protocol()
            .map_err(|gaps| anyhow!("JudgeTask v3 封套不完整: {gaps:?}"))?;
        let task_kind = task
            .task_kind
            .clone()
            .ok_or_else(|| anyhow!("JudgeTask 缺少 task_kind"))?;
        let run_id = task
            .run_id
            .clone()
            .ok_or_else(|| anyhow!("JudgeTask 缺少 run_id"))?;
        Ok(Self {
            task_kind,
            submission_id: task.submission_id.clone(),
            run_id,
            worker_instance_id: worker.instance_id.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{JudgeRuntimeConfig, RuntimeConfig};
    use serde_json::json;

    #[test]
    fn run_context_requires_v3_envelope() {
        let value = json!({
            "task_kind": "submission",
            "run_id": "attempt-1",
            "attempt_id": "attempt-1",
            "problem_version_id": "version-1",
            "evaluation_protocol_version": 3,
            "rejudge_seq": 0,
            "submission_id": "submission-1",
            "problem_id": "problem-1",
            "user_id": "user-1",
            "runtime_config": {
                "evaluator": {
                    "image": "noj-evaluator-python",
                    "command": "python3 /workspace/evaluate.py",
                    "time_limit_ms": 1000,
                    "memory_limit_mb": 128
                },
                "solution": {
                    "image": "noj-solution-python",
                    "call_timeout_ms": 1000,
                    "memory_limit_mb": 128
                }
            },
            "language": "python3",
            "code": "print(1)"
        });
        let task: JudgeTask = serde_json::from_value(value).unwrap();
        let worker = WorkerContext::new("worker-1", "/tmp/noj", "/tmp/noj/cache", "noj-");
        let run = RunContext::new(&task, &worker).unwrap();
        assert_eq!(run.task_kind, "submission");
        assert_eq!(run.run_id, "attempt-1");
        assert!(!run.is_cancelled());
        run.cancel();
        assert!(run.is_cancelled());
        let _: Option<RuntimeConfig> = task.runtime_config.as_dual().cloned();
        let _: &JudgeRuntimeConfig = &task.runtime_config;
    }
}
