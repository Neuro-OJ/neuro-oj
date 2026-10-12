//! 支持包 zip 安全解压、文件批量注入与评测命令分词工具。
//! 容器生命周期管理由 `dual/` 模块（双容器 RAII）负责。

use std::io::{Read, Seek, Write};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use bollard::Docker;
use tokio::io::AsyncWriteExt;

/// 文件注入 exec 完成轮询次数与间隔（50 × 100ms = 5s 上限）。
const INJECT_POLL_ATTEMPTS: u32 = 50;
const INJECT_POLL_INTERVAL_MS: u64 = 100;

/// 容器内解包目录（注入目标）。
const INJECT_TARGET_DIR: &str = "/workspace";

/// 创建注入 exec 的本地超时。
///
/// bollard 的请求级超时（连接时传入的 120s）只包住"读到响应头"这一段，
/// 对 hijack 后的流式连接不生效；因此每个会阻塞的调用都需要自己的上限。
const INJECT_CREATE_EXEC_TIMEOUT: Duration = Duration::from_secs(10);
/// 启动注入 exec 的本地超时。
const INJECT_EXEC_START_TIMEOUT: Duration = Duration::from_secs(10);
/// 写入 tar 流的超时。
///
/// **必须存在（NOJ-A2）**：该写入发生在任何评测总超时（启动 30s / 题目
/// `time_limit_ms` / 调用级 `call_timeout_ms`）**之前**——那些时限都在
/// `run_dual_loop` 内消费，此处一旦挂起，所有超时同时失效，任务会永久占住一个
/// 评测槽位（全局 semaphore permit），`max_concurrent_judges` 次后本 worker
/// 停止消费队列。触发条件很朴素：对端停止读取 stdin（内核管道缓冲约 64KB 写满
/// 后再写即阻塞）。512MiB 上限下单次写入通常数秒完成，60s 有 10× 以上余量。
const INJECT_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// 单次 `inspect_exec` 的本地超时（轮询次数本身已有上限，但单次调用也可能挂住）。
const INJECT_INSPECT_TIMEOUT: Duration = Duration::from_secs(5);

/// tar 流内存缓冲的增长粒度。
///
/// **关键（NOJ-A1）**：`Vec<u8>` 的几何翻倍增长会让"最后一次扩容"同时持有
/// 旧缓冲与新缓冲（峰值 ≈2× 最终大小），叠加仍在内存中的 zip 条目后，512MiB
/// 上限反而变成 ≈1GiB 峰值。按固定粒度精确增长可把峰值压到
/// ≈max(tar 总量, 单条目最大值)。
const TAR_GROWTH_CHUNK: usize = 4 * 1024 * 1024;

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

/// 精确增长的 `Vec<u8>` 写入器：按 [`TAR_GROWTH_CHUNK`] 追加容量，不做几何翻倍。
///
/// 存在的唯一理由见 `TAR_GROWTH_CHUNK` 的注释：`Vec` 的默认增长策略会在扩容瞬间
/// 同时持有新旧两份缓冲，使峰值内存翻倍。
struct ChunkedVec {
    buf: Vec<u8>,
}

impl ChunkedVec {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn into_inner(self) -> Vec<u8> {
        self.buf
    }
}

