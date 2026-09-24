# Agent Note: noj-cli install 成为唯一生产安装路径

Status: implemented

## Problem

纯 TS 重写（spec R4 + §3.3 洞 2）删除 `setup.sh` 与 `scripts/deploy/install.sh`
后，用户只剩一个手动下载的 `noj-cli` 二进制。此前安装所需的两个文件由
`install.sh` 从源码归档里 `cp` 出来，配置校验与 compose 编排又分别散落在
`deploy.sh`、`production.sh`。三块能力（T9 bootstrap、T11 配置、T10 compose）
虽已各自迁入 TS，但没有任何一条把它们接起来的路径——`install` 只存在于 bash。

因此存在一个只有在真实空目录上才会暴露的缺口：CLI 的 `install` 若不自举，
"手动下载二进制 + `noj-cli install --dir <dir>`"无法完成安装；而上下游模块
本身单测全绿，不会发现这个"接线缺口"。

## Decision

新增 `noj-cli/src/prod/lifecycle.ts`，其 `install(opts)` 是**唯一**生产安装路径，
按固定顺序串起三段：

1. **bootstrap（T9）**：`downloadReleaseFiles` 拉取并 SHA-256 校验
   `docker-compose.prod.yml` + `.env.prod.example`。
2. **seed-env + configure + passphrase + validate + verify-images（T11）**：
   首次由模板生成 600 的 `.env.prod` 并替换占位密钥；TTY 下走
   `runConfigWizard`；`ensureBackupPassphrase`；`judgeEnabledError` →
   `checkRequiredValues` → `checkJudgeSocket` → `compose config`；
   `verifyImageSignatures`。
3. **compose pull + up（T10）** 与 **record-metadata（T11）**，最后
   **PATH 注册**（`production.sh:97-131` 的 `register_command` 语义）。

四个上游 carry-forward 全部落实：

- **T9 `overwrite`**：首次安装传 `false`（拒绝静默覆盖），只要目录里已有
  T9 的任一 Release 资产就传 `true`。**是否 seed** 由 T5
  `PRODUCTION_MARKERS`（两件套齐全）决定，**是否覆盖**由 T9 自己的资产清单
  决定——二者刻意分开：半成品目录（上次安装中途失败只留下 compose）按
  "未安装"传 `overwrite:false` 会永久卡住重试。
- **T11 顺序**：`judgeEnabledError` **先**执行，非 null 立即抛错，**再**进
  `checkRequiredValues`（其第一步即 `validateEnv`）；judge 未设置/空串 = 启用。
- **T11 口令**：路径经 `targetFile` 注入（`--passphrase-file` 优先）；回填仅由
  进程环境 `NOJ_BACKUP_PASSPHRASE_FILE` 抑制（`configuredFromEnv`），旗标不抑制。
- **T11 权限**：`.env.prod` 经 `checkEnvFileMode(mode, envFile)` 校验 600/400，
  不合格在任何安装动作之前拒绝。
- **T11 cosign**：`cosignAvailable` 缺省由注入 runner 执行 `cosign version`
  判定（不猜 true、不 spawn shell）；不可用时既告警又抛错，绝不静默跳过。
- **T10 结果形状**：读 `ComposeResult` 一律先 `Array.isArray` 收窄；runner 不
  替调用方打印，本模块自己把 stdout/stderr 写给 `io`。
- **T5 标记**：`profile.ts` 的 `PRODUCTION_MARKERS` 提升为导出常量，
  `production.ts:isInstallDir` 与 `lifecycle.ts` 都消费它，不再各留一份。

所有外部访问都可注入：网络 `fetcher`、命令 `runner`、交互 `io`、安装目录与
`binDir`/`userHome`。测试因此不触网、不起容器。

## Alternatives considered

- **保留 bash 作为安装路径**：R1 是硬要求（零 `Deno.Command("bash"`），且
  spec 明确删除 `install.sh`/`setup.sh`。
- **在 CLI 里重新渲染 compose（复用 `renderCompose`）**：spec §3.4 已点明
  stack 与 prod 是两份不同的编排，运行时渲染会引入未受测的编排面；T10 的裁决
  是只认 Release 下载的固定文件。
- **非交互且缺配置时先由模板生成 `.env.prod` 再退出**（逐字照搬
  `deploy.sh:646-655`）：会在失败路径上留下半成品配置。brief 明文要求"不进
  向导、不写文件"，故改为在写入前直接报错；这是与 bash 的**有意差异**。
- **`install` 里同时把运行中的二进制复制到 `<dir>/bin/noj-cli`**：那是
  `install.sh` 的 `download_cli`/`install_cli` 职责，随 R4 删除；二进制改由
  用户手动下载（R4），跨版本同步留给 update（T16）。
- **`wait_for_stack` 逐字照搬 bash 的两个 `up`**（`--wait-timeout 180
  --remove-orphans` 后再 `--force-recreate --no-deps nginx`）：会新造一份
  compose 封装；改为复用 T10 的 `composeUp`（`up -d --wait`），差异已在
  task-12 报告登记。
- **`overwrite` 直接绑死 `isInstallationDir`**：见上，会让半成品目录卡死。
- **另建第三份"安装目录标记"**：T5 carry-forward 明令禁止；改用导出的
  `PRODUCTION_MARKERS`。

## Consequences

- `noj-cli install --dir <dir>` 在空目录仅凭二进制即可完成安装：下载 →
  校验 → 生成/复用 `.env.prod` → 启动 compose，`scripts/deploy/install.sh`
  的职责被完全吸收，T24 删除它后安装路径不中断。
- `install` 的副作用顺序与每步文件效果可被 `lifecycle_test.ts` 直接断言
  （步骤清单、`overwrite` 取值、`.env.prod` 内容与权限、compose 参数数组）；
  校验失败/权限不合格/cosign 缺失都在写配置或起容器**之前**失败。
- 升级路径（目录已有两件套）保留既有 `.env.prod` 逐字节不变，只更新 compose
  与 example；新增回归测试断言这一点。
- `registerCommand` 是 best-effort：目标 `bin/noj-cli` 不可执行时按"源码运行
  模式"告警跳过，同名指向他处时拒绝覆盖并告警，失败不使整个安装失败。
- T13–T16 在同一文件继续追加 start/stop/restart/status/logs/uninstall/update，
  可复用本文件的 `InstallStep` 报告形状与注入点。
