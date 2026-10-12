# Agent Note: Judge CI 拆分并行，PR 总时长压到 5 分钟内

Status: implemented

## Problem

除 Judge Check 外，ci.yml 的所有 job 均在 2 分钟内完成，但 Judge Check 单 job
串行执行 15–21 分钟，成为 PR 的唯一关键路径。耗时构成：WASI SDK 从源码编译
libc++ 共 3 次 （构建 A、一致性构建 B、生产镜像内再一次，约 9
分钟）；`check-oi-wasi-toolchain.sh` 串行运行 debug
版验收示例，且每个示例各跑两次比对（约 8 分钟）；target 缓存恢复 + 保存约 2
分钟。

## Decision

- `judge-check` 只保留 fmt / clippy / nextest；target 缓存改为仅缓存 cargo
  注册表，依赖 sccache。
- 新增 `judge-wasi-sdk`：SDK 产物按「配方 + 补丁 +
  构建脚本」哈希缓存，命中即跳过构建；
  未命中才构建并执行不同目录一致性校验（构建是确定性的，输入不变则无需重复验证）。
- 新增 `judge-wasi-acceptance`：`check-oi-wasi-toolchain.sh` 增加分片参数 （wasi
  / standard / compat / analysis），CI 用 matrix
  并行；脚本内一对示例的两次运行改为并发。
- 新增 `judge-wasi-image`：以 Dockerfile +
  工具链输入哈希作缓存标记，输入未变则跳过镜像内构建。

## Alternatives considered

- 验收改用 `--release`：编译成本抵消收益，且需额外证明与 debug
  的确定性输出一致，未采用。
- 用 artifact 在 job 间传递 SDK：与 cache 体积相同但每次都要上传，未采用。

## Consequences

- 工具链输入未变的 PR：关键路径约 4–5 分钟；修改配方/补丁/脚本的 PR
  仍需完整构建（约 7–8 分钟），属预期。
- 缓存在 PR 分支上不可被其他分支读取，main 推送后才会预热；首次变更工具链的 PR
  一定未命中。
- job 名称新增 `Judge WASI SDK / Acceptance (shard) / Image`；仓库未设置
  required checks，无需同步。
