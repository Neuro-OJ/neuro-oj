//! go-judge HTTP 客户端。
//!
//! 生产 OI 原生评测优先走专用 go-judge 节点；没有配置
//! `JUDGE_GO_JUDGE_URL` 时才允许使用本地 Docker 兼容路径（开发与离线测试）。
//! 客户端只构造 worker 固定的命令和资源字段，题目消息不能改变 URL、token 或
//! 编译参数。

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use super::OiStatus;

const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
const COMPILE_TIMEOUT_MS: u64 = 10_000;
const COMPILE_MEMORY_MB: u64 = 512;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(305);

#[derive(Debug, Clone)]
pub struct GoJudgeClient {
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct GoJudgeFile {
    pub content: String,
    pub file_id: Option<String>,
}

impl GoJudgeFile {
    pub fn content(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            file_id: None,
        }
    }

    pub fn file_id(file_id: impl Into<String>) -> Self {
        Self {
            content: String::new(),
            file_id: Some(file_id.into()),
        }
    }
}

impl Serialize for GoJudgeFile {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if let Some(file_id) = &self.file_id {
            let mut state = serializer.serialize_struct("GoJudgeFile", 1)?;
            state.serialize_field("fileId", file_id)?;
            state.end()
        } else {
            let mut state = serializer.serialize_struct("GoJudgeFile", 1)?;
            state.serialize_field("content", &self.content)?;
            state.end()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum GoJudgeStdioFile {
    Input { content: String },
    Collector { name: String, max: u64 },
}

impl GoJudgeStdioFile {
    pub fn input(content: impl Into<String>) -> Self {
        Self::Input {
            content: content.into(),
        }
    }

    pub fn collector(name: impl Into<String>) -> Self {
        Self::Collector {
            name: name.into(),
            max: MAX_OUTPUT_BYTES as u64,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct GoJudgeCommand {
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
    #[serde(rename = "files", default, skip_serializing_if = "Vec::is_empty")]
    pub stdio: Vec<GoJudgeStdioFile>,
    #[serde(rename = "copyIn", default, skip_serializing_if = "HashMap::is_empty")]
    pub copy_in: HashMap<String, GoJudgeFile>,
    #[serde(rename = "copyOut", default, skip_serializing_if = "Vec::is_empty")]
    pub copy_out: Vec<String>,
    #[serde(
        rename = "copyOutCached",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub copy_out_cached: Vec<String>,
    #[serde(rename = "copyOutMax", default)]
    pub copy_out_max: u64,
    #[serde(rename = "cpuLimit")]
    pub cpu_limit_ns: u64,
    #[serde(rename = "clockLimit")]
    pub clock_limit_ns: u64,
    #[serde(rename = "memoryLimit")]
    pub memory_limit_bytes: u64,
    #[serde(rename = "procLimit")]
    pub proc_limit: u64,
}

#[derive(Debug, Clone, Serialize)]
struct GoJudgeRequest {
    cmd: Vec<GoJudgeCommand>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoJudgeResponse {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "exitStatus", default)]
    pub exit_status: Option<i64>,
    #[serde(default)]
    pub time: Option<u64>,
    #[serde(rename = "runTime", alias = "clockTime", default)]
    pub clock_time: Option<u64>,
    #[serde(default)]
    pub memory: Option<u64>,
    #[serde(default)]
    pub files: HashMap<String, GoJudgeOutputFile>,
    #[serde(rename = "fileIds", default)]
    pub file_ids: HashMap<String, String>,
}

/// go-judge 的 `copyOut` 在不同版本中可能返回纯字符串，旧兼容层也可能
/// 返回 `{content, truncated}` 对象；统一在客户端边界归一化，不能把
/// `copyOutCached` 的 fileId 当成选手输出。
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum GoJudgeOutputFile {
    Text(String),
    Structured {
        #[serde(default)]
        content: String,
        #[serde(default)]
        truncated: bool,
    },
}

impl GoJudgeOutputFile {
    pub fn content(&self) -> &str {
        match self {
            Self::Text(content) => content,
            Self::Structured { content, .. } => content,
        }
    }

    pub fn truncated(&self) -> bool {
        matches!(
            self,
            Self::Structured {
                truncated: true,
                ..
            }
        )
    }
}

impl GoJudgeClient {
    /// 从 worker 环境创建客户端。空 URL 表示开发模式使用本地 Docker。
    pub fn from_env() -> Result<Option<Self>> {
        let Some(raw) = std::env::var("JUDGE_GO_JUDGE_URL").ok() else {
            return Ok(None);
        };
        let base_url = raw.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Ok(None);
        }
        if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            anyhow::bail!("JUDGE_GO_JUDGE_URL 必须是 http(s) URL");
        }
        // 自定义认证头不能跟随重定向发往其他主机。
        let mut builder = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none());
        if std::env::var("JUDGE_GO_JUDGE_ALLOW_INVALID_TLS").as_deref() == Ok("true") {
            // 仅供隔离的本地开发节点；生产部署不应打开。
            builder = builder.danger_accept_invalid_certs(true);
        }
        Ok(Some(Self {
            base_url,
            token: std::env::var("JUDGE_GO_JUDGE_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
            http: builder.build().context("创建 go-judge HTTP 客户端失败")?,
        }))
    }

    pub async fn run(&self, command: GoJudgeCommand) -> Result<GoJudgeResponse> {
        let mut headers = HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Some(token) = &self.token {
            headers.insert(
                "X-Auth-Token",
                HeaderValue::from_str(token).context("go-judge token 含非法 HTTP 字符")?,
            );
        }
        let response = self
            .http
            .post(format!("{}/run", self.base_url))
            .headers(headers)
            .body(
                serde_json::to_vec(&GoJudgeRequest { cmd: vec![command] })
                    .context("编码 go-judge 请求失败")?,
            )
            .send()
            .await
            .context("请求 go-judge 失败")?;
        let status = response.status();
        let body = response.text().await.context("读取 go-judge 响应失败")?;
        if !status.is_success() {
            anyhow::bail!("go-judge 返回 HTTP {}", status.as_u16());
        }
        parse_response(&body)
    }
}

/// 编译缓存仅属于一次任务；正常返回或取消都调度删除，不让 go-judge 永久积累二进制。
pub(super) struct CachedFiles {
    client: GoJudgeClient,
    ids: Vec<String>,
}

impl CachedFiles {
    pub(super) fn new(client: &GoJudgeClient) -> Self {
        Self {
            client: client.clone(),
            ids: Vec::new(),
        }
    }
    pub(super) fn track(&mut self, id: &str) {
        self.ids.push(id.to_owned());
    }
}

impl Drop for CachedFiles {
    fn drop(&mut self) {
        let client = self.client.clone();
        let ids = std::mem::take(&mut self.ids);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                for id in ids {
                    let result = async {
                        let mut url = reqwest::Url::parse(&format!("{}/file/", client.base_url))?;
                        url.path_segments_mut()
                            .map_err(|_| anyhow::anyhow!("go-judge 缓存 URL 无效"))?
                            .pop_if_empty()
                            .push(&id);
                        let mut request = client.http.delete(url).timeout(Duration::from_secs(5));
                        if let Some(token) = &client.token {
                            request = request.header("X-Auth-Token", token);
                        }
                        request.send().await?.error_for_status()?;
                        Ok::<(), anyhow::Error>(())
                    }
                    .await;
                    if let Err(error) = result {
                        tracing::warn!(error = %error, "回收 go-judge 编译缓存失败");
                    }
                }
            });
        }
    }
}

