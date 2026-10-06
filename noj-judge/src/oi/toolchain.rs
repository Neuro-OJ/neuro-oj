//! 固定 WASI 工具链身份校验。启动时验内容，编译时固定目录与组件清单。
use anyhow::{Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(super) struct CompilerSettings {
    pub c_compiler: PathBuf,
    pub cpp_compiler: PathBuf,
    pub sysroot: PathBuf,
    pub root: PathBuf,
}

pub(super) fn expected_components() -> Value {
    serde_json::from_str(include_str!("../../toolchain/components.json"))
        .expect("内置工具链清单必须合法")
}

/// SDK 路径是启动配置，生产镜像中由 root 提供且对 Worker 只读。
pub(super) fn compiler_settings() -> Result<CompilerSettings> {
    let target = std::env::var("JUDGE_WASI_TARGET").unwrap_or_else(|_| "wasm32-wasip1".into());
    anyhow::ensure!(
        target == super::standard::manifest()["target"].as_str().unwrap(),
        "WASI target 与内置标准不匹配"
    );
    let cc = PathBuf::from(
        std::env::var("JUDGE_WASI_CC").unwrap_or_else(|_| "/opt/wasi-sdk/bin/clang".into()),
    );
    let cxx = PathBuf::from(
        std::env::var("JUDGE_WASI_CXX").unwrap_or_else(|_| "/opt/wasi-sdk/bin/clang++".into()),
    );
    anyhow::ensure!(
        cc.is_absolute() && cxx.is_absolute(),
        "WASI 编译器必须为绝对路径"
    );
    anyhow::ensure!(
        cc.file_name().is_some_and(|name| name == "clang"),
        "WASI C 编译器路径必须指向固定 clang"
    );
    anyhow::ensure!(
        cxx.file_name().is_some_and(|name| name == "clang++"),
        "WASI C++ 编译器路径必须指向固定 clang++"
    );
    let bin = cc.parent().context("WASI 编译器目录缺失")?.canonicalize()?;
    anyhow::ensure!(
        cxx.parent()
            .context("WASI C++ 编译器目录缺失")?
            .canonicalize()?
            == bin,
        "WASI C/C++ 编译器必须来自同一 SDK"
    );
    let root = bin.parent().context("WASI SDK 根目录缺失")?.to_path_buf();
    anyhow::ensure!(
        bin.file_name().is_some_and(|name| name == "bin"),
        "WASI 编译器目录不匹配"
    );
    let sysroot = std::env::var_os("JUDGE_WASI_SYSROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("share/wasi-sysroot"))
        .canonicalize()?;
    anyhow::ensure!(
        sysroot == root.join("share/wasi-sysroot").canonicalize()?,
        "WASI sysroot 与 SDK 不匹配"
    );
    let marker: Value = serde_json::from_slice(
        &std::fs::read(root.join("NOJ-TOOLCHAIN.json"))
            .context("缺少 NOJ 工具链清单；请安装修补后的固定 SDK")?,
    )?;
    anyhow::ensure!(
        marker == expected_components(),
        "NOJ 工具链清单与内置标准不匹配"
    );
    Ok(CompilerSettings {
        c_compiler: bin.join("clang"),
        cpp_compiler: bin.join("clang++"),
        sysroot,
        root,
    })
}

fn verify_files(root: &Path, files: &serde_json::Map<String, Value>) -> Result<()> {
    let mut buffer = vec![0_u8; 1024 * 1024];
    for (relative, expected) in files {
        let path = Path::new(relative);
        anyhow::ensure!(
            path.components()
                .all(|part| matches!(part, Component::Normal(_))),
            "工具链清单路径非法"
        );
        let path = root
            .join(path)
            .canonicalize()
            .with_context(|| format!("工具链组件缺失: {relative}"))?;
        anyhow::ensure!(path.starts_with(root), "工具链组件链接越界: {relative}");
        let mut file = std::fs::File::open(path)?;
        let mut digest = Sha256::new();
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        anyhow::ensure!(
            expected.as_str() == Some(&format!("{:x}", digest.finalize())),
            "工具链组件摘要不匹配: {relative}"
        );
    }
    Ok(())
}

/// 完整校验真实编译器、标准库、头文件与链接器；不新增进程内配置缓存。
pub fn validate_configured_toolchain() -> Result<()> {
    let settings = compiler_settings()?;
    let expected = expected_components();
    let standard = super::standard::manifest();
    anyhow::ensure!(
        standard["toolchain_components_sha256"].as_str()
            == Some(&super::standard::hash(
                super::standard::canonical_json(&expected).as_bytes()
            )),
        "内置工具链摘要与计量标准不匹配"
    );
    verify_files(
        &settings.root,
        expected["files"]
            .as_object()
            .context("工具链组件清单缺失")?,
    )
}

/// 未配置 WASI 的原生专用 Worker 保持原有启动方式；错误 SDK 配置必须启动失败。
pub fn validate_at_startup() -> Result<()> {
    if [
        "JUDGE_WASI_CC",
        "JUDGE_WASI_CXX",
        "JUDGE_WASI_SYSROOT",
        "JUDGE_WASI_TARGET",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
    {
        validate_configured_toolchain().context("NOJ WASI 工具链启动校验失败")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_modified_missing_and_escaping_components() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("library.a"), b"fixed").unwrap();
        let mut files = serde_json::Map::new();
        files.insert(
            "library.a".into(),
            Value::String(super::super::standard::hash(b"fixed")),
        );
        verify_files(&root, &files).unwrap();
        std::fs::write(root.join("library.a"), b"modified").unwrap();
        assert!(verify_files(&root, &files).is_err());
        std::fs::remove_file(root.join("library.a")).unwrap();
        assert!(verify_files(&root, &files).is_err());
        files.clear();
        files.insert("../secret".into(), Value::String("a".repeat(64)));
        assert!(verify_files(&root, &files).is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::NamedTempFile::new().unwrap();
            std::os::unix::fs::symlink(outside.path(), root.join("alias")).unwrap();
            files.clear();
            files.insert(
                "alias".into(),
                Value::String(super::super::standard::hash(b"")),
            );
            assert!(verify_files(&root, &files).is_err());
        }
    }
}
