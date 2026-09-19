# Agent Note: 生产 uninstall 的确认词、数据卷安全与工作区保护

Status: implemented

## Problem

`uninstall` 是生产命令里唯一**不可恢复**的动作，bash 侧对它的防护散落在三处，各防一类事故：

1. **确认词**（`deploy.sh:1052-1084`）：不是"输入 y"，而是两个**互不相同**的短语——
   默认卸载要求 `UNINSTALL`，`--all` 要求 `DELETE ALL`。同一份脚本里两处 `read_prompt`
   若共用一个词，`--all` 的"删除全部数据卷 + 安装目录"就会与"只删容器"共享确认强度；
   此外无 TTY 且未 `--yes` 时必须**硬错误**，否则 CI/管道里 `read` 拿到 EOF 会把空串
   当成"未确认"还是"已确认"取决于实现，属于典型的静默放行面。
2. **删除范围**（`:1097-1111`）：默认 `down --remove-orphans --rmi local`（**保留**数据卷），
   `--all` 才 `--rmi all --volumes`。且 bash 置 `INCLUDE_ALL_PROFILES=1`——否则
   `--profile judge` / `--profile monitoring` 下的服务不会被 `down` 触及，卸载后残留。
3. **工作区保护**（`production.sh:167-182`）：`--all` 会 `rm -rf` 安装目录，因此在**删除任何
   东西之前**必须验证目标确实是一个安装目录且不是 Git/jj 工作区。bash 在
   `production.sh:509` 把它放在 `run_deploy uninstall` **之前**，语义是"验证失败时
   连容器和数据卷都还没动"。

这三类防护的共性：**每一条都必须在任何变更动作之前完成，且失败路径零副作用**。

## Decision

在 `prod/lifecycle.ts` 新增 `uninstall()`，严格按 bash 的顺序编排"确认 → 前置 → 工作区守卫
→ down → 软链清理 → 删目录"，并为每一段配套可注入的依赖：

1. **确认词**：`confirmUninstall()` 返回 `string | null`（失败文案 / 通过），
   `--yes` 直通；`isTty` 为假直接返回 `UNINSTALL_TTY_HINT`（`deploy.sh:1057-1058` 逐字），
   否则按 `--all` 选 `DELETE ALL` / `UNINSTALL` 并逐字比较（**不做 trim、不做
   大小写归一**——bash 的 `[[ == ]]` 就是精确比较）。确认读取经 `readConfirm` 注入点，
   测试绝不读真实 stdin。失败时直接 `return fail(...)`，此时 **runner 零调用**。
   两条警告正文（`:1060-1067` / `:1072-1078`）与取消文案（`:1070` / `:1081`）逐字保留为
   导出常量，便于 T24 接线复用而非另写一份。
2. **前置**：新步骤 `checkUninstallDependencies()`（`lifecycle/steps.ts`）逐条跑
   `docker --version` → `docker info` → `docker compose version` → `.env.prod` →
   compose 文件（`deploy.sh:1085-1096`），文案逐字。返回 `PrepareResult`：`.env.prod`
   顺带解析出 `judge` 旗标，但**解析失败不阻断卸载**（配置残缺恰是卸载的常见场景），
   失败时按 judge 启用处理——宁可多带一个 `--profile` 也不漏删。
3. **删除范围**：`judge` 与 `monitoring` 两个 profile 旗标**都带上**。
   - judge 取"恒真"而非 `judge_enabled()`：bash 在 `INCLUDE_ALL_PROFILES=1` 下
     `run_compose` 的判据是 `((INCLUDE_ALL_PROFILES)) || judge_enabled`（`:957`），
     故 judge **恒带**；
   - monitoring 的存在性取自 T10 的 `PROD_SERVICES`（`compose_test.ts` 已把它与真实
     `docker-compose.prod.yml` 双向比对），不手抄第三份服务清单；
   - `--profile` 对未声明该 profile 的 compose 文件是惰性的，故无条件带上不改变
     默认卸载语义——这正是"覆盖全部 profile"最省心的落点。
4. **工作区保护**：新步骤 `assertRemovableInstallDir()` / `removeInstallDirectory()`
   （`production.sh:167-182`）在 `uninstall()` 中**在 `down` 之前调用一次**（`:509` 的等价），
   删除前由 `removeInstallDirectory` 再调用一次（`production.sh:179` 的等价）。
   四条检查逐条对照：目录形态（`-d && ! -L`）→ 安装完整性（`bin/noj-cli` + 部署脚本 +
   `PRODUCTION_MARKERS` 特征文件）→ **`.git` / `.jj` 拒绝** → 危险路径（`/`、`.`、`..`、`$HOME`）。
   安装特征文件消费 `profile.ts` 的 `PRODUCTION_MARKERS` 单一事实源，不新增清单（T5/T12
   carry-forward）。
