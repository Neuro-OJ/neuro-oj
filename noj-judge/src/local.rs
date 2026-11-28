//! `noj-judge run-local`：本地验题入口（出题人工具，不连 Redis、不走调度）。
//!
//! 读取一个与生产**同构**的 [`JudgeTask`] JSON（由 `noj-cli problem test` 调用
//! noj-core 的 `prepareJudgeTask` 生成），把本地支持包 / 产物文件包装为
//! `noj-download://local` 后交给 Worker 同一入口
//! [`crate::judge::runner::evaluate_with_cpu_limit`]。容器安全基线
//! （`cap_drop ALL`、`no-new-privileges`、默认无网、不挂 docker socket）与镜像 /
//! 命令白名单全部沿用生产实现，本模块**不做任何编排**。
//!
//! 网络默认关闭：题目声明了 `evaluator.network.enabled` 也会被关掉，只有显式
//! `--allow-network` 才联网。LLM 题可用 `mock://` 网关离线验题（SDK 回显）。
//!
//! 设计说明：`dev-docs/design/problem-local-test.md`。

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::Value;

use crate::config::Config;
use crate::types::{JudgeResult, JudgeRuntimeConfig, JudgeTask};

/// 子命令名。
pub const SUBCOMMAND: &str = "run-local";

/// LLM 离线 mock 网关地址前缀（SDK 识别后返回确定性回显，不发起网络请求）。
pub const LLM_MOCK_SCHEME: &str = "mock://";

/// 联网但未指定网络名时使用的 Docker 网络。
pub const DEFAULT_LOCAL_NETWORK: &str = "bridge";

/// 中断后清理本次容器的最长等待时间。
const INTERRUPT_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// 平台错误结果转为错误说明；正式判定（graded）返回 None。
pub fn platform_error_message(result: &JudgeResult) -> Option<String> {
    let kind = result
        .result_kind
        .as_deref()
        .unwrap_or_else(|| crate::types::result_kind_for_status(&result.status));
    if kind != "platform_error" {
        return None;
    }
    // 详情（evaluator stderr 等）已在结果 output 中，CLI 另行摘要展示，这里只给结论。
    Some(format!(
        "评测平台错误（status={}），不是正式得分",
        result.status
    ))
}

/// 等待 Ctrl+C 或（Unix 下）SIGTERM，返回信号名。
async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(term) => term,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return "SIGINT";
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "SIGINT",
            _ = term.recv() => "SIGTERM",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl+C"
    }
}

/// `run-local` 参数。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LocalArgs {
    /// JudgeTask JSON 文件；`-` 表示 stdin。
    pub task: String,
    /// 支持包 zip（题目评测文件，已剥离 problem.json / statement.md）。
    pub support_package: Option<PathBuf>,
    /// 产物文件（artifact zip 或 prediction 预测文件）。
    pub artifact: Option<PathBuf>,
    /// 显式允许 evaluator 联网（默认关闭）。
    pub allow_network: bool,
    /// 联网时使用的 Docker 网络名。
    pub network: Option<String>,
    /// 每个容器 CPU 上限（毫核）；缺省沿用 `JUDGE_CPU_LIMIT_MILLICORES`。
    pub cpu_millicores: Option<u64>,
}

/// `run-local` 用法文本。
pub fn usage() -> &'static str {
    "用法: noj-judge run-local --task <task.json|-> [选项]\n\
     \n\
     本地验题：按生产同一入口执行一个 JudgeTask，结果 JSON 写到 stdout，日志写到 stderr。\n\
     通常由 `noj-cli problem test` 调用，不建议手写任务。\n\
     \n\
     选项:\n\
     \x20 --task <path|->          JudgeTask JSON（- 为 stdin）\n\
     \x20 --support-package <zip>  题目支持包（剥离 problem.json/statement.md 后的 zip）\n\
     \x20 --artifact <file>        产物提交 zip 或 prediction 预测文件\n\
     \x20 --allow-network          允许 evaluator 联网（默认关闭；Solution 始终无网）\n\
     \x20 --network <name>         联网时使用的 Docker 网络（默认 bridge）\n\
     \x20 --cpu-millicores <n>     每个容器 CPU 上限（默认读 JUDGE_CPU_LIMIT_MILLICORES）\n\
     \n\
     退出码: 0 已产出结果 JSON / 1 执行失败 / 2 用法错误\n"
}

