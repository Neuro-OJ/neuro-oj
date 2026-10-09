//! 每次评测独立的累计进度快照；跨副本状态通过 Core/Redis 持久化。
use super::{OiCaseResult, OiRuntimeConfig};
use crate::types::JudgeTask;
use redis::AsyncCommands;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct ProgressReporter {
    client: Option<redis::Client>,
    submission_id: String,
    run_id: Option<String>,
    rejudge_seq: i64,
    state: Arc<Mutex<Value>>,
    cancelled: Arc<AtomicBool>,
    resource_lost: Arc<AtomicBool>,
    _watcher: Option<Arc<CancelWatcher>>,
    scheduling: Option<(crate::scheduling::Scheduler, Arc<crate::scheduling::Lease>)>,
    _resource_watcher: Option<Arc<CancelWatcher>>,
    waits: Arc<Mutex<Vec<(String, u64)>>>,
}

struct CancelWatcher(tokio::task::JoinHandle<()>, Arc<AtomicBool>);

/// 执行线程持有阶段租约和父租约，异步调用被取消时也不会提前释放容量。
pub struct StageLease {
    _lease: crate::scheduling::Lease,
    _parent: Arc<crate::scheduling::Lease>,
    watcher: tokio::task::JoinHandle<()>,
}
impl Drop for StageLease {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}
impl Drop for CancelWatcher {
    fn drop(&mut self) {
        self.1.store(true, Ordering::Relaxed);
        self.0.abort();
    }
}

