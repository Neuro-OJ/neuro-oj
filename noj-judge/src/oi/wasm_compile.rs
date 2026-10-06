//! WASI 编译子进程：固定工具链、诊断截断、进程组回收与资源上限。
use super::wasm::write_extra_files;

/// 工具链或沙箱配置故障不能归因为选手 CE。
#[derive(Debug)]
pub(super) struct CompilerInfrastructureError;
impl std::fmt::Display for CompilerInfrastructureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WASI 编译基础设施不可用")
    }
}
impl std::error::Error for CompilerInfrastructureError {}
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::time::Instant;

/// 使用 worker 配置的 WASI SDK 编译器把用户源代码转换成 wasm。编译器是
/// 受信路径，源码只作为文件输入；编译过程仍由调用方放入受限 worker 线程，
/// 不会在 judge 宿主机直接运行用户生成的二进制。
/// 使用固定 WASI 编译器编译源码，并提供题包声明的编译辅助文件。
pub fn compile_source_with_files(
    language: &str,
    source: &str,
    extra_files: &HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>> {
    Ok(compile_impl(language, source, extra_files, false, None)?.module)
}

/// 生产编译可响应取消，整个编译进程组清理后才释放阶段租约。
pub(super) fn compile_cancellable(
    language: &str,
    source: &str,
    extra_files: &HashMap<String, Vec<u8>>,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Vec<u8>> {
    Ok(compile_impl(language, source, extra_files, false, cancellation)?.module)
}

pub(super) struct AnalysisCompilation {
    pub module: Vec<u8>,
    pub object: Vec<u8>,
    pub link_map: String,
    pub workspace: std::path::PathBuf,
}

pub(super) fn compile_for_analysis(
    language: &str,
    source: &str,
    extra_files: &HashMap<String, Vec<u8>>,
) -> Result<AnalysisCompilation> {
    compile_impl(language, source, extra_files, true, None)
}

fn compile_impl(
    language: &str,
    source: &str,
    extra_files: &HashMap<String, Vec<u8>>,
    analysis: bool,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
) -> Result<AnalysisCompilation> {
    anyhow::ensure!(matches!(language, "c" | "cc"), "分析语言必须是 c 或 cc");
    let tempdir = tempfile::tempdir().context("创建 WASI 编译临时目录失败")?;
    let root = tempdir.path().to_path_buf();
    let include = root.join("include/bits");
    std::fs::create_dir_all(&include).context("创建 WASI 编译临时目录失败")?;
    let source_name = if language == "c" { "main.c" } else { "main.cc" };
    let source_path = root.join(source_name);
    let output_path = root.join("main.wasm");
    write_extra_files(&root, extra_files)?;
    // 源码最后写入，避免题包声明的辅助文件覆盖本次提交的 main.c/main.cc。
    std::fs::write(&source_path, source.as_bytes()).context("写入 WASI 源码失败")?;
    if language == "cc" {
        std::fs::write(
            include.join("stdc++.h"),
            b"#include <algorithm>\n#include <array>\n#include <bitset>\n#include <cassert>\n#include <cctype>\n#include <cmath>\n#include <cstdio>\n#include <cstdlib>\n#include <cstring>\n#include <iostream>\n#include <map>\n#include <numeric>\n#include <queue>\n#include <set>\n#include <string>\n#include <unordered_map>\n#include <unordered_set>\n#include <utility>\n#include <vector>\n#include <deque>\n#include <list>\n#include <stack>\n#include <functional>\n#include <tuple>\n#include <limits>\n#include <sstream>\n#include <iomanip>\n#include <iterator>\n#include <memory>\n#include <cstdint>\n#include <stdexcept>\n#include <type_traits>\n#include <complex>\n#include <random>\n#include <chrono>\nusing namespace std;\n",
        )
        .context("写入 bits/stdc++.h 兼容头失败")?;
    }
    let settings = super::toolchain::compiler_settings().context(CompilerInfrastructureError)?;
    let compiler = if language == "c" {
        &settings.c_compiler
    } else {
        &settings.cpp_compiler
    };
    let target = std::env::var("JUDGE_WASI_TARGET").unwrap_or_else(|_| "wasm32-wasip1".to_string());
    let standard = super::standard::manifest();
    if target != standard["target"].as_str().unwrap() {
        return Err(
            anyhow::Error::new(CompilerInfrastructureError).context("WASM target 与统一标准不一致")
        );
    }
    let mut version = Command::new(compiler);
    version
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .arg("--version");
    let info = run_compiler_with_limits(&mut version, &root, cancellation)?;
    if !info.status.success()
        || !info
            .stdout
            .starts_with(standard["compiler_version"].as_str().unwrap())
    {
        return Err(
            anyhow::Error::new(CompilerInfrastructureError).context("必须使用 WASI SDK 34 编译器")
        );
    }
    let mut command = Command::new(compiler);
    command
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .arg(format!("--target={target}"))
        .arg(format!(
            "-std={}",
            standard[if language == "c" {
                "c_standard"
            } else {
                "cpp_standard"
            }]
            .as_str()
            .unwrap()
        ))
        // LLVM lld 默认按宿主 CPU 数创建线程；固定线程数避免正常 C++ 链接
        // 在高核心数节点因线程栈/地址空间超过编译配额而被误判 CE。
        .arg("-I")
        .arg(root.join("include"))
        .arg("-I")
        .arg(&root)
        .arg(&source_path)
        .arg("-o")
        .arg(&output_path);
    for flag in standard["compiler_flags"].as_array().expect("固定编译参数") {
        command.arg(
            flag.as_str()
                .unwrap()
                .replace("WORKSPACE", &root.to_string_lossy())
                .replace("SDKROOT", &settings.root.to_string_lossy()),
        );
    }
    if language == "cc" {
        // WASI SDK 的默认 libc++/libc++abi 不提供 C++ exception runtime。
        // 显式关闭异常，避免 std::function 等正常模板实例化生成缺失符号。
        for flag in standard["cpp_flags"].as_array().unwrap() {
            command.arg(flag.as_str().unwrap());
        }
    }
    command.arg(format!("--sysroot={}", settings.sysroot.display()));
    if let Ok(testlib_include) = std::env::var("JUDGE_WASI_TESTLIB_INCLUDE") {
        if !testlib_include.is_empty() {
            command.arg("-I").arg(testlib_include);
        }
    }
    if analysis {
        // 仅分析编译保留对象来源；正式编译参数不变。
        command.arg("-fno-lto").arg("-c");
        command.arg("-o").arg(root.join("main.o"));
        let output = run_compiler_with_limits(&mut command, &root, cancellation)?;
        anyhow::ensure!(
            output.status.success(),
            "WASI 分析编译失败: {}",
            output.stderr
        );
        let mut link = Command::new(compiler);
        link.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .arg(format!("--target={target}"))
            .arg(format!("--sysroot={}", settings.sysroot.display()))
            .arg("-fno-lto")
            .arg("-Wl,--threads=1")
            .arg(format!("-Wl,-Map={}", root.join("link.map").display()))
            .arg(root.join("main.o"))
            .arg("-o")
            .arg(&output_path);
        let output = run_compiler_with_limits(&mut link, &root, cancellation)?;
        anyhow::ensure!(
            output.status.success(),
            "WASI 分析链接失败: {}",
            output.stderr
        );
        return Ok(AnalysisCompilation {
            module: std::fs::read(output_path)?,
            object: std::fs::read(root.join("main.o"))?,
            link_map: std::fs::read_to_string(root.join("link.map"))?,
            workspace: root,
        });
    }
    let output = run_compiler_with_limits(&mut command, &root, cancellation)?;
    if output.status.success() {
        Ok(AnalysisCompilation {
            module: std::fs::read(&output_path).context("读取编译后的 WASM 失败")?,
            object: Vec::new(),
            link_map: String::new(),
            workspace: root,
        })
    } else {
        Err(anyhow::anyhow!("WASI 编译失败: {}", output.stderr))
    }
}

/// 编译器是宿主上的受信工具，但源码和题包辅助文件来自用户输入，仍须
/// 作为不可信子进程处理。子进程使用独立进程组、512 MiB 地址空间、10 秒
/// CPU/墙钟和有限诊断文件；超时会回收整个进程组，不能留下后台 clang。
fn run_compiler_with_limits(
    command: &mut Command,
    root: &Path,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
) -> Result<CompileOutput> {
    let stdout_path = root.join("compiler.stdout");
    let stderr_path = root.join("compiler.stderr");
    let stdout = std::fs::File::create(&stdout_path).context("创建 WASI 编译 stdout 文件失败")?;
    let stderr = std::fs::File::create(&stderr_path).context("创建 WASI 编译 stderr 文件失败")?;
    command
        .current_dir(root)
        .env("TMPDIR", root)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "linux")]
    super::compiler_fs::restrict_compiler(command, root).context(CompilerInfrastructureError)?;
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("WASI 编译器必须运行在支持 Landlock 的 Linux worker");
    configure_compiler_process(command).context(CompilerInfrastructureError)?;
    let mut child = command
        .spawn()
        .context("启动 WASI 编译器失败")
        .context(CompilerInfrastructureError)?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().context("等待 WASI 编译器失败")? {
            break status;
        }
        if cancellation.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
            kill_compiler_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("WASI 编译已取消或资源租约失效");
        }
        if started.elapsed() >= std::time::Duration::from_secs(10) {
            kill_compiler_process_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("WASI 编译超时（超过 10 秒）");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    let stderr = read_compile_diagnostic(&stderr_path)?;
    Ok(CompileOutput {
        status,
        stderr,
        stdout: read_compile_diagnostic(&stdout_path)?,
    })
}

