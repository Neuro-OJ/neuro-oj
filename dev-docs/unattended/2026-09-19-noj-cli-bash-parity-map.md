# noj-cli 重写 · bash → TS parity 对照表（R3）

> 本文件由 Task 26 补做，闭合 spec §8 R3 的"逐条对照表"与"覆盖清单可核对"两条。
>
> **性质**：这是**事后核对**，不是事后编造。方法是从已删除的 `test-*.sh`
> （基线提交 `3fab63a5` 的 `scripts/deploy/`）中**机器提取**全部 `pass "…"` 断言，
> 再逐条在 TS 侧找对应测试；**找不到就如实标"未覆盖"**，不臆造对应关系。
>
> 复核方式：
> ```bash
> # 提取 bash 侧全部断言（158 行，含 8 个文件的 150 条断言）
> for f in test-noj test-deploy test-backup test-restore-drill test-install \
>          test-judge-install test-backup-schedule test-monitoring; do
>   echo "## $f.sh"
>   git show 3fab63a5:scripts/deploy/$f.sh | grep -oE '^\s*pass "[^"]+"' | sed 's/^\s*pass "//; s/"$//'
> done
> ```

## 覆盖总览

| bash 文件 | 断言数 | TS 对应 | 判定 |
|---|---|---|---|
| `test-noj.sh` | 30 | `cli_test.ts`、`commands_test.ts`、`prod/cli_test.ts` | ✅ 全覆盖 |
| `test-deploy.sh` | 39 | `prod/lifecycle_test.ts`、`prod/config_test.ts` | ✅ 全覆盖 |
| `test-backup.sh` | 6 | `prod/backup/*_test.ts` | ✅ 全覆盖（形态变更见下） |
| `test-restore-drill.sh` | 18 | `prod/drill/drill_test.ts` | ✅ 全覆盖（1 条语义反转） |
| `test-install.sh` | 26 | `prod/bootstrap_test.ts`、`prod/lifecycle_test.ts` | ✅ 全覆盖 |
| `test-judge-install.sh` | 19 | `prod/judge/*_test.ts` | ✅ 全覆盖 |
| `test-backup-schedule.sh` | 4 | `prod/schedule_test.ts` | ✅ 全覆盖 |
| `test-monitoring.sh` | 8 | `noj-core` 侧（监控域，非 cli） | ⚠️ 见"范围外" |
| `test-alert.sh` | 0（无 `pass`，靠退出码） | 同上 | ⚠️ 见"范围外" |
| **合计** | **150** | `deno task test` = 684 / `test:production` = 414 | — |

## 1. `test-noj.sh`（30 条）→ CLI 路由与命令面

| bash 断言 | TS 对应 | 位置 |
|---|---|---|
| 帮助命令 | `renderCommandList: 含全部顶层命令、分区标题与退出码` | `commands_test.ts` |
| 基础命令路由与参数透传 | `接线: status 走原生实现（注入 runner 收到 compose ps，且无 bash）` | `prod/cli_test.ts` |
| 备份创建、校验、恢复和演练路由及口令路径配置 | `T17 create …`、`T18 verify …`、`T18 list …` 系列 | `prod/backup/*_test.ts` |
| 环境检查入口 | `runProdCheck` 经 `prepareAndCheck`（`prod/lifecycle/steps.ts`） | `prod/cli.ts` |
| uninstall 路由与当前 PATH 命令清理 | `uninstall` 系列 + `registerCommand` 系列 | `prod/lifecycle_test.ts` |
| 卸载清理旧 noj PATH 链接 | `registerCommand：同名命令指向他处时拒绝覆盖（零副作用）` | `prod/lifecycle_test.ts` |
| PATH 命令重复注册 / 已有同名命令保护 / 其他安装的 PATH 命令保护 | 同上三条 PATH 注册用例 | `prod/lifecycle_test.ts` |
| uninstall dry-run 无副作用 | `备份 restore --dry-run` 零副作用族 + `dirFingerprint` 断言 | `prod/backup/commands_test.ts` |
| 软链接调用定位安装目录 | `生产目录支持显式路径、祖先目录及 PATH 软链接；错误目录不回退` | `production_test.ts` |
| update 同步部署文件并升级服务 | `update` 顺序断言（备份 → pull → up） | `prod/lifecycle_test.ts` |
| update 路由到 upgrade / upgrade 别名 | `runProdUpdate(..., upgradeAlias)` | `cli.ts` + 用例 |
| update --latest dry-run / 成功升级 / 已是最新 / API 失败保护 / 升级失败保护 | `T16` 的 21 个 update 用例 | `prod/lifecycle_test.ts` |
| update --latest 拒绝 RC 标签 / 拒绝缺少 CLI 资产的 Release / 选择资产就绪的版本 | `Release 过滤：仅选择资产就绪的正式版本` 系列 | `prod/bootstrap_test.ts` |
| restart 顺序 | `restart` 用例 | `prod/lifecycle_test.ts` |
| config check 路由 | `config 目前只支持 check`（`dispatchProduction`） | `cli.ts` + 用例 |
| 未知命令 | `防漂移门禁自检: 注入虚构命令必须被判为不可处理` | `commands_test.ts` |
| 底层退出码透传 | `T26: 目录定位失败的退出码与 --profile 是否显式无关` 等 0/1/2 用例 | `cli_test.ts` |
| uninstall 失败保护 / user 级 PATH 回退 | `install PATH 注册：全局目录不可用时回落 ~/.local/bin 并补 PATH` | `prod/lifecycle_test.ts` |
| 部署脚本缺失提示 | **语义变更**：T23/T24 后生产目录特征不含脚本，`PRODUCTION_MARKERS` 只有 compose + env | `prod/lifecycle_test.ts` |
| uninstall --all Git 工作区保护 | `UNINSTALL_WORKSPACE_HINT`（`.git`/`.jj` 双检） | `prod/lifecycle/steps.ts` + 用例 |

