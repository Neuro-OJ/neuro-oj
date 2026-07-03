//! 支持包下载模块。
//!
//! 解析 `noj-download://` URL，根据 host 分派下载方式：
//! - `noj-download://base64/` — 提取 `content` 参数，base64 解码
//! - `noj-download://s3` — 提取 `url` 参数（percent 解码），HTTP 下载
//!
//! 两种路径最终都产生 zip 字节数组供解压。

use anyhow::{bail, Context, Result};
use base64::Engine;
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};

/// 解析 `noj-download://` URL 并获取支持包字节。
///
/// 根据 URL host 分派：
/// - `base64` → 提取 `content` 参数，base64 解码
/// - `s3` → 提取 `url` 参数（percent 解码），HTTP GET 下载
///
/// 返回 (zip_bytes, checksum_sha256_opt)。
pub async fn fetch_support_package(
    download_url: &str,
    download_timeout_secs: u64,
) -> Result<(Vec<u8>, Option<String>)> {
    let url = download_url.strip_prefix("noj-download://")
        .context("不是 noj-download:// URL")?;

    // 提取 host（第一个 / 或 ? 之前的部分）
    let host_end = url.find(['/', '?'])
        .unwrap_or(url.len());
    let host = &url[..host_end];

    // 提取 query 参数
    let query = url.find('?')
        .map(|i| &url[i + 1..])
        .unwrap_or("");

    let checksum = parse_query_param(query, "checksum_sha256");

    match host {
        "base64" => {
            let content = parse_query_param(query, "content")
                .context("noj-download://base64 缺少 content 参数")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(content)
                .context("base64 解码失败")?;
            Ok((bytes, checksum))
        }
        "s3" => {
            let raw_url = parse_query_param(query, "url")
                .context("noj-download://s3 缺少 url 参数")?;
            // percent 解码
            let decoded_url = percent_decode_str(&raw_url)
                .decode_utf8()
                .context("url percent 解码失败")?;
            let bytes = http_download(&decoded_url, download_timeout_secs).await?;
            Ok((bytes, checksum))
        }
        _ => {
            bail!("未知的 noj-download:// host: {}", host);
        }
    }
}

/// HTTP GET 下载支持包。
async fn http_download(url: &str, timeout_secs: u64) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .context("创建 HTTP 客户端失败")?;

    let response = client
        .get(url)
        .send()
        .await
        .context("HTTP 下载请求失败")?;

    if !response.status().is_success() {
        bail!("HTTP 下载返回非成功状态码: {}", response.status());
    }

    let bytes = response
        .bytes()
        .await
        .context("读取 HTTP 响应体失败")?;

    Ok(bytes.to_vec())
}

/// 计算 SHA-256 校验和（十六进制）。
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// 校验 SHA-256 是否匹配。
/// 当 expected 为 None 时跳过校验。
pub fn verify_checksum(data: &[u8], expected: Option<&str>) -> Result<()> {
    if let Some(expected) = expected {
        if expected.is_empty() {
            return Ok(());
        }
        let actual = sha256_hex(data);
        if actual != expected {
            bail!(
                "SHA-256 校验和不匹配: 期望={}, 实际={}",
                expected,
                actual
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(verify_checksum(data, None).is_ok());
    }

    #[test]
    fn test_verify_checksum_empty() {
        let data = b"test data";
        assert!(verify_checksum(data, Some("")).is_ok());
    }
}