/// 解析 `run-local` 之后的参数（不含子命令本身）。
pub fn parse_args(args: &[String]) -> Result<LocalArgs> {
    let mut out = LocalArgs::default();
    let mut task = None;
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let mut value = |name: &str| -> Result<String> {
            i += 1;
            match args.get(i) {
                Some(v) if !v.starts_with("--") => Ok(v.clone()),
                _ => bail!("{name} 需要一个值"),
            }
        };
        match flag {
            "--task" => task = Some(value("--task")?),
            "--support-package" => out.support_package = Some(value("--support-package")?.into()),
            "--artifact" => out.artifact = Some(value("--artifact")?.into()),
            "--allow-network" => out.allow_network = true,
            "--network" => out.network = Some(value("--network")?),
            "--cpu-millicores" => {
                let raw = value("--cpu-millicores")?;
                let n: u64 = raw
                    .parse()
                    .with_context(|| format!("--cpu-millicores 必须是正整数，收到 {raw}"))?;
                if !(100..=16000).contains(&n) {
                    bail!("--cpu-millicores 有效范围 100-16000，收到 {n}");
                }
                out.cpu_millicores = Some(n);
            }
            other => bail!("未知参数: {other}"),
        }
        i += 1;
    }
    out.task = task.context("缺少 --task")?;
    if out.network.is_some() && !out.allow_network {
        bail!("--network 需要同时指定 --allow-network");
    }
    if let Some(network) = &out.network {
        crate::config::validate_evaluator_network_mode(network)
            .or_else(|e| {
                // 本地验题允许 bridge（出题人自己的机器）；host 依旧拒绝。
                if network == DEFAULT_LOCAL_NETWORK {
                    Ok(())
                } else {
                    Err(e)
                }
            })
            .map_err(|e| anyhow::anyhow!(e))?;
    }
    Ok(out)
}

/// `run-local` 输出封套。
#[derive(Debug, Serialize)]
pub struct LocalOutput {
    /// 与生产一致的评测结果（score 为 ×100 整数）。
    pub result: JudgeResult,
    /// 端到端墙钟耗时（含容器启动）。
    pub wall_ms: u64,
    /// 本地执行时对任务做的调整（如关闭网络），供 CLI 展示。
    pub notes: Vec<String>,
    /// 执行失败时的完整错误链（本地工具，不需要对出题人脱敏）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 按本地参数调整任务（纯函数，便于单测）：网络策略与 LLM 网关校验。
pub fn apply_local_policy(task: &mut JudgeTask, args: &LocalArgs) -> Result<Vec<String>> {
    let mut notes = Vec::new();
    if let Some(llm) = &task.llm {
        let mock = llm.gateway_url.starts_with(LLM_MOCK_SCHEME);
        if !mock && !args.allow_network {
            bail!("任务使用真实 LLM 网关，必须显式 --allow-network（离线验题请改用 mock 网关）");
        }
    }
    if let JudgeRuntimeConfig::Dual(config) = &mut task.runtime_config {
        let requested = config.evaluator.network.as_ref().is_some_and(|n| n.enabled);
        if requested && !args.allow_network {
            config.evaluator.network = None;
            notes.push(
                "题目声明了 evaluator 联网，本地验题默认关闭网络；需要联网请显式 --allow-network"
                    .to_string(),
            );
        }
    }
    if task.submission_id.is_empty() {
        task.submission_id = format!("local-{}", uuid::Uuid::new_v4());
    }
    Ok(notes)
}

/// 生成 `noj-download://local` 地址（含 SHA-256，judge 下载后照常校验）。
pub async fn local_download_url(path: &Path) -> Result<String> {
    let checksum = crate::sandbox::download::sha256_file(path).await?;
    let raw = path.to_string_lossy();
    Ok(format!(
        "noj-download://local?path={}&checksum_sha256={}",
        utf8_percent_encode(&raw, NON_ALPHANUMERIC),
        checksum
    ))
}

/// 把用户文件复制成临时目录下的 `.zip` 名称（local 协议只接受绝对路径的 `.zip`）。
fn stage_file(src: &Path, dir: &Path, name: &str) -> Result<PathBuf> {
    let meta =
        std::fs::metadata(src).with_context(|| format!("读取文件失败: {}", src.display()))?;
    if !meta.is_file() {
        bail!("不是普通文件: {}", src.display());
    }
    let dest = dir.join(name);
    std::fs::copy(src, &dest).with_context(|| format!("复制文件失败: {}", src.display()))?;
    Ok(dest)
}

fn read_task(path: &str) -> Result<JudgeTask> {
    let raw = if path == "-" {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).context("读取 stdin 失败")?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("读取任务文件失败: {path}"))?
    };
    let value: Value = serde_json::from_str(&raw).context("任务不是合法 JSON")?;
    serde_json::from_value(value).context("任务不符合 JudgeTask 协议")
}

