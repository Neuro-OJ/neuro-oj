//! 支持包 zip 安全解压、文件批量注入与评测命令分词工具。
//! 容器生命周期管理由 `dual/` 模块（双容器 RAII）负责。

use std::io::{Read, Seek};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use bollard::Docker;

/// 文件注入 exec 完成轮询次数与间隔（50 × 100ms = 5s 上限）。
const INJECT_POLL_ATTEMPTS: u32 = 50;
const INJECT_POLL_INTERVAL_MS: u64 = 100;

/// 容器内解包目录（注入目标）。
const INJECT_TARGET_DIR: &str = "/workspace";

/// 解压炸弹防护：最大条目数。
pub const MAX_ZIP_ENTRIES: usize = 1000;
/// 解压炸弹防护：单文件最大大小（64MB）。
pub const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;
/// 解压炸弹防护：总解压大小（512MB）。
pub const MAX_TOTAL_SIZE: u64 = 512 * 1024 * 1024;

/// ZIP 条目：文件名 + 内容字节 + 是否为目录。
#[derive(Debug)]
pub struct ZipEntry {
    pub file_name: String,
    pub data: Vec<u8>,
    pub is_dir: bool,
}

/// 从本地文件流式解压 ZIP 到内存条目列表。
///
/// 直接以文件作为 zip 读取源，避免先把整个 zip 读进 `Vec<u8>`。
pub fn extract_zip_entries_from_file(path: &std::path::Path) -> Result<Vec<ZipEntry>> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("打开支持包文件失败: {}", path.display()))?;
    extract_zip_entries_reader(file)
}

/// 通用 zip 读取实现：`Read + Seek` 来源均可（内存 slice / 磁盘文件）。
fn extract_zip_entries_reader<R: Read + Seek>(reader: R) -> Result<Vec<ZipEntry>> {
    extract_zip_entries_reader_with_limits(reader, MAX_ZIP_ENTRIES, MAX_FILE_SIZE, MAX_TOTAL_SIZE)
}