impl Write for ChunkedVec {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let needed = self.buf.len().saturating_add(data.len());
        if needed > self.buf.capacity() {
            // reserve_exact 而非 reserve：只要"刚好够这一段 + 固定粒度"，
            // 避免翻倍式预留（峰值内存正是本函数要解决的问题）。
            let extra = needed
                .saturating_sub(self.buf.capacity())
                .max(TAR_GROWTH_CHUNK);
            self.buf.reserve_exact(extra);
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 从**已拥有**的 zip 条目构造 tar 流：边追加边释放条目数据。
///
/// 与 [`build_tar_archive`] 的字节输出**完全等价**（同一 `tar::Builder` 参数、
/// 同一 `Header` 设置、同一 `append_data`），但内存峰值显著更低（NOJ-A1）：
/// `build_tar_archive` 要求"全部条目 + 完整 tar"同时驻留（512MiB 解压上限下
/// 峰值 ≈1GiB）；本函数按值消费条目，每追加一条即释放该条目的数据，且 tar 缓冲
/// 按固定粒度精确增长，因此峰值回落到 ≈max(tar 总量, 单条目最大值)。
///
/// 目录条目与文件条目走同一条路径（与旧行为一致：目录由容器内 tar 解包创建，
/// 调用方负责过滤，见 `dual::inject_support_package_to_evaluator`）。
pub fn build_tar_archive_consuming(entries: Vec<ZipEntry>) -> Result<Vec<u8>> {
    let mut writer = ChunkedVec::new();
    {
        let mut builder = tar::Builder::new(&mut writer);
        for mut entry in entries {
            validate_entry_name(&entry.file_name)?;
            // 取走数据所有权：append 结束后 entry 与 data 都可立即释放，
            // 后续条目的内存峰值不再包含已写入的内容。
            let data = std::mem::take(&mut entry.data);
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, &entry.file_name, data.as_slice())
                .with_context(|| format!("写入 tar 条目失败: {}", entry.file_name))?;
            drop(data);
        }
        builder.finish().context("结束 tar 归档失败")?;
    }
    Ok(writer.into_inner())
}

/// 带超时的整块写入。
///
/// 对端停止消费时必须**失败返回**而不是无限挂起。这是 NOJ-A2 的修复点：
/// VULN-16 只给帧转发写加了 3s 上限（`dual::pipe`），批量注入这条**更大**的写
/// 路径当时没有加固，而它恰恰发生在所有评测总超时生效之前。
pub async fn write_all_with_timeout<W>(writer: &mut W, buf: &[u8], limit: Duration) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    match tokio::time::timeout(limit, writer.write_all(buf)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e).context("写入 tar 流失败"),
        Err(_) => bail!(
            "写入 tar 流超时（{}s）：对端可能已停止读取 stdin",
            limit.as_secs()
        ),
    }
}

/// 批量注入文件到容器（VULN-17）。
///
/// 用 `tar::Builder` 把所有文件一次性写入**同一个内存 tar 流**，容器内**只发起
/// 一次** `tar xf - -C /workspace` exec 解包，彻底消除 N 次串行 `docker exec`。
/// 目录条目由 tar 解包自动创建（与原先逐文件注入的语义一致）。
///
/// 注：本接口按**借用**接收内容，要求 tar 与调用方持有的数据同时驻留。持有
/// [`ZipEntry`] 的调用方应用 [`inject_zip_entries_to_container`]（NOJ-A1）。
pub async fn inject_files_to_container(
    docker: &Docker,
    container_id: &str,
    files: &[(&str, &[u8])],
) -> Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let tar_buf = build_tar_archive(files)?;
    inject_tar_to_container(docker, container_id, &tar_buf, files.len()).await
}

/// 批量注入**已解码的 zip 条目**到容器（NOJ-A1：低内存峰值版本）。
///
/// 与 [`inject_files_to_container`] 的唯一差别是 tar 流由
/// [`build_tar_archive_consuming`] 构造——按值消费条目、边写边释放，峰值内存
/// 从 ≈1GiB（512MiB 条目 + 512MiB tar）降到 ≈512MiB。适用于支持包与 artifact
/// 这两条**内容完全由提交者控制**的注入路径。
pub async fn inject_zip_entries_to_container(
    docker: &Docker,
    container_id: &str,
    entries: Vec<ZipEntry>,
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let entry_count = entries.len();
    let tar_buf = build_injection_tar(entries)?;
    inject_tar_to_container(docker, container_id, &tar_buf, entry_count).await
}

/// 注入路径**实际使用**的 tar 构造入口。
///
/// 单独抽出一层是为了让"峰值内存"回归测试测的**就是生产路径**：把本函数改回
/// 借用版（`build_tar_archive`）会让 `test_consuming_tar_path_halves_peak_memory`
/// 直接失败，而不是出现"测试测的是旁路实现、生产仍走旧路径"的假绿。
fn build_injection_tar(entries: Vec<ZipEntry>) -> Result<Vec<u8>> {
    build_tar_archive_consuming(entries)
}