/// 执行一次本地评测并返回输出封套。
pub async fn run(args: &LocalArgs) -> Result<LocalOutput> {
    let mut task = read_task(&args.task)?;
    let notes = apply_local_policy(&mut task, args)?;

    // local 协议仅供本进程使用；生产 Worker 不会进入本函数。
    std::env::set_var("JUDGE_ALLOW_LOCAL_DOWNLOAD", "1");
    let config = Config::from_env();

    let scratch = tempfile::Builder::new()
        .prefix("noj-judge-local-")
        .tempdir()
        .context("创建临时目录失败")?;
    let staged = scratch.path().join("staged");
    std::fs::create_dir_all(&staged)?;

    task.download_url = match &args.support_package {
        Some(path) => Some(local_download_url(&stage_file(path, &staged, "support.zip")?).await?),
        None => None,
    };
    task.artifact_download_url = match &args.artifact {
        Some(path) => Some(local_download_url(&stage_file(path, &staged, "artifact.zip")?).await?),
        None => None,
    };

    // 与 Worker 一致地遵守 JUDGE_REQUIRE_ISOLATED_DOCKER（缺省 false，普通本机 Docker 可用）。
    let docker = crate::docker::connect(&config.docker_host, config.require_isolated_docker)
        .context("连接 Docker 失败（检查 JUDGE_DOCKER_HOST / JUDGE_REQUIRE_ISOLATED_DOCKER 或 Docker 是否运行）")?;
    docker
        .ping()
        .await
        .context("Docker daemon PING 失败（请确认 Docker 在运行中）")?;

    let network = args
        .network
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_NETWORK.to_string());
    let instance_id = format!(
        "noj-local-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    let started = Instant::now();
    let evaluation = crate::judge::runner::evaluate_with_cpu_limit(
        docker.clone(),
        None,
        &task,
        config.support_package_download_timeout_secs,
        scratch.path().join("cache").to_string_lossy().into_owned(),
        8,
        config.support_cache_max_mb,
        scratch.path().join("work").to_string_lossy().into_owned(),
        args.cpu_millicores.unwrap_or(config.cpu_limit_millicores),
        args.allow_network,
        &network,
        false,
        &config.image_prefix,
        &config.oi_image,
        &config.command_whitelist,
        config.max_evaluator_time_ms,
        config.max_solution_call_timeout_ms,
        config.prediction_workspace_mb,
        &instance_id,
    );
    // Ctrl+C / SIGTERM：放弃评测 future 后按本次实例标签有界清理容器，避免残留。
    let outcome = tokio::select! {
        outcome = evaluation => outcome,
        signal = shutdown_signal() => {
            let cleaned = tokio::time::timeout(
                INTERRUPT_CLEANUP_TIMEOUT,
                crate::sandbox::cleanup::cleanup_orphan_containers(&docker, &instance_id),
            )
            .await
            .unwrap_or(0);
            bail!("收到 {signal}，已中止本地评测并清理 {cleaned} 个容器");
        }
    };
    let wall_ms = started.elapsed().as_millis() as u64;
    let (result, error) = match outcome {
        Ok(result) => {
            // 平台错误（evaluator 崩溃、非法评分等）不是正式得分，不能参与分数断言。
            let error = platform_error_message(&result);
            (result, error)
        }
        Err(err) => (
            JudgeResult::from_error(&err, &task.submission_id, task.rejudge_seq),
            Some(format!("{err:#}")),
        ),
    };
    Ok(LocalOutput {
        result,
        wall_ms,
        notes,
        error,
    })
}