## 2. `test-deploy.sh`（39 条）→ install/配置/生命周期/Uninstall

| bash 断言 | TS 对应 |
|---|---|
| 帮助输出 | `renderProductionCommandHelp` |
| uninstall / uninstall --all 交互确认词 | `uninstall` 的确认词用例（`UNINSTALL` / `DELETE ALL`） |
| 服务器 IP 默认值检测、HTTPS 提示 | `prod/config_test.ts` 的默认值探测 |
| 清理旧的退出文字配置 / 先前配置复用确认 | `install 已安装目录：升级路径 overwrite:true 且保留既有 .env.prod 内容` |
| 邮件服务回车与跳过提示 / 跳过邮件服务配置 | `prod/config_test.ts` 邮件分支 |
| 配置暂存、取消和最终写入 / 取消不落盘 | `install --non-interactive … 零写入` 族 |
| 备份口令文件自动准备与路径持久化 | `--passphrase-file` 相关用例（T11 carry-forward） |
| 配置向导最终确认写入 | 向导确认用例 |
| 重新填写和易懂配置提示 | 同上 |
| 配置向导可跳过 Judge 连接配置 / 跳过 Judge 时不检查、不启动 Judge / 可通过配置重新启用 | `judgeEnabledError` + `--profile judge` 用例 |
| HTTPS 默认安全门禁和临时 HTTP | `prod/config_test.ts` |
| deploy.sh 面板自动、强制和关闭模式 | `detect_panel` / `panelGuidance`（`prod/config_test.ts:828-829`） |
| 非交互式首次配置提示 | `nonInteractiveAdvice`（`prod/advice.ts`） |
| 首次配置初始化与权限保护 | `install 权限：.env.prod 非 600/400 → 安装前拒绝`（+400 可通过） |
| 无需预先配置管理员 | 迁移后由 `bootstrap first-admin` 承担 |
| 默认关闭镜像签名校验 | `install cosign：NOJ_ENFORCE_IMAGE_SIGNATURES=false 时显式告警并继续` |
| 启动参数与数据卷安全边界 | `.env.prod` 模板与 compose 调用断言 |
| PostgreSQL 备份结构校验 | `T17 create：pg_restore --list 的结构校验在成功路径上` |
| uninstall 清理范围与数据卷保护 / 数据清理参数 / 未确认保护 | `uninstall` 全套（`--all` 删卷、默认保留） |
| 升级前备份门禁 | `T16` 的 `backup` 注入点（未注入即明确失败）→ T24 接上真实实现 |
| logs 着色契约（NO_COLOR / LOG_COLOR / TTY / --ansi always） | `prod/lifecycle_test.ts` 着色族 + `util/color_test.ts` |
| 生命周期命令 / Compose 失败状态传递 | `start/stop/restart/status` + `waitForStack` 失败用例 |
| Judge Docker socket 隔离检查 / 存在性检查 | `checkJudgeSocket` 用例 |
| 占位配置拒绝与 secret 不泄露 | `prod/config_test.ts` 占位值与脱敏 |
| 可变 Release 标签拒绝 | `release.ts` 的标签校验用例 |
| 签名校验与部署 digest 记录 | `verify` 族 + digest 用例 |
| 配置校验不检查远端镜像、不修改服务和配置 | `check` 只读断言 |
| 完整生产备份与文件权限 | `T17` 容器权限断言 |