fn parse_response(body: &str) -> Result<GoJudgeResponse> {
    if let Ok(mut responses) = serde_json::from_str::<Vec<GoJudgeResponse>>(body) {
        return responses
            .drain(..)
            .next()
            .context("go-judge 响应缺少命令结果");
    }
    if let Ok(wrapper) = serde_json::from_str::<HashMap<String, Vec<GoJudgeResponse>>>(body) {
        if let Some(mut responses) = wrapper.get("results").cloned() {
            return responses.drain(..).next().context("go-judge results 为空");
        }
    }
    anyhow::bail!("go-judge 响应格式无效")
}

#[allow(dead_code)]
pub fn command_for_case(
    language: &str,
    source: &str,
    input: &[u8],
    time_limit_ms: u64,
    memory_limit_mb: u64,
    extra_files: &HashMap<String, Vec<u8>>,
) -> Result<GoJudgeCommand> {
    command_for_case_with_filename(
        language,
        source,
        input,
        time_limit_ms,
        memory_limit_mb,
        extra_files,
        None,
    )
}

/// 构造标准输入或 Hydro 兼容文件输入的用户命令。
pub fn command_for_case_with_filename(
    language: &str,
    source: &str,
    input: &[u8],
    time_limit_ms: u64,
    memory_limit_mb: u64,
    extra_files: &HashMap<String, Vec<u8>>,
    filename: Option<&str>,
) -> Result<GoJudgeCommand> {
    let (source_name, compiler, standard) = match language {
        "c" => ("main.c", "gcc", "c99"),
        "cc" => ("main.cpp", "g++", "c++11"),
        other => anyhow::bail!("不支持的 OI 语言: {other}"),
    };
    let file_input = filename.map(file_input_name).transpose()?;
    let file_output = filename.map(file_output_name).transpose()?;
    // go-judge 的 copyIn 工作目录沿用 Hydro 的 `/w` 约定；命令只使用相对
    // 路径，避免把 Docker fallback 的 `/workspace` 路径泄漏到专用节点。
    let shell = format!(
        "{} -std={} -O2 -Wall -pipe {} -o main; compile_status=$?; if [ $compile_status -ne 0 ]; then exit 126; fi; ./main",
        compiler, standard, source_name
    );
    let mut copy_in = HashMap::new();
    for (name, content) in extra_files {
        copy_in.insert(
            name.clone(),
            GoJudgeFile::content(String::from_utf8_lossy(content).into_owned()),
        );
    }
    copy_in.insert(source_name.to_string(), GoJudgeFile::content(source));
    if let Some(name) = file_input.as_ref() {
        copy_in.insert(
            name.clone(),
            GoJudgeFile::content(String::from_utf8_lossy(input).into_owned()),
        );
    }
    let mut copy_out = Vec::new();
    if let Some(name) = file_output {
        copy_out.push(name);
    }
    Ok(GoJudgeCommand {
        args: vec!["/bin/sh".to_string(), "-c".to_string(), shell],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: vec![
            GoJudgeStdioFile::input(if file_input.is_some() {
                String::new()
            } else {
                String::from_utf8_lossy(input).into_owned()
            }),
            GoJudgeStdioFile::collector("stdout"),
            GoJudgeStdioFile::collector("stderr"),
        ],
        copy_in,
        copy_out,
        copy_out_cached: Vec::new(),
        copy_out_max: MAX_OUTPUT_BYTES as u64,
        cpu_limit_ns: time_limit_ms.saturating_mul(1_000_000),
        clock_limit_ns: time_limit_ms.saturating_mul(3_000_000),
        memory_limit_bytes: memory_limit_mb.saturating_mul(1024 * 1024),
        proc_limit: 32,
    })
}

