# Agent Note: Judge CI 拆分并行，PR 总时长压到 5 分钟内

Status: implemented

## Problem

初始 Judge Check 单 job 串行执行 15–21 分钟，成为 PR 的关键路径。耗时构成：WASI
SDK 从源码编译 libc++ 共 3 次 （构建 A、一致性构建 B、生产镜像内再一次，约 9
分钟）；`check-oi-wasi-toolchain.sh` 串行运行 debug
版验收示例，且每个示例各跑两次比对（约 8 分钟）；target 缓存恢复 + 保存约 2
分钟。

拆分后的运行 `38402958288` 中，CI 实际执行约 3 分 32 秒，但旧运行取消期间等待 9
分 43 秒。E2E 运行 `38402958291` 的沙箱 job 实际执行 6 分 23 秒：整个 target
缓存恢复 98 秒，测试 163 秒，其中 AI 镜像构建/导入 76 秒串在双容器组之后。
sccache 的变量只设置在安装 action 上，后续 cargo 没有启用编译缓存。

## Decision

- `judge-check` 只保留 fmt / clippy / nextest；target 缓存改为仅缓存 cargo
  注册表，依赖 sccache。
- 新增 `judge-wasi-sdk`：SDK 产物按「配方 + 补丁 +
  构建脚本」哈希缓存，命中即跳过构建；
  未命中才构建并执行不同目录一致性校验（构建是确定性的，输入不变则无需重复验证）。
- 新增 `judge-wasi-acceptance`：`check-oi-wasi-toolchain.sh` 增加分片参数 （wasi
  / standard / compat / analysis），CI 用 matrix
  并行；脚本内一对示例的两次运行改为并发。
- WASI 验收在 CI 中仅优化依赖（`profile.dev.package."*".opt-level=3`），
  工作区仍使用 dev 配置；直接执行编译出的示例，不让 cargo 重建为默认依赖配置。
- 新增 `judge-wasi-image`：以 Dockerfile +
  工具链输入哈希作缓存标记，输入未变则跳过镜像内构建。
- 沙箱 E2E 只缓存 Cargo 注册表，sccache 变量设置在 job env，所有 cargo
  步骤共享。 AI 镜像构建/导入独立作为第四组，创建 dual
  标签容器的测试仍在同组串行执行。
- 沙箱 Redis 映射为宿主机 `6380` 到容器 `6379`；测试命令使用 `--locked`。
  失败诊断只上传日志，避免传输数 GiB 的 `target/deps`。
- Python 调度回归测试执行 workflow 中的真实 shell，验证全部 `e2e_*.rs`
  均被运行， 以及四个并行组各自的失败都会使 job 失败。
- 浏览器的 Nuxt 构建在 `e2e-ui-build` 中与评测栈镜像并行，产物以 tar 分发，
  保留隐藏文件和依赖链接；浏览器测试加载同次运行的产物后启动 SSR。 Domain E2E
  通过 `deno task test:domain` 调用现有脚本。

- 第二轮提速保留全部执行目标：WASI 分片只链接自身示例，沙箱只预编译
  `e2e_*.rs`；编译与 OI 镜像构建并行，镜像加载与基础设施启动并行。
  回归测试验证并行步骤实际重叠、各步骤失败传播和冻结快照不一致仍阻断验收。
- Core 镜像不再传入每次运行变化的 `CACHE_BUST`：Docker 的 `COPY` 按输入内容
  失效，源代码更新仍重建对应层，锁文件未变时复用依赖安装层。

## Alternatives considered

- 验收改用 `--release`：编译成本抵消收益，且需额外证明与 debug
  的确定性输出一致，未采用。
- 用 artifact 在 job 间传递 SDK：与 cache 体积相同但每次都要上传，未采用。

## Consequences

- UI 预构建随 E2E workflow 启动，不等待 `changes`；单域 API PR 也执行一次约
  一分钟的前端预构建，换取完整 PR 不在 Domain job 之间排队的收益。
  浏览器测试的路径过滤保持原有条件。
- 沙箱优化后的运行 `38405677271` 中，沙箱 job 从 6 分 23 秒降到 3 分 22 秒。
- 五分钟目标以真实 workflow 完成时间验收，同时记录执行与排队时间。 新的 Rust
  优化配置需要首次预热；修改工具链输入仍执行完整的两次构建。 冷缓存与 GitHub
  runner 排队耗时不能由固定 timeout 保证。
- 缓存在 PR 分支上不可被其他分支读取，main 推送后才会预热；首次变更工具链的 PR
  一定未命中。
- job 名称新增 `Judge WASI SDK / Acceptance (shard) / Image`；仓库未设置
  required checks，无需同步。