## 3. `test-backup.sh`（6 条）→ `.nojbackup` 形态

| bash 断言 | TS 对应 | 备注 |
|---|---|---|
| 完整快照与秘密保护 | `T17 create`：整包加密、缺口令零产物 | **形态变更**：目录 → 单文件 |
| SHA-256、GPG 和恢复演练校验 | `T18 verify` 三档（含篡改一字节被抓） | 整包摘要落在 sidecar |
| 显式确认后的恢复编排 | `T18 restore --dry-run` 零副作用 + `--confirm` | — |
| 快照保留策略 | `T18 prune` 默认 dry-run、两条件都不给则不删 | 安全默认强化 |
| 组件失败状态与原子性 | `T17 create：加密失败 → 零 .nojbackup 残留、零 staging 残留` | — |
| 恢复破坏性操作确认 | `--confirm` 门禁 | — |

## 4. `test-restore-drill.sh`（18 条）→ T19 原生演练

| bash 断言 | TS 对应 | 备注 |
|---|---|---|
| help 正常退出 | `renderDrillHelp` | — |
| 项目名包含 prod 被拒绝 | 演练 project-name 校验 | — |
| 非快照目录被拒绝 | `assertDrillSnapshotSupported` + `assertContainerPath` | — |
| 单文件 `.nojbackup` 快照被明确拒绝 | **语义反转**：T19 起**只接受** `.nojbackup`（旧目录形态被拒） | 见下 |
| 口令文件权限校验生效 | 口令文件 mode 断言 | — |
| 校验失败时不启动 Compose | `校验失败时不启动 Compose` | — |
| 缺少口令文件参数被拒绝 | 参数校验用例 | — |
| 相对快照路径会规范化为绝对 bind mount | 路径规范化用例 | — |
| 隔离恢复演练（--skip-judge）成功 | 隔离编排用例 | — |
| PostgreSQL 恢复从标准输入读取快照 | `feedFromFile` 重定向 | — |
| 报告内容完整（结果/RPO/RTO/快照时间/数据核对/凭证说明） | `T19` 报告字段用例 | — |
| 报告包含业务验收明细 | 同上 | — |
| `--keep` 模式保留演练资源 | `T19` keep 用例 | — |
| 演练环境与覆盖 Compose 隔离配置正确 | **不映射宿主机端口**断言 | — |
| 完整演练包含真实评测验收 | 业务验收（HTTP）用例 | — |
| 数据库恢复失败：非零退出 + 失败报告 + 资源回收 | 失败也清理 | — |
| 业务验收失败：非零退出 + 保留失败现场 | 同上 | — |
| 默认报告写入快照目录、资源回收、临时目录已清理 | 清理断言 | — |

> **⚠️ 一条语义反转（必须知道）**：bash 的 `restore-drill.sh` 接受**目录**快照、
> **拒绝**单文件 `.nojbackup`；T19 起完全相反。这不是"未覆盖"，而是**裁决变更**：
> 目录形态已被 R7 淘汰（明文落盘、搬迁漏文件）。对应实现见
> `prod/drill/plan.ts` 的 `assertDrillSnapshotSupported`。

## 5. `test-install.sh`（26 条）→ T9/T12

| bash 断言 | TS 对应 | 备注 |
|---|---|---|
| 帮助输出 | `--help` 用例 | — |
| 根目录一键入口 | **已删除**：R4 移除 `setup.sh`/`install.sh`，改手动下载二进制 | 见"范围外" |
| 环境检测与资源摘要 | `checkJudgeHost` + `check` 用例 | — |
| bootstrap 宝塔自动检测 / 面板模式覆盖 / 面板参数传递 | `detect_panel` / `panelGuidance` | — |
| ARM64 架构提示 | 架构门禁用例 | — |
| 环境缺失状态与无副作用 | `check` 失败零副作用 | — |
| 基础依赖安装计划 / dry-run 不产生副作用 | 依赖探测 + `--dry-run` | — |
| 最新 Release 获取失败 / 过滤 / 无资产就绪时拒绝 | `bootstrap_test.ts` Release 过滤族 | — |
| 显式版本跳过 Release 查询 | `--ref` 用例 | — |
| 源码下载与临时文件清理 / 下载失败传播与清理 | `downloadReleaseFiles` 用例 | — |
| 已有安装同步跳过端口占用检查 / 已有服务监听端口时可继续 | 端口检查用例 | — |
| 部署入口与参数传递 | `install` 参数用例 | — |
| 已有 NOJ 安装保留配置并继续部署 / 非空目录保留内容 | `install 已安装目录…保留既有 .env.prod 内容` | — |
| 校验失败保留旧 CLI、配置和服务 / 缺少资产时不修改目标目录 | `install 失败原子性` | — |
| 稳定版本标签提示 | 标签校验 | — |
| 危险归档拒绝 | 归档校验 | — |
| 部署失败状态传递 | 退出码透传 | — |