/// 构造一次性的用户源码编译命令。编译产物通过 `copyOutCached` 返回 fileId，
/// 后续测试点只复制这个受信 fileId，不把编译时间重复计入每个测试点时限。
pub fn command_for_compile(
    language: &str,
    source: &str,
    extra_files: &HashMap<String, Vec<u8>>,
) -> Result<GoJudgeCommand> {
    let (source_name, compiler, standard) = match language {
        "c" => ("main.c", "gcc", "c99"),
        "cc" => ("main.cpp", "g++", "c++11"),
        other => anyhow::bail!("不支持的 OI 语言: {other}"),
    };
    let mut copy_in = copy_in_from_extra(extra_files);
    copy_in.insert(source_name.to_string(), GoJudgeFile::content(source));
    Ok(GoJudgeCommand {
        args: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            format!(
                "{} -std={} -O2 -Wall -pipe {} -o main",
                compiler, standard, source_name
            ),
        ],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: diagnostic_stdio(),
        copy_in,
        copy_out: Vec::new(),
        copy_out_cached: vec!["main".to_string()],
        cpu_limit_ns: COMPILE_TIMEOUT_MS * 1_000_000,
        clock_limit_ns: COMPILE_TIMEOUT_MS * 3_000_000,
        memory_limit_bytes: COMPILE_MEMORY_MB * 1024 * 1024,
        proc_limit: 32,
        copy_out_max: MAX_OUTPUT_BYTES as u64,
    })
}