/// 带可配置限额的 zip 读取实现，供测试注入小限额验证边界。
fn extract_zip_entries_reader_with_limits<R: Read + Seek>(
    reader: R,
    max_entries: usize,
    max_file_size: u64,
    max_total_size: u64,
) -> Result<Vec<ZipEntry>> {
    let mut archive = zip::ZipArchive::new(reader).context("打开 zip 文件失败")?;

    if archive.len() > max_entries {
        anyhow::bail!("ZIP 条目数 {} 超过最大限制 {}", archive.len(), max_entries);
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
        // take(max_file_size + 1) 读到超限字节即可判定，避免预分配超大 Vec。
        let declared_size = file.size();
        let capacity = usize::try_from(declared_size.min(max_file_size + 1)).unwrap_or(0);
        let mut buf = Vec::with_capacity(capacity);
        let mut limited = (&mut file).take(max_file_size + 1);
        limited.read_to_end(&mut buf)?;

        if buf.len() as u64 > max_file_size {
            anyhow::bail!(
                "ZIP 条目 {} 实际解压大小 {} 超过最大限制 {}",
                original_name,
                buf.len(),
                max_file_size
            );
        }

        total_size = total_size.saturating_add(buf.len() as u64);
        if total_size > max_total_size {
            anyhow::bail!(
                "ZIP 解压总大小 {} 超过最大限制 {}",
                total_size,
                max_total_size
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

/// 校验注入条目名：必须是相对路径，拒绝绝对路径 / `..` 穿越 / NUL。
///
/// 与 zip 解压的路径穿越防护保持一致（VULN-17 要求保留该校验）。
pub fn validate_entry_name(name: &str) -> Result<()> {
    if name.is_empty() {
        bail!("注入条目名为空");
    }
    if name.contains('\0') {
        bail!("注入条目名包含 NUL 字符: {}", name.escape_debug());
    }
    if name.starts_with('/') || name.starts_with('\\') {
        bail!("注入条目名不得为绝对路径: {}", name);
    }
    if name.split(['/', '\\']).any(|part| part == "..") {
        bail!("注入条目名包含路径穿越: {}", name);
    }
    Ok(())
}

/// 把所有文件写入**同一个**内存 tar 流（VULN-17）。
///
/// 条目名与内容一一对应；单文件注入即单元素切片，行为与原先逐文件构造的
/// tar 完全等价（`tar::Header::new_gnu` + mode 0644 + 由 `append_data` 计算校验和）。
pub fn build_tar_archive(files: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    let mut tar_buf: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_buf);
        for (name, content) in files {
            validate_entry_name(name)?;
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, name, *content)
                .with_context(|| format!("写入 tar 条目失败: {}", name))?;
        }
        builder.finish().context("结束 tar 归档失败")?;
    }
    Ok(tar_buf)
}

/// 批量注入文件到容器（VULN-17）。
///
/// 用 `tar::Builder` 把所有文件一次性写入**同一个内存 tar 流**，容器内**只发起
/// 一次** `tar xf - -C /workspace` exec 解包，彻底消除 N 次串行 `docker exec`。
/// 目录条目由 tar 解包自动创建（与原先逐文件注入的语义一致）。
pub async fn inject_files_to_container(
    docker: &Docker,
    container_id: &str,
    files: &[(&str, &[u8])],
) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let tar_buf = build_tar_archive(files)?;

    // docker exec tar xf - -C /workspace
    let exec = docker
        .create_exec(
            container_id,
            bollard::models::ExecConfig {
                cmd: Some(vec![
                    "sh".to_string(),
                    "-c".to_string(),
                    format!("tar xf - -C {}", INJECT_TARGET_DIR),
                ]),
                attach_stdin: Some(true),
                attach_stdout: Some(false),
                attach_stderr: Some(false),
                ..Default::default()
            },
        )
        .await
        .context("创建 inject exec 失败")?;

    let started = docker.start_exec(&exec.id, None).await?;
    if let bollard::exec::StartExecResults::Attached { mut input, .. } = started {
        use tokio::io::AsyncWriteExt;
        input.write_all(&tar_buf).await?;
        input.shutdown().await?;
    }

    // 等 exec 完成（简化处理：用 inspect_exec 轮询直到退出）
    // 轮询上限 50 次 × 100ms = 5s；退出码非 0 时视为注入失败。
    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = docker.inspect_exec(&exec.id).await?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                bail!("注入 {} 个文件失败（exit_code={}）", files.len(), code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    bail!("注入 {} 个文件超时", files.len())
}

/// 单文件注入：批量接口的薄包装（单元素切片），行为/性能兼容。
pub async fn inject_file_to_container(
    docker: &Docker,
    container_id: &str,
    file_name: &str,
    content: &[u8],
) -> Result<()> {
    inject_files_to_container(docker, container_id, &[(file_name, content)]).await
}

/// 解析评测命令为字符串数组。
///
/// 简单 shell 风格分词，支持单引号、双引号和反斜杠转义。
pub fn parse_command(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';
    let mut escaped = false;

    for c in command.chars() {
        if escaped {
            current.push(c);
            escaped = false;
            continue;
        }

        if c == '\\' {
            escaped = true;
            continue;
        }

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

    // 保留末尾孤立的反斜杠，避免静默丢失管理员配置的命令内容。
    if escaped {
        current.push('\\');
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

    #[test]
    fn test_parse_command_escaped_quotes() {
        assert_eq!(
            parse_command("echo \"hello\\\"world\""),
            vec!["echo", "hello\"world"]
        );
    }

    #[test]
    fn test_parse_command_escaped_space() {
        assert_eq!(
            parse_command("python3 /tmp/my\\ script.py"),
            vec!["python3", "/tmp/my script.py"]
        );
    }

    #[test]
    fn test_parse_command_trailing_backslash_is_preserved() {
        assert_eq!(parse_command("echo trailing\\"), vec!["echo", "trailing\\"]);
    }

    // ── ZIP 安全解压 ──

    use std::io::Write;

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    fn push_u16(v: u16, out: &mut Vec<u8>) {
        out.extend_from_slice(&v.to_le_bytes());
    }

    fn push_u32(v: u32, out: &mut Vec<u8>) {
        out.extend_from_slice(&v.to_le_bytes());
    }

    /// 手工构造含重复文件名的 ZIP（`ZipWriter` 会拒绝写入重复名，
    /// 但恶意提交可由其他工具生成，这里模拟真实攻击输入）。
    fn make_zip_with_duplicate() -> Vec<u8> {
        let name = b"a.py";
        let contents: [&[u8]; 2] = [b"1", b"2"];
        let mut local_parts = Vec::new();
        let mut central = Vec::new();
        let mut offset = 0u32;

        for data in contents {
            let crc = crc32(data);
            let name_len = name.len() as u16;
            let size = data.len() as u32;

            let mut lh = Vec::new();
            push_u32(0x0403_4b50, &mut lh);
            push_u16(20, &mut lh);
            push_u16(0, &mut lh);
            push_u16(0, &mut lh);
            push_u16(0, &mut lh);
            push_u16(0, &mut lh);
            push_u32(crc, &mut lh);
            push_u32(size, &mut lh);
            push_u32(size, &mut lh);
            push_u16(name_len, &mut lh);
            push_u16(0, &mut lh);
            lh.extend_from_slice(name);
            local_parts.extend_from_slice(&lh);
            local_parts.extend_from_slice(data);

            let mut ch = Vec::new();
            push_u32(0x0201_4b50, &mut ch);
            push_u16(20, &mut ch);
            push_u16(20, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u32(crc, &mut ch);
            push_u32(size, &mut ch);
            push_u32(size, &mut ch);
            push_u16(name_len, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u16(0, &mut ch);
            push_u32(0, &mut ch);
            push_u32(offset, &mut ch);
            ch.extend_from_slice(name);
            central.extend_from_slice(&ch);

            offset += lh.len() as u32 + data.len() as u32;
        }

        let mut out = local_parts;
        let central_offset = out.len() as u32;
        out.extend_from_slice(&central);
        let central_size = central.len() as u32;

        push_u32(0x0605_4b50, &mut out);
        push_u16(0, &mut out);
        push_u16(0, &mut out);
        push_u16(2, &mut out);
        push_u16(2, &mut out);
        push_u32(central_size, &mut out);
        push_u32(central_offset, &mut out);
        push_u16(0, &mut out);
        out
    }

    #[test]
    fn test_extract_zip_rejects_path_traversal() {
        let bytes = make_zip(&[("../escape.py", b"x")]);
        let err =
            extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 1024, 1024)
                .unwrap_err();
        assert!(err.to_string().contains("非法路径"));
    }

    #[test]
    fn test_extract_zip_rejects_absolute_path() {
        let bytes = make_zip(&[("/etc/passwd", b"x")]);
        let err =
            extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 1024, 1024)
                .unwrap_err();
        assert!(err.to_string().contains("非法路径"));
    }

    #[test]
    fn test_extract_zip_duplicate_entries_collapsed() {
        // zip::ZipArchive 内部按文件名去重（IndexMap），重复条目会折叠为最后一个；
        // 这里验证恶意重复名输入不会导致重复处理或 panic。
        let bytes = make_zip_with_duplicate();
        let entries =
            extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 1024, 1024)
                .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name, "a.py");
        assert_eq!(entries[0].data, b"2");
    }

    #[test]
    fn test_extract_zip_rejects_too_many_entries() {
        let bytes = make_zip(&[("f0.py", b"x"), ("f1.py", b"x"), ("f2.py", b"x")]);
        let err =
            extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 2, 1024, 1024)
                .unwrap_err();
        assert!(err.to_string().contains("条目数"));
    }

    #[test]
    fn test_extract_zip_rejects_single_file_too_large() {
        let bytes = make_zip(&[("big.bin", &[0u8; 5])]);
        let err = extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 4, 1024)
            .unwrap_err();
        assert!(err.to_string().contains("实际解压大小"));
    }

    #[test]
    fn test_extract_zip_rejects_total_too_large() {
        let bytes = make_zip(&[("a.bin", &[0u8; 5]), ("b.bin", &[0u8; 5])]);
        let err = extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 1024, 8)
            .unwrap_err();
        assert!(err.to_string().contains("总大小"));
    }

    #[test]
    fn test_extract_zip_accepts_within_limits() {
        let bytes = make_zip(&[("a.py", b"x"), ("b.py", b"y")]);
        let entries =
            extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 2, 4, 8).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].file_name, "a.py");
        assert_eq!(entries[1].data, b"y");
    }

    #[test]
    fn test_extract_zip_random_bytes_never_panics() {
        // 简单确定性伪随机：对随机字节调用解压，只要求不 panic（返回 Err 可接受）。
        let mut seed = 0x1234_5678u64;
        for _ in 0..200 {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let len = (seed % 4096) as usize;
            let mut bytes = Vec::with_capacity(len);
            for _ in 0..len {
                seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                bytes.push((seed >> 32) as u8);
            }
            let _ =
                extract_zip_entries_reader_with_limits(std::io::Cursor::new(bytes), 10, 1024, 4096);
        }
    }

    // ── VULN-17：批量 tar 归档注入 ──

    /// 读取 tar 归档中的 (条目名, 内容, mode) 列表。
    fn read_tar_entries(bytes: &[u8]) -> Vec<(String, Vec<u8>, u32)> {
        let mut archive = tar::Archive::new(std::io::Cursor::new(bytes));
        let mut out = Vec::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().to_string();
            let mode = entry.header().mode().unwrap();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            out.push((path, data, mode));
        }
        out
    }

    #[test]
    fn test_build_tar_archive_entries_and_contents() {
        let archive = build_tar_archive(&[
            ("evaluate.py", b"print(1)".as_slice()),
            ("cases/a.txt", b"case-a".as_slice()),
        ])
        .unwrap();

        let entries = read_tar_entries(&archive);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "evaluate.py");
        assert_eq!(entries[0].1, b"print(1)");
        assert_eq!(entries[1].0, "cases/a.txt");
        assert_eq!(entries[1].1, b"case-a");
        for (_, _, mode) in &entries {
            assert_eq!(*mode, 0o644, "归档条目权限应为 0644");
        }
    }

    #[test]
    fn test_build_tar_archive_empty_is_valid_empty_archive() {
        let archive = build_tar_archive(&[]).unwrap();
        assert!(read_tar_entries(&archive).is_empty());
        // 空归档仍是合法 tar（1024 字节结束块）
        assert!(!archive.is_empty());
    }

    /// 单文件包装层等价：`build_tar_archive` 的单元素结果必须与原先
    /// 「逐文件构造 tar」的实现逐字节一致（行为/性能兼容）。
    #[test]
    fn test_build_tar_archive_single_file_matches_legacy_construction() {
        let name = "main.py";
        let content = b"def solve(): return 1";

        // 旧实现（VULN-17 前的 inject_file_to_container 内联逻辑）
        let mut legacy_buf: Vec<u8> = Vec::new();
        {
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            let mut builder = tar::Builder::new(&mut legacy_buf);
            builder
                .append_data(&mut header, name, &content[..])
                .unwrap();
            builder.finish().unwrap();
        }

        let batch = build_tar_archive(&[(name, content)]).unwrap();
        assert_eq!(
            batch, legacy_buf,
            "批量接口的单文件包装层必须与旧实现逐字节等价"
        );
    }

    #[test]
    fn test_build_tar_archive_rejects_absolute_path() {
        let err = build_tar_archive(&[("/etc/passwd", b"x".as_slice())]).unwrap_err();
        assert!(err.to_string().contains("绝对路径"), "实际: {}", err);
    }

    #[test]
    fn test_build_tar_archive_rejects_path_traversal() {
        for name in ["../escape.py", "a/../../b.py", "..\\win.py"] {
            let err = build_tar_archive(&[(name, b"x".as_slice())]).unwrap_err();
            assert!(
                err.to_string().contains("路径穿越"),
                "name={} 应被拒绝，实际: {}",
                name,
                err
            );
        }
    }

    #[test]
    fn test_build_tar_archive_rejects_empty_name() {
        let err = build_tar_archive(&[("", b"x".as_slice())]).unwrap_err();
        assert!(err.to_string().contains("为空"), "实际: {}", err);
    }
}