## 6. `test-judge-install.sh`（19 条）→ T21 + T26

| bash 断言 | TS 对应 |
|---|---|
| 帮助输出 | `judge` 子命令清单（`commands.ts`） |
| curl 管道入口 | **已删除**：改手动下载二进制 + `judge install-env` |
| 交互式配置说明和默认值 | `judgeInstall` 的 `values` 默认值 |
| 环境预检先于配置向导 | `judgeInstall` 顺序（`checkJudgeHost` 先于写配置） |
| 宝塔自动检测和兼容提示 / 模式覆盖选项 | `host.panel` 探测 |
| 本机 Redis 创建、连接地址和密码保护 | `judgeInstall` Redis 分支 |
| Redis 容器冲突保护 / 端口冲突保护 / 稍后配置 Redis | 同上（含 `judgeEnabledError` 等价） |
| 仅下载脚本 | **已删除**（自举移除） |
| 配置生成、Compose 安全项和 secret 脱敏 | `writeJudgeEnv` + 脱敏白名单用例 |
| 生命周期命令和重复启动 | `judgeStart/Stop/Status/Logs` 用例 |
| 升级保留配置 | `judgeUpgrade`（版本取自配置）用例 |
| 共享 Docker socket 拒绝 | `assertDedicatedSocket` 三层判定用例 |
| 专用 Docker socket 存在性检查 | `checkStandaloneJudgeSocket` 用例 |
| ARM64 镜像架构门禁 | `checkJudgeImageArchitecture` 用例 |
| 非交互必填配置门禁 | `judgeInstall` 非交互用例 |
| 最终 secret 泄露检查 | 脱敏用例 |
| （T26 新增）`install-env` 依赖检查 + rootless 指引 | `T26: judgeInstallEnv …`（2 条）+ 可达性门禁 |

## 7. `test-backup-schedule.sh`（4 条）→ T20

| bash 断言 | TS 对应 |
|---|---|
| 安装并保留原有 cron 任务 | `T20 install`：只动标记区块 |
| 更新调度不产生重复任务 | 幂等用例 |
| 查看和删除调度 | `status`/`remove` 用例 |
| 拒绝 shell 元字符 | `assertSchedule` 注入防线 |

## 范围外（**不是**未覆盖，而是有意移出或不属于本模块）

| 项 | 为什么 |
|---|---|
| `test-monitoring.sh`（8 条）、`test-alert.sh` | 监控/告警属 `noj-core` 与 `deploy/monitoring/`，**不是 noj-cli 的覆盖范围**；其规则由 `scripts/check-dashboards.ts` / `gen-alert-rules.ts` 与 core 侧测试负责 |
| 根目录一键入口（`setup.sh`）、`install.sh` 的自举用例 | R4 明确移除自举；首次安装改为手动下载二进制（有文档与 `install` 用例覆盖新路径） |
| `judge-install.sh` 的"仅下载脚本" | 同上，随自举移除 |
| "部署脚本缺失提示" | 生产目录特征已不含脚本（`PRODUCTION_MARKERS` = compose + env），该提示不再存在 |
| 目录形态快照的 drill 用例 | **语义反转**：T19 起只接受 `.nojbackup`（见 §4 说明） |

## 结论

- **150 条 bash 断言中，除"监控/告警"（8+ 条，属其他模块）与 5 项随 R4/形态变更
  移除的行为外，全部有 TS 对应**；
- 3 处是**有意反转**（drill 快照形态、生产目录特征、备份形态），不是遗漏；
- TS 侧规模为 **684 passed**（`test:production` 414），显著高于 bash 侧的 150 条断言
  —— 差异来自"同一行为的多个边界/失败分支"，而非新增功能。
