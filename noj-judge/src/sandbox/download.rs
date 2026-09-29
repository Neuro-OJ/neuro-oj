//! 支持包下载模块。
//!
//! 解析 `noj-download://` URL，根据 host 分派下载方式：
//! - `noj-download://base64/` — 提取 `content` 参数，base64 解码
//! - `noj-download://s3` — 提取 `url` 参数（percent 解码），HTTP 下载
//! - `noj-download://local` — 读取本地 `.zip` 文件（仅开发模式）
//!
//! 所有路径都**流式落盘**到 WorkDir 临时文件，返回文件路径供后续解压/注入，
//! 不再把整个 zip 作为 `Vec<u8>` 驻留内存。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use percent_encoding::percent_decode_str;
use reqwest::Url;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::warn;

// 与 noj-core 的 NOJ artifact 硬上限（默认 2GB）对齐。
const MAX_SUPPORT_PACKAGE_BYTES: usize = 2 * 1024 * 1024 * 1024;

/// 下载结果：本地文件路径 + URL 中携带的预期校验和。
pub struct DownloadedPackage {
    /// 支持包文件路径（zip）。
    pub path: PathBuf,
    /// 下载 URL 中携带的 checksum_sha256（可为空，由调用方执行强制校验）。
    pub checksum: Option<String>,
    /// 是否由本次下载创建的临时文件；Drop 时自动清理。
    pub cleanup: bool,
}

impl Drop for DownloadedPackage {
    fn drop(&mut self) {
        if self.cleanup {
            // Drop 中无法 await，使用同步 unlink；临时文件删除通常很快。
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// 校验 S3 下载 URL 的 Host，拦截环回地址、链路本地地址与云元数据服务器（SSRF 防御，SE-02）。
fn validate_s3_host_not_ssrf(host: &str) -> Result<()> {
    let lower_host = host.to_lowercase();
    // 拦截常见云元数据端点域名
    if lower_host == "instance-data"
        || lower_host == "metadata.google.internal"
        || lower_host.starts_with("metadata.")
        || lower_host.ends_with(".metadata.google.internal")
    {
        bail!("S3 下载目标禁止访问云元数据服务: {}", host);
    }

    // 若 host 为 IP 地址，拦截环回与链路本地/云元数据 IP
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(ipv4) => {
                if ipv4.is_loopback() {
                    bail!("S3 下载目标禁止访问环回地址: {}", ipv4);
                }
                if ipv4.is_link_local() {
                    bail!("S3 下载目标禁止访问链路本地/云元数据地址: {}", ipv4);
                }
                if ipv4.is_unspecified() || ipv4.is_broadcast() {
                    bail!("S3 下载目标非法 IP: {}", ipv4);
                }
            }
            std::net::IpAddr::V6(ipv6) => {
                if ipv6.is_loopback() {
                    bail!("S3 下载目标禁止访问环回地址: {}", ipv6);
                }
                if ipv6.is_unspecified() {
                    bail!("S3 下载目标非法 IP: {}", ipv6);
                }
            }
        }
    }
    Ok(())
}

/// 生成 WorkDir 下的唯一临时 zip 路径。
fn temp_package_path(dest_dir: &Path) -> PathBuf {
    dest_dir.join(format!("support-{}.zip", uuid::Uuid::new_v4()))
}

/// 设置临时文件权限为 0600（仅 Unix），避免其他用户读取题目支持包。
#[cfg(unix)]
async fn set_private_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await;
}

#[cfg(not(unix))]
async fn set_private_permissions(_path: &Path) {}

