#!/usr/bin/env python3
"""从已校验的固定来源构建 NOJ WASI SDK；开发、CI 和生产共用。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url, checksum, path):
    if path.exists() and digest(path) == checksum:
        return
    temporary = path.with_suffix(".download")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output)
    if digest(temporary) != checksum:
        temporary.unlink()
        raise RuntimeError(f"来源摘要不匹配: {url}")
    temporary.replace(path)


def components(sdk, revision):
    # 只列出固定编译参数实际可用的编译器、链接器、资源和 wasip1 sysroot。
    paths = ["bin/clang", "bin/clang++", "bin/clang-23", "bin/lld", "bin/wasm-ld",
             "bin/clang.cfg", "bin/clang++.cfg", "lib/clang/23/include",
             "lib/clang/23/lib/wasm32-unknown-wasip1",
             "share/wasi-sysroot/include/wasm32-wasip1",
             "share/wasi-sysroot/lib/wasm32-wasip1"]
    files = {}
    for name in paths:
        path = sdk / name
        candidates = sorted(path.rglob("*")) if path.is_dir() else [path]
        for item in candidates:
            if not item.is_file():
                continue
            # 模块元数据包含安装路径，C++11 不使用模块；它不是编译输入。
            if item.name.endswith(".modules.json"):
                continue
            if not item.resolve().is_relative_to(sdk.resolve()):
                raise RuntimeError(f"工具链链接越界: {item}")
            files[item.relative_to(sdk).as_posix()] = digest(item)
    if not files:
        raise RuntimeError("工具链组件清单为空")
    return {"schema_version": 1, "revision": revision, "files": files}


def build(args):
    package = Path(__file__).resolve().parent.parent / "toolchain"
    recipe = json.loads((package / "recipe.json").read_text())
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    if output.exists():
        raise RuntimeError("输出目录必须不存在，避免复用残留标准库")
    sdk_archive = cache / "wasi-sdk-34.tar.gz"
    llvm_archive = cache / "llvm-source.tar.gz"
    download(recipe["sdk_url"], recipe["sdk_sha256"], sdk_archive)
    download(f"https://codeload.github.com/llvm/llvm-project/tar.gz/{recipe['llvm_commit']}",
             recipe["llvm_sha256"], llvm_archive)
    work = args.work.resolve()
    if work.exists():
        raise RuntimeError("构建目录必须不存在，避免沿用未校验源码或配置")
    work.mkdir(parents=True)
    source = work / "llvm-project"
    with tarfile.open(llvm_archive) as archive:
        for member in archive:
            parts = Path(member.name).parts
            if len(parts) < 2 or not member.isfile():
                continue
            if parts[1] not in {"libc", "libcxx", "libcxxabi", "libunwind", "cmake", "runtimes"} and not (
                parts[1] == "llvm" and len(parts) > 2 and parts[2] == "cmake"
            ):
                continue
            relative = Path(*parts[1:])
            if ".." in relative.parts or relative.is_absolute():
                raise RuntimeError("源码归档路径非法")
            destination = source / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as content, destination.open("wb") as target:
                shutil.copyfileobj(content, target)
    for patch in recipe["patches"]:
        file = package / "patches" / patch["path"]
        if digest(file) != patch["sha256"]:
            raise RuntimeError(f"补丁摘要不一致: {file.name}")
        subprocess.run(["git", "apply", "--check", str(file)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(file)], cwd=source, check=True)
    base = work / "base-sdk"
    base.mkdir()
    subprocess.run(["tar", "-xzf", str(sdk_archive), "--strip-components=1",
                    "--no-same-owner", "-C", str(base)], check=True)
    shutil.copytree(base, output, symlinks=True)
    build_dir = work / "build"
    flags = "--target=wasm32-wasip1 -mcpu=lime1 -fPIC"
    for path, replacement in [(base, "/opt/noj-wasi-base"),
                              (source, "/usr/src/noj-wasi-v2"),
                              (build_dir, "/build/noj-wasi-v2")]:
        flags += f" -ffile-prefix-map={path}={replacement} -fdebug-prefix-map={path}={replacement}"
    environment = {**os.environ, "SOURCE_DATE_EPOCH": str(recipe["source_date_epoch"]), "LC_ALL": "C"}
    command = ["cmake", "-G", "Ninja", "-S", str(source / "runtimes"), "-B", str(build_dir),
               *recipe["cmake_args"], f"-DCMAKE_C_COMPILER={base}/bin/clang",
               f"-DCMAKE_CXX_COMPILER={base}/bin/clang++", f"-DCMAKE_AR={base}/bin/llvm-ar",
               f"-DCMAKE_RANLIB={base}/bin/llvm-ranlib", f"-DCMAKE_SYSROOT={base}/share/wasi-sysroot",
               f"-DCMAKE_STAGING_PREFIX={output}/share/wasi-sysroot",
               f"-DCMAKE_C_FLAGS={flags}", f"-DCMAKE_CXX_FLAGS={flags}"]
    subprocess.run(command, check=True, env=environment)
    subprocess.run(["cmake", "--build", str(build_dir), "--parallel", str(args.jobs)], check=True, env=environment)
    subprocess.run(["cmake", "--install", str(build_dir)], check=True, env=environment)
    actual = components(output, recipe["revision"])
    expected_file = package / "components.json"
    if args.record_manifest:
        args.record_manifest.write_text(canonical(actual) + "\n")
    else:
        expected = json.loads(expected_file.read_text())
        if actual != expected:
            differences = [p for p in set(actual["files"]) | set(expected["files"])
                           if actual["files"].get(p) != expected["files"].get(p)]
            raise RuntimeError(f"构建产物与冻结清单不一致: {differences[:10]}")
    (output / "NOJ-TOOLCHAIN.json").write_text(canonical(actual) + "\n")
    print(f"NOJ 工具链构建与校验完成: {recipe['revision']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--record-manifest", type=Path)
    options = parser.parse_args()
    if options.jobs < 1:
        parser.error("jobs 必须为正整数")
    build(options)