/// 运行已经编译好的用户程序；题包 extra 文件仍按原路径注入。
pub fn command_for_compiled_case(
    executable_file_id: &str,
    input: &[u8],
    time_limit_ms: u64,
    memory_limit_mb: u64,
    extra_files: &HashMap<String, Vec<u8>>,
    filename: Option<&str>,
) -> Result<GoJudgeCommand> {
    let file_input = filename.map(file_input_name).transpose()?;
    let file_output = filename.map(file_output_name).transpose()?;
    let mut copy_in = copy_in_from_extra(extra_files);
    copy_in.insert("main".to_string(), GoJudgeFile::file_id(executable_file_id));
    if let Some(name) = file_input.as_ref() {
        copy_in.insert(
            name.clone(),
            GoJudgeFile::content(String::from_utf8_lossy(input).into_owned()),
        );
    }
    Ok(GoJudgeCommand {
        args: vec!["./main".to_string()],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: vec![
            GoJudgeStdioFile::input(if file_input.is_some() {
                String::new()
            } else {
                String::from_utf8_lossy(input).into_owned()
            }),
            GoJudgeStdioFile::collector("stdout"),
            GoJudgeStdioFile::collector("stderr"),
        ],
        copy_in,
        copy_out: file_output.into_iter().collect(),
        copy_out_cached: Vec::new(),
        copy_out_max: MAX_OUTPUT_BYTES as u64,
        cpu_limit_ns: time_limit_ms.saturating_mul(1_000_000),
        clock_limit_ns: time_limit_ms.saturating_mul(3_000_000),
        memory_limit_bytes: memory_limit_mb.saturating_mul(1024 * 1024),
        proc_limit: 32,
    })
}

/// 编译 testlib checker 一次并缓存其二进制；checker 编译失败属于平台 SE。
pub fn command_for_checker_compile(
    checker_source: &[u8],
    extra_files: &HashMap<String, Vec<u8>>,
) -> GoJudgeCommand {
    let mut copy_in = copy_in_from_extra(extra_files);
    copy_in.insert(
        "checker.cpp".to_string(),
        GoJudgeFile::content(String::from_utf8_lossy(checker_source).into_owned()),
    );
    GoJudgeCommand {
        args: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "g++ -std=c++11 -O2 -Wall -pipe -I . checker.cpp -o checker".to_string(),
        ],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: diagnostic_stdio(),
        copy_in,
        copy_out: Vec::new(),
        copy_out_cached: vec!["checker".to_string()],
        copy_out_max: MAX_OUTPUT_BYTES as u64,
        cpu_limit_ns: COMPILE_TIMEOUT_MS * 1_000_000,
        clock_limit_ns: COMPILE_TIMEOUT_MS * 3_000_000,
        memory_limit_bytes: COMPILE_MEMORY_MB * 1024 * 1024,
        proc_limit: 32,
    }
}

/// 在独立 go-judge sandbox 中执行缓存的 testlib checker。
pub fn command_for_compiled_checker(
    checker_file_id: &str,
    input: &[u8],
    expected: &[u8],
    actual: &[u8],
    time_limit_ms: u64,
    memory_limit_mb: u64,
    extra_files: &HashMap<String, Vec<u8>>,
) -> GoJudgeCommand {
    let mut copy_in = copy_in_from_extra(extra_files);
    copy_in.insert("checker".to_string(), GoJudgeFile::file_id(checker_file_id));
    for (name, content) in [
        ("checker.in", input),
        ("checker.ans", expected),
        ("checker.out", actual),
    ] {
        copy_in.insert(
            name.to_string(),
            GoJudgeFile::content(String::from_utf8_lossy(content).into_owned()),
        );
    }
    GoJudgeCommand {
        args: vec![
            "./checker".to_string(),
            "checker.in".to_string(),
            "checker.out".to_string(),
            "checker.ans".to_string(),
        ],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: diagnostic_stdio(),
        copy_in,
        copy_out: Vec::new(),
        copy_out_cached: Vec::new(),
        copy_out_max: MAX_OUTPUT_BYTES as u64,
        cpu_limit_ns: time_limit_ms.saturating_mul(1_000_000),
        clock_limit_ns: time_limit_ms.saturating_mul(3_000_000),
        memory_limit_bytes: memory_limit_mb.saturating_mul(1024 * 1024),
        proc_limit: 32,
    }
}