/// 解析 `noj-download://` URL 并**流式落盘**支持包。
///
/// 返回下载后的文件路径与 URL 中的预期校验和。调用方仍应调用
/// [`verify_checksum_file`] 做完整性校验；本函数只负责把内容写入磁盘，
/// 避免整包驻留内存。
pub async fn fetch_support_package_to_path(
    download_url: &str,
    dest_dir: &Path,
    download_timeout_secs: u64,
    allow_http_s3: bool,
) -> Result<DownloadedPackage> {
    let ParsedDownloadUrl {
        host,
        query,
        checksum,
    } = parse_download_url(download_url)?;

    tokio::fs::create_dir_all(dest_dir)
        .await
        .context("创建支持包临时目录失败")?;

    match host.as_str() {
        "base64" => {
            let content = parse_query_param(&query, "content")
                .context("noj-download://base64 缺少 content 参数")?;
            let estimated_len = content.len().div_ceil(4).saturating_mul(3);
            if estimated_len > MAX_SUPPORT_PACKAGE_BYTES {
                bail!("支持包大小超过上限 {}", MAX_SUPPORT_PACKAGE_BYTES);
            }

            let path = temp_package_path(dest_dir);
            let write_path = path.clone();
            let spawn = tokio::task::spawn_blocking(move || -> Result<u64> {
                // 流式 base64 解码：避免先 decode 成完整 Vec 再写盘。
                let mut decoder = base64::read::DecoderReader::new(
                    content.as_bytes(),
                    &base64::engine::general_purpose::STANDARD,
                );
                let mut file =
                    std::fs::File::create(&write_path).context("创建 base64 临时文件失败")?;
                let mut total: u64 = 0;
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = decoder.read(&mut buf).context("base64 流式解码失败")?;
                    if n == 0 {
                        break;
                    }
                    total = total.saturating_add(n as u64);
                    if total > MAX_SUPPORT_PACKAGE_BYTES as u64 {
                        bail!("支持包大小超过上限 {}", MAX_SUPPORT_PACKAGE_BYTES);
                    }
                    file.write_all(&buf[..n])
                        .context("写入 base64 临时文件失败")?;
                }
                file.sync_all().context("同步 base64 临时文件失败")?;
                Ok(total)
            })
            .await;

            let total = match spawn {
                Ok(Ok(total)) => total,
                Ok(Err(e)) => {
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(e);
                }
                Err(e) => {
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(e).context("base64 流式落盘任务失败");
                }
            };

            if total > MAX_SUPPORT_PACKAGE_BYTES as u64 {
                let _ = tokio::fs::remove_file(&path).await;
                bail!("支持包大小超过上限 {}", MAX_SUPPORT_PACKAGE_BYTES);
            }
            set_private_permissions(&path).await;
            Ok(DownloadedPackage {
                path,
                checksum,
                cleanup: true,
            })
        }
        "s3" => {
            let raw_url =
                parse_query_param(&query, "url").context("noj-download://s3 缺少 url 参数")?;
            // percent 解码
            let decoded_url = percent_decode_str(&raw_url)
                .decode_utf8()
                .context("url percent 解码失败")?;
            // NOJ-194：默认仅允许 HTTPS 下载 URL，拒绝 http 明文降级。
            // 自建 MinIO 内网走 HTTP 时可通过 JUDGE_ALLOW_HTTP_S3=true 显式放行。
            if !allow_http_s3 && !decoded_url.starts_with("https://") {
                bail!("S3 下载 URL 必须使用 HTTPS: {}", redact_url(&decoded_url));
            }

            // SE-02：SSRF 防御——校验 S3 Host，拦截云元数据服务、环回地址与未授权私有地址。
            let parsed_url = Url::parse(&decoded_url).context("无效的 S3 下载 URL")?;
            if let Some(host_str) = parsed_url.host_str() {
                validate_s3_host_not_ssrf(host_str)?;
            }

            let path = temp_package_path(dest_dir);
            if let Err(e) = http_download_to_file(&decoded_url, &path, download_timeout_secs).await
            {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(e);
            }
            set_private_permissions(&path).await;
            Ok(DownloadedPackage {
                path,
                checksum,
                cleanup: true,
            })
        }
        "local" => {
            // SE-01：生产环境严格禁止使用 noj-download://local 协议直接读取本地文件。
            let allow_local = std::env::var("JUDGE_ALLOW_LOCAL_DOWNLOAD")
                .map(|v| v.trim() == "true" || v.trim() == "1")
                .unwrap_or(false);
            if !allow_local && !cfg!(test) {
                bail!("生产环境禁止使用 noj-download://local 协议");
            }

            let raw_path =
                parse_query_param(&query, "path").context("noj-download://local 缺少 path 参数")?;
            let path = percent_decode_str(&raw_path)
                .decode_utf8()
                .context("path percent 解码失败")?;
            // 本地开发模式：仅允许绝对路径的 .zip 文件，拒绝路径穿越，避免消息被篡改后任意读文件。
            let path_ref = Path::new(path.as_ref());
            if !path_ref.is_absolute() || !path.ends_with(".zip") || path.contains("..") {
                bail!("local 下载路径非法: {}", redact_url(&path));
            }

            // VULN-22：保留协议（不禁用），但在执行本地文件复制**之前**显式告警。
            // 该协议绕过了对象存储鉴权直接读取底层文件系统，生产环境出现即为异常。
            warn!(
                "【安全风险告警】检测到使用 noj-download://local 协议直接读取本地文件！\
                 该协议绕过对象存储鉴权直接访问底层文件系统，存在宿主机文件泄露与未授权\
                 读取风险，仅允许在受信任的本地开发或集成测试环境中使用。若在生产环境\
                 出现请立即排查任务来源！目标路径（已脱敏）={}",
                redact_local_path(&path)
            );

            let dest = temp_package_path(dest_dir);
            if let Err(e) = copy_local_to_file(path_ref, &dest).await {
                let _ = tokio::fs::remove_file(&dest).await;
                return Err(e);
            }
            set_private_permissions(&dest).await;
            Ok(DownloadedPackage {
                path: dest,
                checksum,
                cleanup: true,
            })
        }
        _ => {
            bail!("未知的 noj-download:// host: {}", host);
        }
    }
}

