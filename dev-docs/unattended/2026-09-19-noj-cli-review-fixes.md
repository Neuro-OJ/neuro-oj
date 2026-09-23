# noj-cli 重写 · 代码评审发现与修复记录（2026-09-19）

> 三名评审 subagent 分别审了**安全/隔离**、**命令面/接线/门禁**、**生命周期/文档**
> 三个风险面（base `1a268043` → head `c58430b8`）。本文件记录**全部发现**与
> **处置状态**，供后续 review 与回归对照。
>
> 评审方法：每名评审都在 `c58430b8` 的独立 worktree 里**实测复现**（不是只读代码），
> 并各自确认未改动主检出。共 **10 个 Critical**、**约 12 个 Important**、**若干 Minor**。

## 修复总览

| # | 严重度 | 发现 | 修复提交要点 |
|---|---|---|---|
| 1 | Critical | `install` **从不创建** `<dir>/bin/noj-cli` → PATH 不注册、`uninstall --all` 自锁、cron 入口缺失 | `installCliBinary()`（暂存 + 原子 rename + 源码模式跳过） |
| 2 | Critical | `install` 无 `--ref` 时用分支 `main` 当版本 → 404；文档全用无 `--ref` 写法 | 改走 `resolveLatestReleaseTag()`（宽资产集） |
| 3 | Critical | `install` 被 `findProductionDir` 拦住 → **无法装到空目录**（R4 头号交付物） | `install` 只做路径归一化 |
| 4 | Critical | `update --latest` 用**旧** `.env.prod` 起栈 → 报成功但版本没变 | 暂存配置贯穿 pull/up |
| 5 | Critical | `backup prune --keep oops` → `NaN` → **删光全部备份** | `optionalCount()` 校验（原校验器已不在活跃路径） |
| 6 | Critical | `--dry-run` 被静默忽略 → `uninstall --all --dry-run` **真删数据** | 未实现旗标显式拒绝（judge 例外） |
| 7 | Critical | 共享 socket 守卫可被**尾部斜杠**绕过（容器逃逸面） | `normalize` + 剥尾斜杠 + 父目录 realpath |
| 8 | Critical | `backup drill` 对 `create` 的任何快照**必然失败**（迁移状态硬编码常量） | `readMigrationStatus()` 真查 drizzle 表 |
| 9 | Critical | `judge upgrade` 不重渲染 compose → **报成功但版本没变** | 加 `write_compose`（对齐 bash :890） |
| 10 | Critical | `judge install --dry-run` **真的写文件**（CLI 层未转发） | 转发 `dryRun` |
| 11 | Critical(测试) | 干净检出下 `deno task test` **红**（685/2 failed）；我报告的 687 是侥幸 | 已移除/未知命令跳过 profile 探测 |
| 12 | Important | `verify` 与 `check` **完全相同** → 安全控制报成功却从未运行 | 新增 `runProdVerify` |
| 13 | Important | `judge start` 等跳过 socket 守卫 | 守卫移入 `prepareExisting` |
| 14 | Important | `judge status` 每行打印两次 | 人类模式只补 message |
| 15 | Important | `judge install-env` 文档入口不可执行 | `judge` 允许新建目录 |
| 16 | Important | 带值旗标未登记 → `--restore-env` 的**值被当快照路径** | 补全 `valueTaking` |
| 17 | Important | drill 恢复路径丢弃 `minio-init`/`migrate` 退出码 → 根因被埋 | 两处显式检查 |
| 18 | Minor | `--ansi` 放在 `compose` 之前 → `unknown flag` | 插到 `compose` 之后 |
| 19 | Minor | 产物权限随 umask（`--no-encrypt` 时明文可读） | 产物与 sidecar chmod 600 |
| 20 | Minor | 测试伪造已删脚本 → 掩盖真实缺口 | `makeRemovableDir` 只造真实形状 |

**测试数**：687（不可复现）→ **715**（干净检出可复现）。每个修复都先写失败测试，
并**逐一验证过"退回旧行为会转红"**。

## 本轮暴露的两个过程教训

### 1. 我的"687 passed"是环境侥幸（已自我更正）

仓根有一份**未被 git 跟踪**的 `.env.prod`（gitignore 内的历史残留），
而 profile 探测会向上查找并命中它 → 两条依赖"当前目录是生产安装目录"的测试
**恰好通过**。CI 的 `actions/checkout` 不带该文件，所以那个 job 实际是红的。

**我的证据文档里那个数字当时并不成立。** 现在所有验证都在**干净检出**里跑过。

### 2. "存在且有测试的校验"可能已不在活跃路径上

`--keep` 的校验器（`parseBackupArgs`）**仍在仓库里、仍有测试断言**，
但 T24 之后 prune 改走 `runBackupPrune`，**完全绕过它**。
于是"测试全绿"掩盖了"校验已失效"——这类缺陷靠读测试是发现不了的。

同类：`makeCliBinary()` 让 install 测试**预置**了 `bin/noj-cli`，
于是"install 到底会不会放二进制"这个真实问题**从未被问过**。

## 仍待处理（未修，需你判断）

| 项 | 说明 |
|---|---|
| `backup restore --confirm` | 文档与 help 承诺"真实恢复"，实现只有 dry-run planner（plan 里写明不实现）。**要么实现、要么改文案**——属产品决策 |
| 监控指标缺 writer | `noj_backup_last_success_unix_time` / `noj_backup_snapshot_bytes` 在 TS 侧无写入方，而 `noj-alerts.yml` 依赖它们；`backup.sh` 暂未删除故暂无中断，但迁移不完整 |
| 本地 Redis 模式 | `assertRedisPort`/`generateRedisPassword` 等已导出但**零非测试调用者**（plan T21 §3 要求实现）；parity 表曾称其已覆盖，该说法不准确 |
| drill 的 `verifier` 服务 | override 里仍声明并固定一个 deno 镜像，但原生 drill 已不用它（死服务，与 Agent Note 的"少一个镜像依赖"矛盾） |
| `NOJ_BACKUP_PASSPHRASE_FILE` | CLI 未把它接进 `drill`/`verify`/`restore`（bash 有默认），而文档仍展示该环境变量 |
| R1 门禁范围 | 只扫 `src/prod/`，未覆盖 `src/` 其余部分 |
| 可达性门禁盲区 | 子命令级不可达（把 `case "schedule"` 改名不会被发现）与"可分发但未声明"方向仍未断言 |
| `assertJudgeEnvFileMode` | 4 位模式（如 setuid `4600`）渲染成 `"4600"` 被拒，报错信息令人困惑 |
| drill 未来时间戳 | `hoursSinceSnapshot` 对将来时间返回负值（报告显示 `rpo_hours=-12.00`） |
| drill 清理时序 | 成功路径忽略 `downDrillStack` 失败，且报告在清理**之前**就写了 `cleanup=done` |
| `--` 处理 | `positionals` 认 `--`，但 `parseProdArgs` 不认（`status -- --dir /x` 仍消费 `/x`） |
| Tier-3 退出码分裂 | `db migrate --install-dir /nonexistent` → 2，而带 `--profile prod` → 1（与已修的 prod 侧同类问题） |
| 陈旧文案 | `"--profile 需要一个值（prod 或 stack）"` 仍提已删的 `stack`；`production.ts` 仍说"setup.sh 安装的目录" |
| 死代码 | `resolveProfile`/`DispatchOptions.stackAlias` 无调用者；`PROFILE_AGNOSTIC` 里的 `"completions"` 不是真实命令 |
| 报告字段时序 | drill 报告写 `cleanup=done` 早于实际清理 |