fn copy_in_from_extra(extra_files: &HashMap<String, Vec<u8>>) -> HashMap<String, GoJudgeFile> {
    extra_files
        .iter()
        .map(|(name, content)| {
            (
                name.clone(),
                GoJudgeFile::content(String::from_utf8_lossy(content).into_owned()),
            )
        })
        .collect()
}

fn diagnostic_stdio() -> Vec<GoJudgeStdioFile> {
    vec![
        GoJudgeStdioFile::input(String::new()),
        GoJudgeStdioFile::collector("stdout"),
        GoJudgeStdioFile::collector("stderr"),
    ]
}

/// 编译命令成功且返回了可复用的 sandbox fileId。
pub fn cached_file_id<'a>(response: &'a GoJudgeResponse, name: &str) -> Option<&'a str> {
    let status_ok = response
        .status
        .as_deref()
        .map(|status| status.eq_ignore_ascii_case("accepted"))
        .unwrap_or(true);
    (status_ok && response.exit_status.unwrap_or(0) == 0)
        .then(|| response.file_ids.get(name).map(String::as_str))
        .flatten()
}

fn file_input_name(filename: &str) -> Result<String> {
    validate_filename(filename)?;
    Ok(format!("{filename}.in"))
}

fn file_output_name(filename: &str) -> Result<String> {
    validate_filename(filename)?;
    Ok(format!("{filename}.out"))
}

fn validate_filename(filename: &str) -> Result<()> {
    if filename.is_empty()
        || filename.len() > 64
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        anyhow::bail!("OI filename 含非法字符")
    }
    Ok(())
}

/// 构造只运行受信 testlib checker 的命令。用户程序在另一个 go-judge
/// sandbox 中运行，checker 只接收已经捕获的用户输出，避免用户进程篡改
/// checker 源码、输入或标准答案。
#[allow(dead_code)]
pub fn command_for_testlib_checker(
    checker_source: &[u8],
    input: &[u8],
    expected: &[u8],
    actual: &[u8],
    time_limit_ms: u64,
    memory_limit_mb: u64,
    extra_files: &HashMap<String, Vec<u8>>,
) -> GoJudgeCommand {
    let mut copy_in = HashMap::new();
    for (name, content) in extra_files {
        copy_in.insert(
            name.clone(),
            GoJudgeFile::content(String::from_utf8_lossy(content).into_owned()),
        );
    }
    for (name, content) in [
        ("checker.cpp", checker_source),
        ("checker.in", input),
        ("checker.ans", expected),
        ("checker.out", actual),
    ] {
        copy_in.insert(
            name.to_string(),
            GoJudgeFile::content(String::from_utf8_lossy(content).into_owned()),
        );
    }
    GoJudgeCommand {
        args: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "g++ -std=c++11 -O2 -Wall -pipe -I . checker.cpp -o checker; compile_status=$?; if [ $compile_status -ne 0 ]; then exit 125; fi; ./checker checker.in checker.out checker.ans".to_string(),
        ],
        env: vec!["PATH=/usr/bin:/bin".to_string()],
        stdio: vec![
            GoJudgeStdioFile::input(String::new()),
            GoJudgeStdioFile::collector("stdout"),
            GoJudgeStdioFile::collector("stderr"),
        ],
        copy_in,
        copy_out: Vec::new(),
        copy_out_cached: Vec::new(),
        copy_out_max: MAX_OUTPUT_BYTES as u64,
        cpu_limit_ns: time_limit_ms.saturating_mul(1_000_000),
        clock_limit_ns: time_limit_ms.saturating_mul(3_000_000),
        memory_limit_bytes: memory_limit_mb.saturating_mul(1024 * 1024),
        proc_limit: 32,
    }
}

/// testlib checker 在独立 sandbox 中运行；退出码 1/2 表示 checker 判 WA，
/// 资源耗尽或 sandbox 错误仍由 go-judge 状态归因。
pub fn map_testlib_status(response: &GoJudgeResponse) -> OiStatus {
    if response_output_exceeded(response) {
        return OiStatus::SystemError;
    }
    if response.exit_status == Some(125) {
        return OiStatus::SystemError;
    }
    match response
        .status
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        // checker 是题目侧受信程序；它自身超时、超内存、超输出或崩溃属于
        // 平台/题包错误，不能把 checker 的资源状态归咎于选手。
        "time limit exceeded"
        | "time_limit_exceeded"
        | "tle"
        | "memory limit exceeded"
        | "memory_limit_exceeded"
        | "mle"
        | "output limit exceeded"
        | "output_limit_exceeded"
        | "ole"
        | "runtime error"
        | "runtime_error"
        | "re"
        | "signalled"
        | "format error"
        | "format_error" => OiStatus::SystemError,
        "system error" | "system_error" | "se" | "file error" | "file_error" | "internal error"
        | "internal_error" => OiStatus::SystemError,
        _ => super::testlib_verdict_from_exit(response.exit_status),
    }
}