5. **软链清理**：`unregisterCommand()`（`production.sh:148-165`）落在 `lifecycle/path.ts`——
   与既有 `registerCommand` 同模块，共享"软链解析后指向何处"这一唯一判定
   （`symlinkPointsToInstall`）。只删解析结果等于 `<dir>/bin/noj-cli` 或 `<dir>/noj` 的
   软链；普通文件、指向他处的软链一律跳过；删除失败抛错（bash `rm -f ... || fail`）；
   一个都没删时 **warn 不报错**。
6. **产物形状**：`UninstallResult` 在 `LifecycleBaseResult` 上追加
   `all` / `volumesRemoved` / `removedCommands` / `installDirRemoved`；`state` 固定为
   `"stopped"`（卸载后不存在运行中的栈），`--json` 载荷同形。

## Alternatives considered

- **让 `confirmUninstall` 通过抛错表达拒绝**：与 `uninstall` 既有的
  `{ exitCode, error }` 返回风格不一致（`install` 才抛错，生命周期命令返回结果），
  且"确认不符"与"前置失败"的退出码都是 1，用返回值更贴合本模块的既有契约。
- **judge 旗标改用 `judgeEnabledFrom(env)`**：会与 bash 的 `INCLUDE_ALL_PROFILES |
  judge_enabled` **或**语义相反——judge 关闭时反而不带 `--profile judge`，留下原本
  运行中的 judge 容器。恒带更安全且是逐字等价。
- **monitoring 旗标从 compose 文件解析 `profiles:`**：需要自己解析 YAML 缩进，等于在
  `compose.ts` 之外再造一份服务清单；`PROD_SERVICES` 已是与真实文件双向比对过的事实源。
- **只检查 `.git`（严格照抄 bash 的 `.git` 分支）**：本仓是 colocated jj/git，但纯 jj
  检出（无 `.git`）、`.jj` 是**文件**的情形确实存在；T15 brief 明写"Git/jj 工作区"。
  多查一个 `.jj` 只会更保守，不会误删。
- **软链清理用 `Deno.realPath` 解析目标**：`realPath` 要求目标存在，而安装目录里的
  `bin/noj-cli` 可能已被删；`readLink` + 相对路径 `resolve` 纯字符串解析，与 bash 的
  `cd -P && pwd` 语义一致且不依赖目标存活。
- **实现 `--dry-run`**：bash 的 `confirm_uninstall` 首行就 `((DRY_RUN)) && return 0`，
  但 T13/T14 已登记"不迁移 `--dry-run`"；T15 brief 同样未要求（T16 才需要脚本化干跑）。

## Consequences

- **拒绝路径保证零副作用**：三种确认失败（无 TTY、词不对、读不到输入）都在
  `checkUninstallDependencies` 之前返回，因此 **runner 零调用**；工作区拒绝发生在
  `down` 之前，因此容器与数据卷都未被触碰。测试对这两点都有显式断言。
- **默认卸载保留数据卷、`.env.prod`、备份与安装目录**；只有 `--all` 才
  `--rmi all --volumes` 并 `rm -rf` 安装目录。参数数组逐字断言（含 `--profile` 顺序）。
- **卸载覆盖 judge 与 monitoring 两个 profile**：参数断言锁死
  `--profile judge --profile monitoring` 出现在 `down` 子命令之前。
- **安装完整性检查是自锁风险**：`bin/noj-cli` 与生产部署脚本缺失时，`--all` 会先报
  "不是完整的 NOJ 安装目录"而不是工作区错误。这是 bash `production.sh:170-171` 的
  既有行为（检查顺序如此），已在测试 helper `makeRemovableDir` 与 JSDoc 中记录。
  T24 删除 bash 时必须同步处理：要么保留同形文件系统契约（部署脚本占位），要么
  重新定义"安装完整性"——**否则 `uninstall --all` 会在真实安装目录上永远拒绝**。
  该风险同时记在 T5/T24 的 ledger carry-forward 下。
- **变异测试 9/9 转红**：交换两个确认词、默认改成 `--rmi all`、`--all` 去掉 `--volumes`、
  去掉 monitoring 旗标、去掉 judge 旗标、软链判定恒真、去掉无 TTY 拒绝、去掉工作区守卫、
  把工作区守卫从 `down` 之前挪走——均被现有测试捕获。
- **CLI 入口仍未接线**（与 T12–T14 同一状态）：`cli.ts` 仍把 `uninstall` 路由到
  `runProduction` → bash；本次交付的是可注入的纯 TS 命令实现，接线按任务书归 T24。
  删 bash 前必须接线，且 `readConfirm` 需由 CLI 层接上 `PromptIO`（缺省不读真实 stdin
  是有意的：未接线时宁可报"无法读取确认输入"也不静默放行）。
- **相对路径软链**：`symlinkPointsToInstall` 以软链所在目录为基准解析相对目标
  （等价 bash 的 `cd -P "$(dirname ...)"`），因此 `ln -s ../opt/noj/bin/noj-cli`
  这类写法同样能被正确识别为"指向本安装目录"。