/// 把已构造好的 tar 流写入容器并等待解包 exec 结束。
///
/// 每个可能阻塞的调用都有本地超时（NOJ-A2）：`create_exec` / `start_exec` /
/// 整块写入 / `shutdown` / 单次 `inspect_exec`。缺任何一处都可能让一个恶意或
/// 异常提交永久占死评测槽位。
async fn inject_tar_to_container(
    docker: &Docker,
    container_id: &str,
    tar_buf: &[u8],
    entry_count: usize,
) -> Result<()> {
    // docker exec tar xf - -C /workspace
    let exec = tokio::time::timeout(
        INJECT_CREATE_EXEC_TIMEOUT,
        docker.create_exec(
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
        ),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "创建 inject exec 超时（{}s）",
            INJECT_CREATE_EXEC_TIMEOUT.as_secs()
        )
    })?
    .context("创建 inject exec 失败")?;

    let started =
        tokio::time::timeout(INJECT_EXEC_START_TIMEOUT, docker.start_exec(&exec.id, None))
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "启动 inject exec 超时（{}s）",
                    INJECT_EXEC_START_TIMEOUT.as_secs()
                )
            })?
            .context("启动 inject exec 失败")?;

    if let bollard::exec::StartExecResults::Attached { mut input, .. } = started {
        write_all_with_timeout(&mut input, tar_buf, INJECT_WRITE_TIMEOUT).await?;
        // shutdown 同样可能阻塞（对端停读时也会挂住），必须有上限。
        match tokio::time::timeout(INJECT_WRITE_TIMEOUT, input.shutdown()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e).context("关闭 tar 流失败"),
            Err(_) => bail!(
                "关闭 tar 流超时（{}s）：对端可能已停止读取 stdin",
                INJECT_WRITE_TIMEOUT.as_secs()
            ),
        }
    }

    // 等 exec 完成（简化处理：用 inspect_exec 轮询直到退出）
    // 轮询上限 50 次 × 100ms = 5s；退出码非 0 时视为注入失败。
    for _ in 0..INJECT_POLL_ATTEMPTS {
        let inspect = tokio::time::timeout(INJECT_INSPECT_TIMEOUT, docker.inspect_exec(&exec.id))
            .await
            .map_err(|_| {
                anyhow::anyhow!(
                    "inspect inject exec 超时（{}s）",
                    INJECT_INSPECT_TIMEOUT.as_secs()
                )
            })?
            .context("查询 inject exec 状态失败")?;
        if let Some(code) = inspect.exit_code {
            if code != 0 {
                bail!("注入 {} 个条目失败（exit_code={}）", entry_count, code);
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(INJECT_POLL_INTERVAL_MS)).await;
    }
    bail!("注入 {} 个条目超时", entry_count)
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

    // ── NOJ-A1：按值消费构 tar（低内存峰值） ──

    /// 按值消费版与借用版必须**逐字节等价**（只是内存占用不同）。
    #[test]
    fn test_build_tar_archive_consuming_matches_borrowed_byte_for_byte() {
        let names = ["evaluate.py", "cases/a.txt", "cases/b.bin"];
        let payloads: [&[u8]; 3] = [b"print(1)", b"case-a", b"\x00\x01\x02"];

        let borrowed = build_tar_archive(&[
            (names[0], payloads[0]),
            (names[1], payloads[1]),
            (names[2], payloads[2]),
        ])
        .unwrap();

        let entries: Vec<ZipEntry> = (0..3)
            .map(|i| ZipEntry {
                file_name: names[i].to_string(),
                data: payloads[i].to_vec(),
                is_dir: false,
            })
            .collect();
        let consuming = build_tar_archive_consuming(entries).unwrap();

        assert_eq!(
            borrowed, consuming,
            "按值消费版必须与借用版逐字节一致（含 header/权限/校验和）"
        );
    }

    /// 消费版同样要保留注入条目名校验（不得因为"改内存策略"而丢校验）。
    #[test]
    fn test_build_tar_archive_consuming_keeps_entry_name_validation() {
        for name in ["/etc/passwd", "../escape.py", ""] {
            let entries = vec![ZipEntry {
                file_name: name.to_string(),
                data: b"x".to_vec(),
                is_dir: false,
            }];
            assert!(
                build_tar_archive_consuming(entries).is_err(),
                "非法条目名 {:?} 必须被拒绝",
                name
            );
        }
    }

    /// 测试专用计数分配器：**线程局部**统计存活/峰值字节。
    ///
    /// 用线程局部而不是全局计数，是为了不受测试进程内其他并行测试线程的分配干扰
    /// （cargo test 默认多线程跑用例，全局计数会让这个断言随机失败）。
    mod mem_probe {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::cell::Cell;

        thread_local! {
            static LIVE: Cell<usize> = const { Cell::new(0) };
            static PEAK: Cell<usize> = const { Cell::new(0) };
        }

        pub struct Counting;

        fn on_alloc(size: usize) {
            let _ = LIVE.try_with(|live| {
                let now = live.get().saturating_add(size);
                live.set(now);
                let _ = PEAK.try_with(|peak| {
                    if now > peak.get() {
                        peak.set(now);
                    }
                });
            });
        }

        fn on_dealloc(size: usize) {
            let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(size)));
        }

        unsafe impl GlobalAlloc for Counting {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                let ptr = System.alloc(layout);
                if !ptr.is_null() {
                    on_alloc(layout.size());
                }
                ptr
            }

            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                on_dealloc(layout.size());
                System.dealloc(ptr, layout);
            }

            unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
                let ptr = System.alloc_zeroed(layout);
                if !ptr.is_null() {
                    on_alloc(layout.size());
                }
                ptr
            }

            unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
                let new_ptr = System.realloc(ptr, layout, new_size);
                if !new_ptr.is_null() {
                    if new_size >= layout.size() {
                        on_alloc(new_size - layout.size());
                    } else {
                        on_dealloc(layout.size() - new_size);
                    }
                }
                new_ptr
            }
        }

        #[global_allocator]
        pub static ALLOC: Counting = Counting;

        /// 在区域内测量"峰值存活字节"（绝对量，含区域内已存在的存活对象）。
        pub fn measure_peak<R>(f: impl FnOnce() -> R) -> (R, usize) {
            let _ = PEAK.try_with(|peak| peak.set(LIVE.with(|live| live.get())));
            let out = f();
            (out, PEAK.with(|peak| peak.get()))
        }
    }

    /// **NOJ-A1 的核心回归**：按值消费路径的峰值内存必须显著低于借用路径。
    ///
    /// 语义：借用路径要求"全部条目 + 完整 tar"同时驻留（512MiB 解压上限下
    /// 峰值 ≈1GiB，两个并发任务即打到默认 `mem_limit 2g`）；按值消费路径边写边
    /// 释放条目，峰值 ≈max(tar 总量, 单条目最大值)。
    ///
    /// 该断言在"把注入路径改回借用版"时会失败——即它锁住的是真正的行为，不是常量。
    #[test]
    fn test_consuming_tar_path_halves_peak_memory() {
        const ENTRY_SIZE: usize = 1024 * 1024;
        const ENTRY_COUNT: usize = 24;

        let make_entries = || -> Vec<ZipEntry> {
            (0..ENTRY_COUNT)
                .map(|i| ZipEntry {
                    file_name: format!("cases/{i:03}.bin"),
                    data: vec![0xA5u8; ENTRY_SIZE],
                    is_dir: false,
                })
                .collect()
        };

        // 旧路径：条目全部存活 + tar 缓冲几何增长。
        let old_peak = {
            let entries = make_entries();
            let refs: Vec<(&str, &[u8])> = entries
                .iter()
                .map(|e| (e.file_name.as_str(), e.data.as_slice()))
                .collect();
            let (tar, peak) = mem_probe::measure_peak(|| build_tar_archive(&refs).unwrap());
            assert!(!tar.is_empty());
            peak
        };

        // 新路径：按值消费，边追加边释放（**生产路径**：`build_injection_tar`）。
        let new_peak = {
            let entries = make_entries();
            let (tar, peak) = mem_probe::measure_peak(|| build_injection_tar(entries).unwrap());
            assert!(!tar.is_empty());
            peak
        };

        // 实测数字进证据（`cargo test -- --nocapture`）。
        println!(
            "[NOJ-A1 峰值内存] 借用路径={} 字节，生产注入路径={} 字节，降幅={:.1}%",
            old_peak,
            new_peak,
            (1.0 - new_peak as f64 / old_peak as f64) * 100.0
        );

        assert!(
            new_peak * 4 < old_peak * 3,
            "按值消费路径的峰值内存应至少低于借用路径 25%：旧={} 字节，新={} 字节",
            old_peak,
            new_peak
        );
    }

    // ── NOJ-A2：注入写路径必须有超时（对端停读不得永久挂起） ──

    /// 永不就绪的写入器：模拟"容器侧停止读取 stdin"。
    struct StalledWriter;

    impl tokio::io::AsyncWrite for StalledWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            std::task::Poll::Pending
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// 对端停止消费时必须**失败返回**，而不是无限挂起。
    ///
    /// 反向验证：把 `write_all_with_timeout` 换成裸 `write_all` 时本用例不会通过
    /// （会永久 pending → 测试超时），这正是 NOJ-A2 的缺陷形态。
    #[tokio::test]
    async fn test_write_all_with_timeout_fails_instead_of_hanging() {
        let mut writer = StalledWriter;
        let started = std::time::Instant::now();
        let err = write_all_with_timeout(&mut writer, b"payload", Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("超时"), "实际错误: {}", err);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "应在超时上限附近立即返回，实际耗时 {:?}",
            started.elapsed()
        );
    }

    /// 正常写入路径不受超时影响（回归保护：别把超时写成恒失败）。
    #[tokio::test]
    async fn test_write_all_with_timeout_passes_through_on_healthy_writer() {
        let mut sink = Vec::new();
        write_all_with_timeout(&mut sink, b"hello", Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(sink, b"hello");
    }
}