pub fn map_status(
    response: &GoJudgeResponse,
    expected: &[u8],
    actual: &[u8],
    checker: impl Fn(&[u8], &[u8]) -> bool,
) -> OiStatus {
    if response_output_exceeded(response) {
        return OiStatus::OutputLimitExceeded;
    }
    if response.exit_status == Some(126) {
        return OiStatus::CompileError;
    }
    match response
        .status
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "time limit exceeded" | "time_limit_exceeded" | "tle" => OiStatus::TimeLimitExceeded,
        "memory limit exceeded" | "memory_limit_exceeded" | "mle" => OiStatus::MemoryLimitExceeded,
        "output limit exceeded" | "output_limit_exceeded" | "ole" => OiStatus::OutputLimitExceeded,
        "runtime error" | "runtime_error" | "re" | "signalled" => OiStatus::RuntimeError,
        "format error" | "format_error" | "presentation error" | "presentation_error" | "fe" => {
            OiStatus::FormatError
        }
        "system error" | "system_error" | "se" | "file error" | "file_error" | "internal error"
        | "internal_error" => OiStatus::SystemError,
        _ => match response.exit_status {
            Some(0) if checker(expected, actual) => OiStatus::Accepted,
            Some(0) => OiStatus::WrongAnswer,
            Some(_) => OiStatus::RuntimeError,
            None => OiStatus::SystemError,
        },
    }
}

