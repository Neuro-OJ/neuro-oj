# 无人值守执行工作日志（2026-09-28 / 29）

> 性质说明：这是**时点快照**，不是持续维护的看板。
> 目标与验收标准见 `dev-docs/superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md`，
> 实施计划见 `dev-docs/superpowers/plans/2026-09-28-contest-readiness-unattended-audit.md`。

- 计划窗口：2026-09-28 22:00 → 2026-09-29 07:00（CST）
- 执行者：AI Agent（无人值守）
- 交付约定：**只推分支 + Draft PR，绝不推 main、绝不合并**（本会话全程遵守）

## 时间线（实测）

| 时间（CST） | 事件 |
|---|---|
| 21:29–21:44 | 人在回路设计讨论（分类为 architectural）：确认四轴范围、方案 B 预算切分、串行 subagent 协议、分支 + Draft PR 边界、高危面"全部自主修但需成对证据"；spec 与 plan 落盘；`create_goal` 设定 |
| 21:44:53 | **Task 0 Step 1 锚点冻结**：`origin/main=6dbdd76b`、`jj main=qrsktulv`、签名可用 |
| 21:47 | 发现栈基 `e515aafb` **无提交消息**，且 `@-` 在会话中被外部改写（`jj op log` 定位为 21:31 的 `jj describe -m "ui refactor"`）→ **按 spec §7.5 停下排查**，未自作主张 rebase |
| 21:50 | Owner 确认"那是我改的，现在没改了"；裁定：消息规范化为合规格式、孤儿 head `676aafb3`（更早一版 endfield UI 重设计）用 `jj abandon` 清除 |
| 21:51 | 规范化完成：`4356fe18`，**树 hash 未变**（`2d1f2013…`）、签名 `G`、48 文件不变 |
| 21:52:43 | `cargo build --release` 重建 judge 二进制（原二进制为 **9-11** 构建，早于 9-28 沙箱加固） |
| 21:53 | 栈基推为 Draft PR **#593**（base `main`） |
| 21:56–22:00 | 首次 `check-all` 基线：**因把 Deno 缓存放在仓库根，`verify-md-links` 报 5560 条错误（自造假红）**；同期发现 `$HOME` 只读导致 jsr 依赖"下载失败"（实为缓存不可写）、Docker buildx 不可用 |
| 22:00–22:05 | 环境绕行落地：`DENO_DIR=<repo>/node_modules/.deno_cache`（4.8G 缓存实拷贝 8 秒）、`DOCKER_CONFIG=/tmp/docker-cfg` |
| 22:03 | **环境事故**：`scripts/e2e/setup.sh` 与 dev 共用 compose 项目名 `neuro-oj`，把 `noj-postgres/redis/minio` 重建为 `noj-e2e-*` → 已恢复（卷未重建，数据无损，详见 `baseline.md` §4）；此后**不再使用该脚本** |
| 22:05 | dev 基础设施恢复完成（三容器 `Up`、端口全开） |
| 22:07 | **面 1.1 审计 subagent 返回**（类型 II 二次审计）：10 条 finding，含 1 条 Critical（NOJ-A1 注入内存双份驻留） |
| 22:09 | `findings/01-judge-availability.md` 落盘 |
| 22:18–22:23 | **verifier subagent 对抗性复核**（finding 10 > 5，按 spec §5.4 必须另派）：证伪 1 条、部分证伪 5 条、**独立发现 3 条一审漏掉的缺陷**；假阳性率 1/10 |
| 22:23 | `verification/01-judge-availability.md` 落盘 |
| **22:23 → 07:29** | **会话在夜间被挂起，未执行任何工作**（证据：`findings/`=22:09、`verification/`=22:23，而修复类证据时间戳为 07:29–07:33；dev 容器 `Up 9 hours` 亦印证） |
| 07:29–07:33 | 恢复后按 spec §7「07:00 硬停：不开新面，把当前轮写到可提交状态」→ **只收口面 1.1**：5 项修复 + 成对证据 + 反向验证 |
| 07:35–07:45 | 门禁与收尾：judge `fmt`/`clippy -D warnings`/`nextest --all-targets`（**411 passed / 0 failed**）、root `check-all`（**全部检查通过，EXIT=0**）、Agent Note 格式门禁、静默跳过棘轮；`baseline.md` 落盘；提交 + bookmark + Draft PR；L0 红线核验 |

## 面状态

| 面 | 状态 | 备注 |
|---|---|---|
| 0 前置冻结 | ✅ 完成（含环境绕行与事故恢复） | 见 `baseline.md` |
| 1.1 noj-judge 可用性（四轴之一：评测机被卡） | ✅ 完成（审计 + 复核 + 5 项修复 + 成对证据） | 见 `findings/01-*`、`verification/01-*`、`evidence/01-*` |
| 1.2 noj-judge 沙箱与容器逃逸 | ⛔ **未开始** | 需 e2e 栈与 Docker E2E 实测 |
| 1.3 root/compose 生产拓扑隔离 | ⛔ **未开始** | 同上 |
| 1.4 noj-core 数据泄露（读路径矩阵） | ⛔ **未开始** | |
| 1.5 noj-core 赛时公平性信道 | ⛔ **未开始** | |
| 6–11 第二阶段六面 | ⛔ **未开始** | |

## 关键教训（本会话新增，供下次无人值守复用）

1. **会话沙箱可能把 `$HOME` 置为只读**，而 Deno/Docker/多数工具链默认都要写 `$HOME`。
   症状具有极强误导性（"jsr.io 下载失败"实际是缓存不可写）。**开工第一件事应是写一份
   `DENO_DIR` / `DOCKER_CONFIG` 探针**，而不是等门禁报错后才追。
2. **把缓存放进仓库树会污染门禁**：`.deno_cache/` 虽在 `.gitignore` 且被多数门禁跳过，
   但 `verify-md-links` 只跳 `node_modules` → 5560 条假红。**改环境时必须在同一次会话内
   重跑门禁并核对"错误是否由我引入"**。
3. **`bash scripts/e2e/setup.sh` 会接管 dev 基础设施**（compose 项目名共用、未传 `-p`）。
   这是仓库真实缺陷，本轮未修，任何后续会话执行前必须先自行加独立项目名。
4. **`/tmp` 备份不可靠**：一次 `cp` 到 `/tmp` 的备份在下一条命令里已不存在（沙箱可能给出
   每次调用独立的 `/tmp` 视图）。反向验证的"改回旧实现"必须用可逆的编辑操作（记录精确
   前后文本），不要依赖 `/tmp` 备份。
5. **审计-复核双段是有效的**：verifier 证伪 1/10 并纠正 5 条的后果表述，还补出 3 条一审
   漏掉的缺陷（其中 D2 把"崩溃"放大成"1 小时不可用"）。单轮审计的严重度与归因**不可直接
   采信**。
6. **管道会吃掉退出码**：`cmd | tail` 的 `$?` 是 `tail` 的。本会话第一次基线取证就因此
   把 `check-all` 的失败读成了成功。凡取证必须显式取 `PIPESTATUS` 或重定向后单独取 `$?`。