impl ProgressReporter {
    pub fn new(task: &JudgeTask, client: Option<&redis::Client>, config: &OiRuntimeConfig) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        let watcher = if task.submission_id.starts_with("st_") {
            match (client, task.run_id.as_ref()) {
                (Some(client), Some(run_id)) => {
                    let client = client.clone();
                    let key = format!("noj:judge:cancel:{}:{}", task.submission_id, run_id);
                    let flag = cancelled.clone();
                    let drop_flag = flag.clone();
                    Some(Arc::new(CancelWatcher(
                        tokio::spawn(async move {
                            let mut interval =
                                tokio::time::interval(std::time::Duration::from_millis(200));
                            loop {
                                interval.tick().await;
                                let check = async {
                                    let mut connection =
                                        client.get_multiplexed_async_connection().await?;
                                    connection.exists::<_, bool>(&key).await
                                };
                                if matches!(
                                    tokio::time::timeout(std::time::Duration::from_secs(1), check)
                                        .await,
                                    Ok(Ok(true))
                                ) {
                                    flag.store(true, Ordering::Relaxed);
                                    break;
                                }
                            }
                        }),
                        drop_flag,
                    )))
                }
                _ => None,
            }
        } else {
            None
        };
        Self {
            waits: Arc::new(Mutex::new(Vec::new())),
            scheduling: None,
            _resource_watcher: None,
            cancelled,
            resource_lost: Arc::new(AtomicBool::new(false)),
            _watcher: watcher,
            client: client.cloned(),
            submission_id: task.submission_id.clone(),
            run_id: task.run_id.clone(),
            rejudge_seq: task.rejudge_seq.unwrap_or(0),
            state: Arc::new(Mutex::new(
                json!({"sequence":0,"phase":"queued","active_cases":[],"completed_cases":[],"total_cases":config.subtasks.iter().map(|item|item.cases.len()).sum::<usize>()}),
            )),
        }
    }

    pub fn with_scheduling(
        mut self,
        scheduling: Option<(
            &crate::scheduling::Scheduler,
            &Arc<crate::scheduling::Lease>,
        )>,
    ) -> Self {
        if let Some((scheduler, parent)) = scheduling {
            self.scheduling = Some((scheduler.clone(), parent.clone()));
            let parent = parent.clone();
            let flag = self.cancelled.clone();
            let resource_lost = self.resource_lost.clone();
            let drop_flag = flag.clone();
            self._resource_watcher = Some(Arc::new(CancelWatcher(
                tokio::spawn(async move {
                    parent.wait_lost().await;
                    resource_lost.store(true, Ordering::Relaxed);
                    flag.store(true, Ordering::Relaxed);
                }),
                drop_flag,
            )));
        }
        self
    }

    pub async fn stage(
        &self,
        kind: &str,
        memory_mb: u64,
    ) -> anyhow::Result<Option<Arc<StageLease>>> {
        if let Some((scheduler, parent)) = &self.scheduling {
            let started = std::time::Instant::now();
            let result = tokio::select! {
                result = scheduler.stage(parent, kind, memory_mb) => {
                    let lease = result?;
                    let lost = lease.loss_flag();
                    let cancelled = self.cancelled.clone();
                    let resource_lost = self.resource_lost.clone();
                    let watcher = tokio::spawn(async move {
                        while !lost.load(Ordering::Relaxed) {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                        resource_lost.store(true, Ordering::Relaxed);
                        cancelled.store(true, Ordering::Relaxed);
                    });
                    Ok(Some(Arc::new(StageLease { _lease: lease, _parent: parent.clone(), watcher })))
                },
                _ = self.wait_cancelled() => anyhow::bail!("任务已取消或资源租约失效"),
            };
            self.waits
                .lock()
                .await
                .push((kind.to_owned(), started.elapsed().as_millis() as u64));
            result
        } else {
            Ok(None)
        }
    }
    // 独立性能验收入口使用，生产二进制不读取逐次等待样本。
    #[allow(dead_code)]
    pub async fn wait_samples(&self) -> Vec<(String, u64)> {
        self.waits.lock().await.clone()
    }
    pub fn case_window(&self) -> usize {
        self.scheduling
            .as_ref()
            .map(|(scheduler, _)| scheduler.settings.capacities.wasm_run as usize)
            .unwrap_or(16)
    }
    pub async fn adjust_data_memory(&self, bytes: usize) -> anyhow::Result<()> {
        if let Some((_, lease)) = &self.scheduling {
            lease
                .shrink_base(
                    (bytes as u64)
                        .saturating_mul(2)
                        .div_ceil(1024 * 1024)
                        .saturating_add(128),
                )
                .await?;
        }
        Ok(())
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
    pub fn ensure_resource_valid(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.resource_lost.load(Ordering::Relaxed),
            "资源租约续租失败，评测中止，请重测"
        );
        Ok(())
    }
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }
    pub async fn wait_cancelled(&self) {
        if self._watcher.is_none() && self._resource_watcher.is_none() {
            std::future::pending::<()>().await;
        }
        while !self.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// 发送整个累计快照，使多消费者乱序时可以安全丢弃旧序号。
    async fn publish(&self, state: &mut Value) {
        state["sequence"] = json!(state["sequence"].as_u64().unwrap_or(0) + 1);
        let (Some(client), Some(run_id)) = (&self.client, &self.run_id) else {
            return;
        };
        let message=json!({"kind":"oi_progress","submission_id":self.submission_id,"run_id":run_id,"rejudge_seq":self.rejudge_seq,"progress":state}).to_string();
        let sent = async {
            let mut connection = client.get_multiplexed_async_connection().await?;
            connection
                .lpush::<_, _, usize>("noj:judge:results", message)
                .await
        }
        .await;
        if let Err(error) = sent {
            tracing::warn!(error=%error,"OI 进度发送失败，最终结果继续独立投递");
        }
    }

    pub async fn phase(&self, phase: &str) {
        let mut state = self.state.lock().await;
        state["phase"] = json!(phase);
        self.publish(&mut state).await;
    }

    pub async fn start_case(&self, subtask: &str, case_id: &str) {
        let mut state = self.state.lock().await;
        state["phase"] = json!("judging");
        state["active_cases"]
            .as_array_mut()
            .unwrap()
            .push(json!({"subtask_id":subtask,"case_id":case_id}));
        self.publish(&mut state).await;
    }

    pub async fn finish_case(
        &self,
        subtask: &str,
        case_id: &str,
        result: &OiCaseResult,
        maximum: f64,
    ) {
        let mut state = self.state.lock().await;
        state["active_cases"]
            .as_array_mut()
            .unwrap()
            .retain(|item| item["case_id"] != case_id || item["subtask_id"] != subtask);
        let score = result
            .score
            .unwrap_or(if result.status == super::OiStatus::Accepted {
                maximum
            } else {
                0.0
            });
        let mut entry = json!({"subtask_id":subtask,"case_id":case_id,"status":result.status,"score":score,"max_score":maximum,"time_ms":result.time_ms,"memory_kb":result.memory_kb});
        if self.submission_id.starts_with("st_") {
            entry["stdout"] = json!(result.stdout);
            entry["stderr"] = json!(result.stderr);
            entry["stdout_truncated"] = json!(result.stdout_truncated);
            entry["stderr_truncated"] = json!(result.stderr_truncated);
        }
        state["completed_cases"].as_array_mut().unwrap().push(entry);
        self.publish(&mut state).await;
    }
}
