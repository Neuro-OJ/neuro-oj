# 公开赛开赛前无人值守审计 —— 最终报告（2026-09-28 / 29）

> 窗口：2026-09-28 22:00 → 2026-09-29 07:00（CST）
> Spec：[`2026-09-28-contest-readiness-unattended-audit-design.md`](../../superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md)
> Plan：[`2026-09-28-contest-readiness-unattended-audit.md`](../../superpowers/plans/2026-09-28-contest-readiness-unattended-audit.md)

## 0. 结论（按 spec §6 L5 口径）

**判定：可接受但未完成（L0 零违反；覆盖面远低于计划）。**

| 判据 | 结果 |
|---|---|
| L0 五条红线 | ✅ **零违反**（逐条证据见 §2） |
| 四轴断言矩阵 | ⚠️ **仅 A 轴部分完成**（A1–A5 有结论）；**B/C/D 三轴未开始**（不是"未取证"，是根本没审） |
| 每轴"审计结论 + 已修项 + 未完成项说明" | ⚠️ 仅 A 轴满足；B/C/D 三轴只有"未开始"这一条说明 |
| 面完成数 | **1 / 11**（面 1.1 完成：审计 + 对抗性复核 + 5 项修复 + 成对证据） |

**根因（不是能力问题，是执行窗口问题）**：会话在 2026-09-28 22:23 之后被挂起，
直到 2026-09-29 07:29 才恢复执行——**无人值守窗口内实际只运行了约 40 分钟**。
恢复时已越过 07:00 硬停，按 spec §7 立即停止开新面，只把面 1.1 收口。

证据：`findings/01-judge-availability.md` 时间戳 22:09、`verification/01-judge-availability.md`
时间戳 22:23，而修复类证据（`evidence/01-*`）时间戳为 07:29–07:33；dev 容器 `Up 9 hours`
（我在 22:05 恢复它们）同样印证。

## 1. 交付物