struct CompileOutput {
    status: ExitStatus,
    stderr: String,
    stdout: String,
}

fn read_compile_diagnostic(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .context("打开 WASI 编译诊断失败")?
        .take(1024 * 1024)
        .read_to_end(&mut bytes)
        .context("读取 WASI 编译诊断失败")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(unix)]
fn configure_compiler_process(command: &mut Command) -> Result<()> {
    use std::os::unix::process::CommandExt;

    // SAFETY: pre_exec 在 exec 前的子进程中运行；这里只修改该子进程的
    // 进程组和资源上限，不触碰 worker 的其它线程或进程。
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            for (resource, limit) in [
                (libc::RLIMIT_AS, 512_u64 * 1024 * 1024),
                (libc::RLIMIT_CPU, 10_u64),
                (libc::RLIMIT_FSIZE, 64_u64 * 1024 * 1024),
            ] {
                let value = libc::rlimit {
                    rlim_cur: limit as libc::rlim_t,
                    rlim_max: limit as libc::rlim_t,
                };
                if libc::setrlimit(resource, &value) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn configure_compiler_process(_command: &mut Command) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn kill_compiler_process_group(pid: u32) {
    // 负 pid 指向由 configure_compiler_process 建立的整个进程组。
    unsafe {
        let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_compiler_process_group(_pid: u32) {}
