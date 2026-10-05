//! Linux WASI 编译器文件系统隔离。源码不能通过 include/incbin 读取 worker 凭据。
//! 使用 Landlock ABI 3，限制读到系统工具链和显式 SDK，写仅限本次临时目录。

use anyhow::{Context, Result};
use std::fs::OpenOptions;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;

const READ: u64 = (1 << 0) | (1 << 2) | (1 << 3);
const HANDLED: u64 = (1 << 15) - 1; // ABI 3 的文件系统操作（含 REFER/TRUNCATE）
const WORK: u64 = HANDLED & !(1 << 0); // 临时目录不可执行编译产物

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}
#[repr(C, packed)]
struct PathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

/// 在 parent 中构造规则；pre_exec 只执行 async-signal-safe 的系统调用。
pub(super) fn restrict_compiler(command: &mut Command, root: &Path) -> Result<()> {
    use std::os::unix::process::CommandExt;
    // SAFETY: 查询 ABI 时不传入任何用户内存。
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<u8>(),
            0,
            1,
        )
    };
    if abi < 3 {
        anyhow::bail!("WASI 编译隔离需要 Linux Landlock ABI >= 3");
    }
    let attr = RulesetAttr {
        handled_access_fs: HANDLED,
    };
    // SAFETY: 属性结构的布局和长度符合 Linux ABI 3。
    let raw = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr,
            std::mem::size_of::<RulesetAttr>(),
            0,
        )
    };
    if raw < 0 {
        return Err(std::io::Error::last_os_error()).context("创建编译 Landlock 规则失败");
    }
    // SAFETY: 成功的 syscall 返回独占所有权的 fd。
    let ruleset = unsafe { OwnedFd::from_raw_fd(raw as i32) };
    for path in ["/usr", "/lib", "/lib64"] {
        if Path::new(path).exists() {
            add_path(&ruleset, Path::new(path), READ)?;
        }
    }
    // SDK 可以安装在 /opt；仅开放管理员显式指定的工具链目录。
    for name in [
        "JUDGE_WASI_CC",
        "JUDGE_WASI_CXX",
        "JUDGE_WASI_SYSROOT",
        "JUDGE_WASI_TESTLIB_INCLUDE",
    ] {
        if let Some(value) = std::env::var_os(name) {
            let path = std::fs::canonicalize(&value)
                .with_context(|| format!("{name} 必须指向存在的绝对工具链路径"))?;
            let directory = if path.is_file() {
                path.parent().context("工具链目录缺失")?
            } else {
                &path
            };
            // 不允许把根目录当 SDK，避免误配置撤销隔离。
            if directory == Path::new("/") {
                anyhow::bail!("{name} 不能指向根目录");
            }
            add_path(&ruleset, directory, READ)?;
            // clang 的 resource-dir 常位于 SDK 的 bin 同级 lib 中。
            if path.is_file() {
                if let Some(sdk) = directory.parent() {
                    let libraries = sdk.join("lib");
                    if libraries.is_dir() {
                        add_path(&ruleset, &libraries, READ)?;
                    }
                }
            }
        }
    }
    add_path(&ruleset, root, WORK)?;
    add_path(&ruleset, Path::new("/dev/null"), (1 << 1) | (1 << 2))?;
    // SAFETY: 子进程只设置 no_new_privs 和套用预先构造的规则，不分配内存。
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::syscall(libc::SYS_landlock_restrict_self, ruleset.as_raw_fd(), 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}

fn add_path(ruleset: &OwnedFd, path: &Path, access: u64) -> Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
        .open(path)
        .with_context(|| format!("打开编译隔离路径失败: {}", path.display()))?;
    let attr = PathAttr {
        allowed_access: access,
        parent_fd: file.as_raw_fd(),
    };
    // SAFETY: path fd 有效，packed 属性与内核规则类型 PATH_BENEATH 布局一致。
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset.as_raw_fd(),
            1,
            &attr,
            0,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error()).context("添加编译隔离路径失败");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compiler_can_write_workspace_but_cannot_read_other_temporary_files() {
        let work = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret");
        std::fs::write(&secret, "not-for-compiler").unwrap();
        let mut allowed = Command::new("/usr/bin/touch");
        allowed.arg(work.path().join("output"));
        restrict_compiler(&mut allowed, work.path()).unwrap();
        assert!(allowed.status().unwrap().success());
        let mut denied = Command::new("/usr/bin/cat");
        denied.arg(&secret);
        restrict_compiler(&mut denied, work.path()).unwrap();
        assert!(!denied.output().unwrap().status.success());
        let mut denied_write = Command::new("/usr/bin/touch");
        denied_write.arg(outside.path().join("output"));
        restrict_compiler(&mut denied_write, work.path()).unwrap();
        assert!(!denied_write.output().unwrap().status.success());
    }
}
