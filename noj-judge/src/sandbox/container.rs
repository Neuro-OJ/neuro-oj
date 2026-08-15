//! 支持包 zip 安全解压与评测命令分词工具。
//! 容器生命周期管理由 `dual/` 模块（双容器 RAII）负责。

use std::io::Read;

use anyhow::{Context, Result};

/// 解压炸弹防护：最大条目数。
pub const MAX_ZIP_ENTRIES: usize = 1000;
/// 解压炸弹防护：单文件最大大小（64MB）。
pub const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;
/// 解压炸弹防护：总解压大小（512MB）。
pub const MAX_TOTAL_SIZE: u64 = 512 * 1024 * 1024;

/// ZIP 条目：文件名 + 内容字节 + 是否为目录。
pub struct ZipEntry {
    pub file_name: String,
    pub data: Vec<u8>,
    pub is_dir: bool,
}

/// 安全解压 ZIP 到内存，返回条目列表。
///
/// 安全校验（硬编码不可配置）：
/// - 路径穿越防护：拒绝含 `..` 或 `/` 开头的条目
/// - 炸弹防护：1000 条目 / 64MB 单文件 / 512MB 总解压
/// - Overlapping entries 防护：重复文件名报错
pub fn extract_zip_entries(data: &[u8]) -> Result<Vec<ZipEntry>> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).context("打开 zip 文件失败")?;

    if archive.len() > MAX_ZIP_ENTRIES {
        anyhow::bail!(
            "ZIP 条目数 {} 超过最大限制 {}",
            archive.len(),
            MAX_ZIP_ENTRIES
        );
    }

    let mut entries = Vec::with_capacity(archive.len());
    let mut total_size: u64 = 0;
    let mut seen_paths = std::collections::HashSet::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("读取 zip 条目失败")?;
        let original_name = file.name().to_string();
        let is_dir = file.is_dir();

        // 路径穿越防护
        if original_name.split(['/', '\\']).any(|part| part == "..")
            || original_name.starts_with('/')
        {
            anyhow::bail!("ZIP 条目包含非法路径: {}", original_name);
        }

        // 目录条目：跳过文件大小校验和内容读取，直接记录
        if is_dir {
            if !seen_paths.insert(original_name.clone()) {
                anyhow::bail!("ZIP 条目重复: {}", original_name);
            }
            entries.push(ZipEntry {
                file_name: original_name,
                data: Vec::new(),
                is_dir: true,
            });
            continue;
        }

        // Overlapping entries 防护
        if !seen_paths.insert(original_name.clone()) {
            anyhow::bail!("ZIP 条目重复: {}", original_name);
        }

        // NOJ-193：解压限额以实际读取字节数为准，不信任 zip 条目声明大小。
        // take(MAX_FILE_SIZE + 1) 读到超限字节即可判定，避免预分配超大 Vec。
        let declared_size = file.size();
        let capacity = usize::try_from(declared_size.min(MAX_FILE_SIZE + 1)).unwrap_or(0);
        let mut buf = Vec::with_capacity(capacity);
        let mut limited = (&mut file).take(MAX_FILE_SIZE + 1);
        limited.read_to_end(&mut buf)?;
        drop(limited);

        if buf.len() as u64 > MAX_FILE_SIZE {
            anyhow::bail!(
                "ZIP 条目 {} 实际解压大小 {} 超过最大限制 {}",
                original_name,
                buf.len(),
                MAX_FILE_SIZE
            );
        }

        total_size = total_size.saturating_add(buf.len() as u64);
        if total_size > MAX_TOTAL_SIZE {
            anyhow::bail!(
                "ZIP 解压总大小 {} 超过最大限制 {}",
                total_size,
                MAX_TOTAL_SIZE
            );
        }

        entries.push(ZipEntry {
            file_name: original_name,
            data: buf,
            is_dir: false,
        });
    }

    Ok(entries)
}

/// 解析评测命令为字符串数组。
///
/// 简单 shell 风格分词，支持单引号和双引号。
pub fn parse_command(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';

    for c in command.chars() {
        match c {
            '\'' | '"' if !in_quote => {
                in_quote = true;
                quote_char = c;
            }
            '\'' | '"' if in_quote && c == quote_char => {
                in_quote = false;
            }
            ' ' if !in_quote => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => {
                current.push(c);
            }
        }
    }

    if !current.is_empty() {
        args.push(current);
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_command ──

    #[test]
    fn test_parse_command_simple() {
        assert_eq!(
            parse_command("python3 /tmp/evaluate.py"),
            vec!["python3", "/tmp/evaluate.py"]
        );
    }

    #[test]
    fn test_parse_command_with_quotes() {
        assert_eq!(
            parse_command("deno run --allow-read 'script.ts'"),
            vec!["deno", "run", "--allow-read", "script.ts"]
        );
    }

    #[test]
    fn test_parse_command_multi_word_quoted() {
        assert_eq!(
            parse_command("echo 'hello world' \"second arg\""),
            vec!["echo", "hello world", "second arg"]
        );
    }

    #[test]
    fn test_parse_command_single_arg() {
        assert_eq!(parse_command("python3"), vec!["python3"]);
    }

    #[test]
    fn test_parse_command_empty() {
        let result: Vec<String> = parse_command("");
        assert!(result.is_empty());
    }

    #[test]
    fn test_parse_command_extra_spaces() {
        assert_eq!(
            parse_command("  python3   /tmp/evaluate.py  "),
            vec!["python3", "/tmp/evaluate.py"]
        );
    }

    #[test]
    fn test_parse_command_nested_quotes() {
        // 嵌套引号：外层双引号保留内层单引号
        assert_eq!(
            parse_command("sh -c \"echo 'hello'\""),
            vec!["sh", "-c", "echo 'hello'"]
        );
    }
}