| 交付物 | 位置 / 链接 |
|---|---|
| 栈基设计 token PR（Owner 的 48 文件工作，消息规范化，内容零改动） | [#593](https://github.com/Neuro-OJ/neuro-oj/pull/593)（base `main`） |
| **面 1.1 修复 PR**（5 项修复 + 审计/复核证据 + Action Note） | **[#594](https://github.com/Neuro-OJ/neuro-oj/pull/594)**（base `style/cyber-azure-tokens`） |
| 审计报告 | `findings/01-judge-availability.md` |
| 对抗性复核结论（含假阳性率与 3 条一审漏项） | `verification/01-judge-availability.md` |
| 成对证据（修复前 / 修复后） | `evidence/01-A1-injection-memory.txt`、`01-A2-injection-timeout.txt`、`01-A7-requeue-direction.txt` |
| 基线与环境快照（含环境事故记录） | `baseline.md` |
| 工作日志 | `progress-log.md` |
| 门禁原始输出 | `logs/check-all-baseline.txt`、`logs/check-all-final.txt` |
| Agent Note | `.agents/notes/implemented/bug-fix/2026-09-28-judge-availability-hardening.md` |

## 2. L0 红线核验（实测）

| # | 红线 | 判据与实测 |
|---|---|---|
| 1 | **`main` 零改动** | ① `git rev-parse origin/main` = `6dbdd76b57d7d23ee776a292aebd9a1a8ece0511`（与冻结值一致）② `jj bookmark list main` = `qrsktulv 6dbdd76b`（未前进）③ `git rev-list --count origin/main..contest-readiness/01-judge-availability` = **4**（= 栈基 `4356fe18` 1 个 + `fix` 1 个 + `docs` 2 个；**含栈基提交**，因为栈基尚在 `style/cyber-azure-tokens` 分支、未进入 `main`）④ 远端 heads 只有 `style/cyber-azure-tokens` 与 `contest-readiness/01-judge-availability` **两条分支，无 main 改动** |
| 2 | 不触碰红线文件 | `_journal.json` / `deno.lock` / `Cargo.lock` / `.env.prod` 均**未修改**（`jj status` 实测）；仅 `M .env.prod.example`（示例文件，AGENTS.md 要求新增环境变量必须加入） |
| 3 | 全部提交 GPG 签名 + 中文 Conventional Commits | `37eb5703` `%G? = G`、`aea08343` `%G? = G`；消息分别为 `fix(judge,root): …`、`docs(root): …` |
| 4 | 并发约束（≤1 subagent） | 全程只使用 `subagent` 且**前台等待**；**未使用** Agent Teams（`spawn_teammate`）或 `workflow` 扇出。本会话共 2 次主派发 + 1 次 verifier 派发，全部串行 |
| 5 | 工作副本可续 | 每个 change 自成可编译单元；`jj status` 收尾干净；进度日志可续 |

## 3. 四轴断言矩阵（spec §6 L3）

| 轴 | 状态 | 说明 |
|---|---|---|
| **A 评测机可用性** | 🟡 **部分完成** | A1/A2/A4/A5 **已修且有证据**；A3 经复核判定**证伪**（原 finding 不成立） |
| **B 容器逃逸** | ⛔ **未开始** | 面 1.2 / 1.3 未执行——需 e2e 栈与真实容器实测，本轮**未取证** |
| **C 数据泄露** | ⛔ **未开始** | 面 1.4 未执行（9-28 的"枚举式修复"弱点仍是最大未知） |
| **D 赛时公平性** | ⛔ **未开始** | 面 1.5 未执行；VULN-04/05 的裁定仍未落定 |

A 轴逐条结论：

| 断言 | 结论 | 证据 |
|---|---|---|
| A1 单次恶意提交不能永久占死槽位 | **已修**：注入写超时（NOJ-A2） | `evidence/01-A2-injection-timeout.txt` |
| A2 总超时在所有路径有效 | **已修**：注入期 5 处阻塞调用全部加本地超时 | 同上；代码 `sandbox/container.rs` |
| A3 崩溃重启后孤儿容器被回收 | **维持已修**（9-28 的 VULN-15 成立）；残留窗口 NOJ-A8 未修（靠下次启动自愈） | `verification/01-*` |
| A4 资源限制不可绕过 | **部分**：容器侧限制经复核**未发现绕过**；但 **judge 进程自身内存**曾可被放大（NOJ-A1，已减半）；D1（压缩体积 vs 解压体积无不变量校验）**未修** | `evidence/01-A1-injection-memory.txt` |
| A5 单条任务不整体阻塞队列 | **已修**：重投方向（NOJ-A7）恢复真正退避，不再每 100ms 空转；claim 崩溃后回收（NOJ-D2）消除"1 小时不可用" | `evidence/01-A7-requeue-direction.txt` |

## 4. 面 1.1 全部 finding 处置（10 条 finding + 3 条复核新增）

| id | 复核裁定 | 处置 |
|---|---|---|
| NOJ-A1（Critical，内存双份驻留） | 机制确认、后果部分证伪（需并发叠加） | ✅ **已修**（峰值降 50%） |
| NOJ-A2（High，注入写无超时） | 确认 | ✅ **已修**（5 处阻塞调用加超时） |
| NOJ-A3（Medium，JoinHandle 只增不减） | **证伪** | ⛔ 不修（原 finding 不成立） |
| NOJ-A4（Medium，checksum 不对称致全题失败） | 部分确认、**"存量任务每次 SystemError"证伪**（无可达来源） | ⛔ 不修，记录不对称性 |
| NOJ-A5（Medium，drain 强杀致孤儿容器） | 部分确认、**归因错**（真因是 D3） | ✅ 由 D3 修复覆盖 |
| NOJ-A6（Low-Med，空 user_id 共享 claim key） | **存疑**（机制成立，"无限饿死"未证） | ⏸ 未修（有 4 次/60s 限流托底）；建议随面 6 一并处理 core 侧 `sweeper.ts:284` |
| NOJ-A7（Low-Med，重投方向反了） | 确认，且复核发现"同端重弹"比初稿更严重 | ✅ **已修**（`LPUSH`） |
| NOJ-A8（Low，create_container 超时窗口孤儿） | 部分确认、"永不被清理"证伪 | ⏸ 未修（下次启动自愈） |
| NOJ-A9（Low，死信列表无上限） | 确认（卫生项） | ⏸ 未修 |
| NOJ-A10（Low，多副本实例 ID 相同互删） | 确认（后果修正为"结果被覆盖为 error 终态"） | ⏸ 未修（生产单副本默认不触及） |
| **D1**（中高，复核新增：core 压缩体积限额与 judge 内存预算脱钩） | 确认 | ⏸ **未修，需 Owner 裁决**（见 §5） |
| **D2**（中，复核新增：崩溃后 claim 1 小时不可用） | 确认 | ✅ **已修**（启动期回收） |
| **D3**（中，复核新增：compose 缺 stop_grace_period） | 确认 | ✅ **已修**（`JUDGE_STOP_GRACE_PERIOD=120s`） |

**修复 5 项 · 证伪 1 项 · 记录不修 6 项 · 待裁决 1 项。假阳性率 1/10（10%）。**

## 5. 待人工 review 清单

1. **[需裁决] D1 —— 限额口径脱钩**：core 按**压缩体积**（`DEFAULT_ARTIFACT_MAX_SIZE_BYTES=2GiB`，
   题目 `artifact_max_size_mb` 默认 null）限额，judge 按**解压体积**（512MiB）限额，
   两者**无任何不变量校验**。实测压缩比可达 1030:1。建议二选一：(a) core 侧按题目声明
   "解压后总量上限"；(b) judge 引入 inflight 输入内存预算令牌（`JUDGE_MAX_INFLIGHT_INPUT_BYTES`），
   而不是逐路径打补丁。
2. **[需裁决] B/C/D 三轴是否择期补做**：这是本次开赛前加固的**主体**，未做。
   其中 1.4（core 数据泄露读路径矩阵）风险最高：9-28 的修法是"枚举读路径 + 注入过滤谓词"，
   **漏一条读路径即漏密**，而本轮正打算用穷举矩阵验证它——没做。
3. **[未取证] 所有依赖真实容器的结论**：`NOJ_RUN_E2E=1` 的 Docker E2E、容器逃逸实测、
   `noj-eval-net` 实际隔离效果，本轮**一律未执行**；评测镜像也未按当前工作树重建。
   **不得把本轮 judge 修复当作"已在真实沙箱上验证过"。**
4. **[存疑] NOJ-A6**（空 `user_id`）与 NOJ-A8（超时窗口孤儿容器）：前者建议连同
   `noj-core/src/domains/submission/mq/sweeper.ts:284` 的 `?? ""` 一起改；后者建议给
   心跳孤儿计数加阈值告警。
5. **[被证伪，无需行动] NOJ-A3 / NOJ-A4 的原始表述**：已记入复核文档，供后续审计避免重复报。
6. **[未审模块的风险提示] `noj-cli` 与 `noj-lmcc-extension`**：按 Owner 选择本轮不审。
   你开赛前要用 `noj-cli` 做生产部署/备份/恢复——它的安全面（命令注入、路径穿越、
   凭据落盘、恢复演练的安全默认）**今晚完全没有审计**。
7. **[仓库缺陷，本轮未修] `scripts/e2e/setup.sh` 与 dev 共用 compose 项目名 `neuro-oj`**：
   任何人在 dev 基础设施运行时执行它，都会把 `noj-postgres/redis/minio` 重建为 `noj-e2e-*`
   （本会话实际发生并已恢复，数据无损）。修法：脚本内固定 `-p noj-e2e` 或
   `COMPOSE_PROJECT_NAME=noj-e2e`。建议尽快修——它会让下一个不知情的人踩同一个坑。

## 6. 环境事故与绕行（Owner 必须知晓）

### 6.1 dev 基础设施被 e2e 启动脚本"接管"（已修复，数据无损）

细节见 `baseline.md` §4。要点：`bash scripts/e2e/setup.sh` 因 compose 项目名共用而重建了
dev 的 postgres/redis/minio；已用 `docker compose -f docker-compose.yml up -d` 恢复
（三容器 `Up`、5432/6379/9000/8001 全 OPEN）；**三个数据卷未被重建**
（创建时间 2026-06-30 / 07-03，远早于本会话），恢复后 SQL 连通性复核正常。

### 6.2 会话沙箱使 `$HOME` 只读（已绕行）

`~/.cache/deno`（4.8G）与 `~/.docker` 不可写，导致**两条误导性极强的症状**：
"jsr.io 下载失败"（实际是缓存不可写，jsr.io 实测 HTTP 200）与
"docker buildx: read-only file system"。绕行：`DENO_DIR=<repo>/node_modules/.deno_cache`
（放在仓库根会让 `verify-md-links` 报 5560 条假红——它只跳过 `node_modules`）、
`DOCKER_CONFIG=/tmp/docker-cfg`。

## 7. 本轮取证强度的自查（不足，不掩饰）

1. **没有干净的改动前基线**：首次 `check-all` 被我自己的缓存放置错误污染（5560 条假红），
   因此"不回归"的证据是"改动后各套件全绿"，而非"失败数不增加"。
2. **A1 的内存证据是单元级的**：用线程局部计数分配器在同一进程内对比两条路径
   （60.8MB → 30.4MB）。它**没有**在真实容器里触发过 OOM，因此"512MiB 上限下峰值约
   1.0GiB"是**按比例外推**，不是实测。
3. **A2 的证据是机制级的**：用"永不就绪的写入器"证明超时生效并证明移除超时后测试永久挂起；
   **没有**用真实容器验证"容器侧 `tar xf -` 停读 stdin"这一触发路径。
4. **redis 相关测试连的是 dev Redis DB 9**（不是 e2e 栈的 6380），因为 e2e 栈最终没有启动。
5. **`noj-judge/target/release/noj-judge` 虽已重建**，但本轮测试跑的是 debug 构建。
6. **§2 曾把"栈上提交数 = 2"当作事实写下但未实测**，实际为 4（含栈基提交）。已在核验时
   发现并改正——这类"凭计划推断代替实测"的写法正是本仓库反复治理的假绿形态，记在此处
   作为对自己的警示。

## 8. 续跑建议（给下一次无人值守）

1. **先把窗口当硬约束做减法**：11 个面的计划需要约 15–20 小时串行工作量；9 小时只够
   4–5 个面。下次应把面清单**直接砍到能做完的数量**（例如只做 1.2/1.3/1.4 + 收尾），
   并在 spec 里写明"每面 90 分钟硬上限，超时立刻降级为记录"。
2. **开工前先跑环境探针**（`DENO_DIR` / `DOCKER_CONFIG` / `/tmp` 可写性 / compose 项目名隔离），
   探针失败先修环境再开始审计——否则会把环境问题误判为代码缺陷（本会话差点如此）。
3. **保留"每面一个可独立回滚的 change"这一条**：本次 fix 与 docs 分开提交，rollback 面清晰。
4. **坚持"审计 → 对抗性复核 → 修复"三段**：本次复核证伪 1/10、纠正 5 条后果表述、
   补出 3 条漏项，收益极高，不可省。
5. **取证纪律**：永远显式取退出码（`PIPESTATUS` 或重定向后单独 `$?`）；反向验证不要依赖
   `/tmp` 备份（本次一次 `cp` 到 `/tmp` 的备份在下一条命令里已消失）。
6. **会话可能被挂起**：若要在窗口内保证完成，必须在**开始时**按可用时间裁剪目标，
   而不是假定整夜可用。