/// 子命令入口：返回进程退出码。
pub fn main_with_args(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", usage());
        return 0;
    }
    let parsed = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("run-local: {err:#}\n\n{}", usage());
            return 2;
        }
    };
    // 日志统一写 stderr，stdout 只留结果 JSON；缺省只打 error 级，避免 local 协议告警刷屏。
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("error"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("run-local: 创建 Tokio 运行时失败: {err}");
            return 1;
        }
    };
    match runtime.block_on(run(&parsed)) {
        Ok(output) => match serde_json::to_string(&output) {
            Ok(json) => {
                println!("{json}");
                0
            }
            Err(err) => {
                eprintln!("run-local: 序列化结果失败: {err}");
                1
            }
        },
        Err(err) => {
            eprintln!("run-local: {err:#}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{EvaluatorNetwork, JudgeTaskLlm};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn task(network: bool, llm_gateway: Option<&str>) -> JudgeTask {
        let value = serde_json::json!({
            "submission_id": "",
            "problem_id": "local",
            "user_id": "local",
            "language": "python3",
            "code": "def solve(): return 1",
            "file_name": "main.py",
            "download_url": null,
            "runtime_config": {
                "evaluator": {"image": "noj-evaluator-python", "command": "python3 /workspace/evaluate.py",
                               "time_limit_ms": 1000, "memory_limit_mb": 128},
                "solution": {"image": "noj-solution-python", "call_timeout_ms": 1000, "memory_limit_mb": 128}
            }
        });
        let mut task: JudgeTask = serde_json::from_value(value).unwrap();
        if network {
            if let JudgeRuntimeConfig::Dual(c) = &mut task.runtime_config {
                c.evaluator.network = Some(EvaluatorNetwork { enabled: true });
            }
        }
        task.llm = llm_gateway.map(|url| JudgeTaskLlm {
            gateway_url: url.to_string(),
            eval_token: "t".to_string(),
            provider_id: "local".to_string(),
            allowed_models: vec!["default".to_string()],
        });
        task
    }

    #[test]
    fn parse_requires_task() {
        assert!(parse_args(&args(&[])).is_err());
        let parsed =
            parse_args(&args(&["--task", "t.json", "--support-package", "s.zip"])).unwrap();
        assert_eq!(parsed.task, "t.json");
        assert_eq!(parsed.support_package, Some(PathBuf::from("s.zip")));
        assert!(!parsed.allow_network);
    }

    #[test]
    fn parse_rejects_unknown_and_bad_values() {
        assert!(parse_args(&args(&["--task", "t", "--bogus"])).is_err());
        assert!(parse_args(&args(&["--task", "--allow-network"])).is_err());
        assert!(parse_args(&args(&["--task", "t", "--cpu-millicores", "50"])).is_err());
    }

    #[test]
    fn network_name_requires_explicit_allow() {
        assert!(parse_args(&args(&["--task", "t", "--network", "noj-eval-net"])).is_err());
        assert!(parse_args(&args(&[
            "--task",
            "t",
            "--allow-network",
            "--network",
            "noj-eval-net"
        ]))
        .is_ok());
        // 本地允许 bridge，但 host 仍拒绝（评测代码不得共享宿主网络栈）。
        assert!(parse_args(&args(&[
            "--task",
            "t",
            "--allow-network",
            "--network",
            "bridge"
        ]))
        .is_ok());
        assert!(parse_args(&args(&[
            "--task",
            "t",
            "--allow-network",
            "--network",
            "host"
        ]))
        .is_err());
    }

    #[test]
    fn network_disabled_by_default_even_if_problem_requests_it() {
        let mut t = task(true, None);
        let notes = apply_local_policy(&mut t, &LocalArgs::default()).unwrap();
        assert_eq!(notes.len(), 1);
        let dual = t.runtime_config.as_dual().unwrap();
        assert!(dual.evaluator.network.is_none());
        assert!(t.submission_id.starts_with("local-"));
    }

    #[test]
    fn network_kept_when_explicitly_allowed() {
        let mut t = task(true, None);
        let allow = LocalArgs {
            allow_network: true,
            ..Default::default()
        };
        let notes = apply_local_policy(&mut t, &allow).unwrap();
        assert!(notes.is_empty());
        assert!(t
            .runtime_config
            .as_dual()
            .unwrap()
            .evaluator
            .network
            .is_some());
    }

    #[test]
    fn real_llm_gateway_requires_network() {
        let mut t = task(true, Some("http://127.0.0.1:8001"));
        assert!(apply_local_policy(&mut t, &LocalArgs::default()).is_err());
        let mut mock = task(true, Some("mock://echo"));
        assert!(apply_local_policy(&mut mock, &LocalArgs::default()).is_ok());
    }

    #[tokio::test]
    async fn local_download_url_carries_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a b.zip");
        std::fs::write(&path, b"hello").unwrap();
        let url = local_download_url(&path).await.unwrap();
        assert!(url.starts_with("noj-download://local?path=%2F"));
        assert!(url.ends_with(&crate::sandbox::download::sha256_hex(b"hello")));
        assert!(!url.contains(' '));
    }

    fn result_with(status: &str, kind: Option<&str>) -> JudgeResult {
        let mut result = JudgeResult::from_error(&anyhow::anyhow!("x"), "local-1", None);
        result.status = status.to_string();
        result.output = "evaluator crashed".to_string();
        result.result_kind = kind.map(str::to_string);
        result
    }

    #[test]
    fn platform_error_results_are_not_scores() {
        let msg = platform_error_message(&result_with("SE", None)).unwrap();
        assert!(msg.contains("status=SE"), "{msg}");
        assert!(platform_error_message(&result_with("error", None)).is_some());
        assert!(platform_error_message(&result_with("finished", Some("platform_error"))).is_some());
        assert!(platform_error_message(&result_with("finished", None)).is_none());
        assert!(platform_error_message(&result_with("WA", Some("graded"))).is_none());
    }
}