/// go-judge 对每个 collector 设上限，但 stdout/stderr 可能同时各达到该值；
/// OI 约定的 32 MiB 是一次测试点的总诊断/输出预算，因此在响应边界再做一次
/// 聚合检查，避免两个 collector 绕过总上限。
fn response_output_exceeded(response: &GoJudgeResponse) -> bool {
    response.files.values().any(GoJudgeOutputFile::truncated)
        || response
            .files
            .values()
            .try_fold(0usize, |total, file| {
                total.checked_add(file.content().len())
            })
            .map(|total| total > MAX_OUTPUT_BYTES)
            .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_contains_fixed_limits_and_no_user_command() {
        let extra = HashMap::from([(String::from("include/extra.h"), b"#define X 1".to_vec())]);
        let command = command_for_case("cc", "int main(){}", b"1\n", 1000, 256, &extra).unwrap();
        assert_eq!(command.cpu_limit_ns, 1_000_000_000);
        assert_eq!(command.clock_limit_ns, 3_000_000_000);
        assert!(command.args.join(" ").contains("g++ -std=c++11"));
        assert!(command.args.join(" ").contains("./main"));
        assert!(!command.args.join(" ").contains("/workspace"));
        assert_eq!(command.copy_out_max, MAX_OUTPUT_BYTES as u64);
        assert!(command.copy_in.contains_key("include/extra.h"));
        assert!(!command.args.join(" ").contains("JUDGE_GO_JUDGE_URL"));
    }

    #[test]
    fn file_input_command_uses_hydro_names_and_does_not_feed_stdin() {
        let command = command_for_case_with_filename(
            "c",
            "int main(){return 0;}",
            b"1\n",
            1000,
            256,
            &HashMap::new(),
            Some("answer"),
        )
        .unwrap();
        assert!(matches!(
            &command.stdio[0],
            GoJudgeStdioFile::Input { content } if content.is_empty()
        ));
        assert!(command.copy_in.contains_key("answer.in"));
        assert!(command.copy_out.contains(&"answer.out".to_string()));
    }

    #[test]
    fn testlib_command_uses_fixed_checker_protocol() {
        let command = command_for_testlib_checker(
            b"int main(){return 0;}",
            b"1\n",
            b"1\n",
            b"1\n",
            1000,
            256,
            &HashMap::new(),
        );
        let shell = command.args.join(" ");
        assert!(shell.contains("checker.in checker.out checker.ans"));
        assert!(shell.contains("exit 125"));
        assert!(command.copy_in.contains_key("checker.cpp"));
        assert!(!command.copy_out.contains(&"checker.out".to_string()));
    }

    #[test]
    fn compile_sentinel_is_compile_error_even_with_runtime_label() {
        let response = GoJudgeResponse {
            status: Some("Runtime Error".to_string()),
            exit_status: Some(126),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert_eq!(
            map_status(&response, b"", b"", |_, _| true),
            OiStatus::CompileError
        );
    }

    #[test]
    fn incomplete_response_is_system_error() {
        let response = GoJudgeResponse {
            status: None,
            exit_status: None,
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert_eq!(
            map_status(&response, b"", b"", |_, _| true),
            OiStatus::SystemError
        );
    }

    #[test]
    fn checker_compile_sentinel_is_system_error() {
        let response = GoJudgeResponse {
            status: Some("Runtime Error".to_string()),
            exit_status: Some(125),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert_eq!(map_testlib_status(&response), OiStatus::SystemError);
    }

    #[test]
    fn testlib_status_maps_checker_exit_to_wrong_answer() {
        let mut response = GoJudgeResponse {
            status: None,
            exit_status: Some(124),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert_eq!(map_testlib_status(&response), OiStatus::SystemError);
        response.exit_status = Some(1);
        assert_eq!(map_testlib_status(&response), OiStatus::WrongAnswer);
        response.exit_status = Some(2);
        assert_eq!(map_testlib_status(&response), OiStatus::WrongAnswer);
        response.exit_status = Some(3);
        assert_eq!(map_testlib_status(&response), OiStatus::SystemError);
    }

    #[test]
    fn testlib_resource_failure_is_system_error() {
        let response = GoJudgeResponse {
            status: Some("Time Limit Exceeded".to_string()),
            exit_status: Some(-1),
            time: None,
            clock_time: None,
            memory: None,
            files: HashMap::new(),
            file_ids: HashMap::new(),
        };
        assert_eq!(map_testlib_status(&response), OiStatus::SystemError);
    }

    #[test]
    fn parses_array_response() {
        let response = parse_response(r#"[{"status":"Accepted","exitStatus":0}]"#).unwrap();
        assert_eq!(response.status.as_deref(), Some("Accepted"));
    }

    #[test]
    fn parses_copy_out_text_response() {
        let response = parse_response(
            r#"[{"status":"Accepted","exitStatus":0,"files":{"stdout":"1\n","stderr":""}}]"#,
        )
        .unwrap();
        assert_eq!(response.files["stdout"].content(), "1\n");
        assert!(!response.files["stdout"].truncated());
    }

    #[test]
    fn compile_command_uses_cached_binary_and_separate_limit() {
        let command = command_for_compile("cc", "int main(){}", &HashMap::new()).unwrap();
        assert_eq!(command.copy_out_cached, vec!["main"]);
        assert_eq!(command.cpu_limit_ns, COMPILE_TIMEOUT_MS * 1_000_000);
        assert!(command.copy_out.is_empty());
    }

    #[test]
    fn execution_command_uses_file_id_and_hydro_collectors() {
        let command =
            command_for_compiled_case("cached-main", b"1\n", 1000, 256, &HashMap::new(), None)
                .unwrap();
        assert!(matches!(
            command.copy_in.get("main"),
            Some(GoJudgeFile {
                file_id: Some(id), ..
            }) if id == "cached-main"
        ));
        assert!(matches!(
            command.stdio.as_slice(),
            [
                GoJudgeStdioFile::Input { content },
                GoJudgeStdioFile::Collector { name, .. },
                GoJudgeStdioFile::Collector { name: stderr, .. },
            ] if content == "1\n" && name == "stdout" && stderr == "stderr"
        ));
    }

    #[test]
    fn parses_runtime_time_and_cached_file_id() {
        let response = parse_response(
            r#"[{"status":"Accepted","exitStatus":0,"runTime":1234,"fileIds":{"main":"f1"}}]"#,
        )
        .unwrap();
        assert_eq!(response.clock_time, Some(1234));
        assert_eq!(cached_file_id(&response, "main"), Some("f1"));
    }
}