/// 日志脱敏：避免把 presigned URL 中的签名 query 完整打进日志。
fn redact_url(url: &str) -> String {
    match url.find('?') {
        Some(idx) => format!("{}?...", &url[..idx]),
        None => url.to_string(),
    }
}

/// 本地路径脱敏（VULN-22）：只保留末段文件名，隐藏宿主机目录结构。
///
/// 告警日志需要可定位（文件名/条目名），但不得泄露部署路径（如
/// `/srv/noj-prod/data/storage/...` 会暴露基础设施布局）。
fn redact_local_path(path: &str) -> String {
    let file_name = path
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path);
    let depth = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1);
    format!("<{} 级目录已脱敏>/{}", depth, file_name)
}

/// HTTPS GET 下载支持包并流式写入目标文件。
async fn http_download_to_file(url: &str, dest: &Path, timeout_secs: u64) -> Result<()> {
    // NOJ-194：禁止跟随重定向（重定向可被用于 HTTP 降级/内网 SSRF）。
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .context("创建 HTTP 客户端失败")?;

    let mut response = client.get(url).send().await.context("HTTP 下载请求失败")?;
    if response.status().is_redirection() {
        bail!("S3 下载重定向被拒绝: {}", response.status());
    }

    if !response.status().is_success() {
        bail!("HTTP 下载返回非成功状态码: {}", response.status());
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .context("创建 HTTP 临时文件失败")?;
    let mut total: u64 = 0;
    // 使用 chunk 而非 bytes()：每个网络分片直接写盘，不累积整包内存。
    while let Some(chunk) = response.chunk().await.context("读取 HTTP 响应体失败")? {
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_SUPPORT_PACKAGE_BYTES as u64 {
            bail!("支持包大小超过上限 {}", MAX_SUPPORT_PACKAGE_BYTES);
        }
        file.write_all(&chunk)
            .await
            .context("写入 HTTP 临时文件失败")?;
    }
    file.sync_all().await.context("同步 HTTP 临时文件失败")?;
    Ok(())
}

/// 把本地 zip 流式复制到目标临时文件，并限制最大大小。
async fn copy_local_to_file(src: &Path, dest: &Path) -> Result<()> {
    let src_file = tokio::fs::File::open(src)
        .await
        .with_context(|| format!("读取 local 文件失败: {}", src.display()))?;
    let mut dest_file = tokio::fs::File::create(dest)
        .await
        .context("创建 local 临时文件失败")?;

    // 最多读 MAX+1 字节即可判定超限，无需先读取完整文件。
    let mut limited = src_file.take(MAX_SUPPORT_PACKAGE_BYTES as u64 + 1);
    let copied = tokio::io::copy(&mut limited, &mut dest_file)
        .await
        .context("复制 local 文件失败")?;
    if copied > MAX_SUPPORT_PACKAGE_BYTES as u64 {
        bail!("支持包大小超过上限 {}", MAX_SUPPORT_PACKAGE_BYTES);
    }
    dest_file
        .sync_all()
        .await
        .context("同步 local 临时文件失败")?;
    Ok(())
}

/// 计算文件 SHA-256 校验和（十六进制），流式读取，不整包载入内存。
pub async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("打开文件计算 SHA-256 失败: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .with_context(|| format!("读取文件计算 SHA-256 失败: {}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 校验文件 SHA-256 是否与期望值一致。
pub async fn verify_checksum_file(path: &Path, expected: Option<&str>) -> Result<()> {
    let expected = expected.ok_or_else(|| anyhow::anyhow!("缺少 checksum_sha256，拒绝下载内容"))?;
    if expected.is_empty() {
        bail!("checksum_sha256 为空，拒绝下载内容");
    }
    let actual = sha256_file(path).await?;
    if actual != expected {
        bail!("SHA-256 校验和不匹配: 期望={}, 实际={}", expected, actual);
    }
    Ok(())
}

/// 计算 SHA-256 校验和（十六进制，仅测试使用；生产请用 [`sha256_file`]）。
#[cfg(test)]
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// 校验 SHA-256 是否匹配（仅测试使用；生产请用 [`verify_checksum_file`]）。
/// 当 expected 为 None 或空时拒绝（不允许跳过完整性校验）。
#[cfg(test)]
pub fn verify_checksum(data: &[u8], expected: Option<&str>) -> Result<()> {
    let expected = expected.ok_or_else(|| anyhow::anyhow!("缺少 checksum_sha256，拒绝下载内容"))?;
    if expected.is_empty() {
        bail!("checksum_sha256 为空，拒绝下载内容");
    }
    let actual = sha256_hex(data);
    if actual != expected {
        bail!("SHA-256 校验和不匹配: 期望={}, 实际={}", expected, actual);
    }
    Ok(())
}

/// 从 URL query 字符串中提取参数值。
fn parse_query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next()?;
        if key == name {
            return parts.next().map(|v| v.to_string());
        }
    }
    None
}

pub fn extract_checksum(download_url: &str) -> Result<Option<String>> {
    Ok(parse_download_url(download_url)?.checksum)
}

struct ParsedDownloadUrl {
    host: String,
    query: String,
    checksum: Option<String>,
}

fn parse_download_url(download_url: &str) -> Result<ParsedDownloadUrl> {
    let url = download_url
        .strip_prefix("noj-download://")
        .context("不是 noj-download:// URL")?;

    let host_end = url.find(['/', '?']).unwrap_or(url.len());
    let host = url[..host_end].to_string();
    let query = url
        .find('?')
        .map(|i| url[i + 1..].to_string())
        .unwrap_or_default();
    let checksum = parse_query_param(&query, "checksum_sha256");

    Ok(ParsedDownloadUrl {
        host,
        query,
        checksum,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn test_parse_query_param() {
        let query = "content=UEsDBBQAAAAI&checksum_sha256=abc123";
        assert_eq!(
            parse_query_param(query, "content"),
            Some("UEsDBBQAAAAI".to_string())
        );
        assert_eq!(
            parse_query_param(query, "checksum_sha256"),
            Some("abc123".to_string())
        );
        assert_eq!(parse_query_param(query, "nonexistent"), None);
    }

    #[test]
    fn test_sha256_hex() {
        let data = b"hello";
        let hex = sha256_hex(data);
        // known SHA-256 of "hello"
        assert_eq!(
            hex,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_verify_checksum_match() {
        let data = b"test data";
        let hex = sha256_hex(data);
        assert!(verify_checksum(data, Some(&hex)).is_ok());
    }

    #[test]
    fn test_verify_checksum_mismatch() {
        let data = b"test data";
        assert!(verify_checksum(data, Some("wronghash")).is_err());
    }

    #[test]
    fn test_verify_checksum_none() {
        let data = b"test data";
        assert!(verify_checksum(data, None).is_err());
    }

    #[test]
    fn test_verify_checksum_empty() {
        let data = b"test data";
        assert!(verify_checksum(data, Some("")).is_err());
    }

    #[test]
    fn test_extract_checksum() {
        let checksum = extract_checksum(
            "noj-download://s3?url=http%3A%2F%2Fexample.com%2Fpkg.zip&checksum_sha256=abc123",
        )
        .unwrap();
        assert_eq!(checksum, Some("abc123".to_string()));
    }

    #[test]
    fn test_parse_download_url_base64() {
        let parsed = parse_download_url(
            "noj-download://base64/?content=UEsDBBQAAAAI&checksum_sha256=def456",
        )
        .unwrap();
        assert_eq!(parsed.host, "base64");
        assert!(parsed.query.contains("content=UEsDBBQAAAAI"));
        assert!(parsed.query.contains("checksum_sha256=def456"));
        assert_eq!(parsed.checksum, Some("def456".to_string()));
    }

    #[test]
    fn test_parse_download_url_s3() {
        let parsed = parse_download_url(
            "noj-download://s3?url=http%3A%2F%2Fbucket.s3.amazonaws.com%2Fpkg.zip",
        )
        .unwrap();
        assert_eq!(parsed.host, "s3");
        assert_eq!(parsed.checksum, None);
    }

    #[test]
    fn test_parse_download_url_no_checksum() {
        let parsed = parse_download_url("noj-download://base64/?content=UEsDBBQAAAAI").unwrap();
        assert_eq!(parsed.host, "base64");
        assert_eq!(parsed.checksum, None);
    }

    #[test]
    fn test_parse_download_url_invalid_prefix() {
        assert!(parse_download_url("http://example.com/package.zip").is_err());
        assert!(parse_download_url("invalid-url").is_err());
    }

    #[test]
    fn test_parse_download_url_host_without_query() {
        let parsed = parse_download_url("noj-download://base64/").unwrap();
        assert_eq!(parsed.host, "base64");
        assert_eq!(parsed.query, "");
    }

    #[tokio::test]
    async fn test_fetch_support_package_to_path_valid_base64() {
        let tmp = tempfile::tempdir().unwrap();
        // 创建一个合法的 base64 内容（解码后 = "hello"）
        let content = base64::engine::general_purpose::STANDARD.encode(b"hello");
        let url = format!("noj-download://base64/?content={}", content);
        let result = fetch_support_package_to_path(&url, tmp.path(), 5, false).await;
        assert!(result.is_ok());
        let pkg = result.unwrap();
        let bytes = tokio::fs::read(&pkg.path).await.unwrap();
        assert_eq!(bytes, b"hello");
        assert_eq!(pkg.checksum, None);
        assert!(pkg.cleanup);
    }

    #[tokio::test]
    async fn test_fetch_support_package_to_path_unknown_host() {
        let tmp = tempfile::tempdir().unwrap();
        let result =
            fetch_support_package_to_path("noj-download://unknown/", tmp.path(), 5, false).await;
        assert!(result.is_err());
        let err = format!("{}", result.err().unwrap());
        assert!(err.contains("未知"));
        assert!(err.contains("host"));
    }

    #[tokio::test]
    async fn test_fetch_support_package_to_path_missing_content() {
        let tmp = tempfile::tempdir().unwrap();
        let result =
            fetch_support_package_to_path("noj-download://base64/", tmp.path(), 5, false).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_verify_checksum_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("data.bin");
        tokio::fs::write(&path, b"hello").await.unwrap();
        let hex = sha256_file(&path).await.unwrap();
        assert_eq!(
            hex,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert!(verify_checksum_file(&path, Some(&hex)).await.is_ok());
        assert!(verify_checksum_file(&path, Some("bad")).await.is_err());
        assert!(verify_checksum_file(&path, None).await.is_err());
    }

    // ── VULN-22：local 协议告警 + 路径脱敏 ──

    /// 脱敏后不得泄露宿主机目录结构，但保留文件名（可定位）。
    #[test]
    fn test_redact_local_path_hides_host_directories() {
        let redacted = redact_local_path("/srv/noj-prod/data/storage/problems/1001/pkg.zip");
        assert!(redacted.ends_with("pkg.zip"), "应保留文件名: {}", redacted);
        for leaked in ["srv", "noj-prod", "storage", "problems", "1001"] {
            assert!(
                !redacted.contains(leaked),
                "脱敏后不应包含宿主目录 {}: {}",
                leaked,
                redacted
            );
        }

        // 单层路径（如 /pkg.zip）也不 panic
        assert!(redact_local_path("/pkg.zip").ends_with("pkg.zip"));
        assert_eq!(redact_local_path("pkg.zip"), "<0 级目录已脱敏>/pkg.zip");
    }

    /// 协议保留：local 协议在告警之后仍能正常复制文件（不禁用）。
    #[tokio::test]
    async fn test_local_protocol_still_copies_file_after_warning() {
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("support.zip");
        tokio::fs::write(&src, b"PK\x03\x04payload").await.unwrap();

        let dest_dir = tempfile::tempdir().unwrap();
        let url = format!(
            "noj-download://local?path={}&checksum_sha256={}",
            src.to_string_lossy().replace('/', "%2F"),
            sha256_hex(b"PK\x03\x04payload")
        );
        let pkg = fetch_support_package_to_path(&url, dest_dir.path(), 5, false)
            .await
            .expect("local 协议应保留可用");
        let copied = tokio::fs::read(&pkg.path).await.unwrap();
        assert_eq!(copied, b"PK\x03\x04payload");
        assert!(pkg.cleanup);
    }

    #[test]
    fn test_validate_s3_host_not_ssrf() {
        // 环回与未指定
        assert!(validate_s3_host_not_ssrf("127.0.0.1").is_err());
        assert!(validate_s3_host_not_ssrf("127.0.1.1").is_err());
        assert!(validate_s3_host_not_ssrf("::1").is_err());
        assert!(validate_s3_host_not_ssrf("0.0.0.0").is_err());

        // 云元数据 IMDS (169.254.169.254 & 链路本地)
        assert!(validate_s3_host_not_ssrf("169.254.169.254").is_err());
        assert!(validate_s3_host_not_ssrf("169.254.1.1").is_err());
        assert!(validate_s3_host_not_ssrf("instance-data").is_err());
        assert!(validate_s3_host_not_ssrf("metadata.google.internal").is_err());
        assert!(validate_s3_host_not_ssrf("metadata.aliyun.com").is_err());

        // 合法公网/对象存储域名放行
        assert!(validate_s3_host_not_ssrf("s3.amazonaws.com").is_ok());
        assert!(validate_s3_host_not_ssrf("oss-cn-hangzhou.aliyuncs.com").is_ok());
        assert!(validate_s3_host_not_ssrf("minio.internal.lan").is_ok());
    }
}
