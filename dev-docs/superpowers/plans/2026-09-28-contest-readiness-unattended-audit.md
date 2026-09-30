# 公开赛开赛前无人值守审计与自动修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **本计划由 Lead 亲自执行**（用户明确协议：subagent 只做审计与证伪，**修复必须由 Lead 自己做**），因此不使用 subagent-driven-development 的"每任务一个实现 subagent"模式。

**Goal:** 在 22:00–07:00 的无人值守窗口内，对 Neuro OJ 做四轴定向审计（评测机可用性 / 容器逃逸 / 数据泄露 / 赛时公平性）并自行完成修复，剩余预算对其余六面做广度二次审计，全部以分支 + Draft PR 交付，绝不触碰 `main`。

**Architecture:** 每面一轮"审计 → 复核 → 修复 → 收口"循环：单个 subagent 串行做只读审计并产出结构化 finding 表 → Lead（或 finding >5 时另派 verifier subagent）做证伪复核，三态裁定 → **只有"确认"的 finding 由 Lead 亲自修复**，每条修复带 before/after 成对证据与回归测试 → 门禁全绿后写 Agent Note，`jj describe` + `jj new` 收口 → 每面一个 bookmark + Draft PR。

**Tech Stack:** Deno 2.9.7（noj-core / noj-ui / noj-cli / noj-llm-gateway / noj-tests）、Rust 1.99-nightly + Tokio + bollard（noj-judge）、PostgreSQL 16、Redis 7、MinIO、Docker Compose、jj（Jujutsu）+ GPG。

**Spec:** [`dev-docs/superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md`](../specs/2026-09-28-contest-readiness-unattended-audit-design.md)

---

## Global Constraints

以下为项目级硬约束，**每个 Task 的要求都隐含包含本节**。数值均逐字取自 spec。

- 执行窗口 **2026-09-28 22:00 → 2026-09-29 07:00（CST）**；**07:00 硬停**；**06:00 后不开新面**。
- **`main` 零改动**：会话开始时 `origin/main` = `6dbdd76b`；结束时该 SHA 不变；本地 `main` bookmark（`qrsktulv`）不前进；无任何对 main 的 push / merge / tag。
- **禁止触碰**：`noj-core/drizzle/meta/_journal.json`、`deno.lock`、`Cargo.lock`、`.env.prod`、真实凭据、生产数据库。
- **禁止并发 subagent**：同一时刻 ≤1 个 subagent 活动。**禁用 `spawn_teammate`（Agent Teams）与 `workflow` 扇出**。后台 bash 作业（编译 / 门禁 / docker / 测试）不占 API 并发，允许并行。
- 提交格式 `<type>(<scope>): <中文描述>`，type ∈ `feat|fix|docs|style|refactor|perf|test|chore|ci|build`，scope ∈ `core|ui|judge|root`；**全部提交 GPG 签名**（`jj signing.sign-all = true`，key `F2228B681060D92532F4528974E9300535E7C223`）。
- 搜索用 `rg`，不用 `grep`。按域测试必须用 `deno task test:domain <domain>`，**禁止手拼 `deno test`**。
- **否定性结论必须二次检索**（同义词 + 行为描述各一次）：`grep 0 命中 ≠ 不存在`。
- 单条 finding 修复尝试上限 **3 次**，超限记录根因并跳过；**不做半成品提交**。
- 高危面（judge 沙箱实现、Dockerfile/compose 生产拓扑、数据库迁移、认证/授权语义、core↔judge 契约）改动必须有 before/after 证据 + 回归测试 + 回滚说明；**拿不到证据则该 change 不进栈**，降级为报告里的补丁提案。
- 无法在本环境取证的项**不得标"完成"**，只能"已修待复验"或"未开始"，并写明复验条件。
- 产物根目录：`dev-docs/unattended/2026-09-28/`。

---

## 统一执行循环（Task 模板 T，规范定义）

**Task 1–12 的每一个面都严格按本节步骤执行**；各 Task 只提供自己的差异化参数（审计面、任务书要点、断言映射、复核重点）。本节即完整步骤，不引用计划外文档。

### T.1 派发审计 subagent（前台等待）

- 用 `subagent` 工具，**`run_in_background: false`**（前台等待，保证串行）。
- 任务书按下表填充（完整模板，逐字使用）：

```text
你是 Neuro OJ 的定向安全审计员。本次审计面：<面名>。任务类型：<I 新面 / II 二次审计>。

【仓库】/home/xyber-nova/Github/neuro-oj
【只读约束】不得修改任何文件，不得提交，不得推送，不得运行任何写操作（含 docker run 之外的破坏性命令）。
【检索】必须用 rg（本仓约定），不要用 grep。
【否定性结论】"不存在"/"已修好"必须给二次检索证据：同义词 + 行为描述各再检索一次。
  仓规：`grep 0 命中 ≠ 不存在`（历史教训：把真实存在的 fuzz 测试误判为"文档虚报"）。
【每条 finding 必须可复现】给最小触发路径（请求样例 / 命令 / 测试文件:行）；
  不接受"可能有风险"的推测式结论；不接受无位置的结论。
【严重度口径】
  Critical = 可直接导致开赛事故（卡死评测 / 逃逸 / 整题泄露 / 赛中批量串通）
  High = 单点可利用且有实际后果
  Medium = 需要前置条件或影响有限
  Low = 加固建议
【上一轮既有结论】（类型 II 必读；类型 I 也须读以避免重报）
<在此粘贴：相关 VULN 清单 + 残留表条目 + 对应 Agent Note 结论摘要>
【本面主攻方向】<面清单>
【类型 II 的额外强制任务】
  (a) 对每条"已宣布修复"的 VULN **构造绕过尝试**——目标是推翻"已修好"的结论，不是复述它；
  (b) **漏网搜索**：找同类但上一轮未枚举到的路径（9-28 的泄露修法是"枚举读路径 + 注入过滤谓词"，
      漏掉任一读路径即漏密，这是结构性弱点）。
【交付格式】只输出结构化报告，不要过程叙事：
  表：| id | 严重度 | 位置 file:line | 触发路径/最小 PoC | 影响面（谁能触发、后果） | 与上一轮关系（新发现/已修仍可绕过/上轮已裁定重提+新证据） | 复核建议 |
  加两节：① 已审但未发现问题的子面清单（附检索证据）；② 需要人工裁决的设计级问题。
```

- 超时熔断：>25 min 未返回视为失败，记录后可重派 1 次；再失败即弃面并记录。

### T.2 报告落盘

```bash
mkdir -p dev-docs/unattended/2026-09-28/{findings,verification,evidence,logs}
# 将 subagent 原始报告写入
# dev-docs/unattended/2026-09-28/findings/<NN>-<face>.md
# 文件头部补两行元信息：
#   > 审计面：<面名> ｜ 类型：<I/II> ｜ 派发时间：<HH:MM> ｜ 返回时间：<HH:MM>
#   > Lead 复核：见 verification/<NN>-<face>.md
```

### T.3 复核（防假阳性）

- 门槛：finding **≤5 条 → Lead 自审**；**>5 条 → 另派 verifier subagent**。
- verifier 任务书与首轮**不同**：目标是**尽力推翻**每条 finding，逐条给"确认 / 证伪 / 存疑"。
- 复核结论写入 `dev-docs/unattended/2026-09-28/verification/<NN>-<face>.md`，格式：

```text
| finding id | 复核结论 | 复核方式（Lead 自审 / verifier） | 证据 |
```

- 三态口径：**确认**才进入修复；**证伪**进报告并附证伪证据；**存疑**进"待人工裁决"。
- 记录本面假阳性率 = 证伪数 / 总 finding 数。

### T.4 逐条修复（Lead 亲自）

对每条"确认"的 finding：

1. **先写复现**：最小 PoC（命令 / 请求 / 测试），**跑一次拿到失败输出**并保存到
   `dev-docs/unattended/2026-09-28/evidence/<face>-<id>-before.txt`。
2. **写回归测试**：新增测试必须能在**修复前失败**。验证方式：先只加测试不加修复，跑一次确认失败
   （输出存 `evidence/<face>-<id>-test-before.txt`），再实施修复。
3. **实施修复**（最小改动；超高危面按 Global Constraints 附回滚说明）。
4. **反向验证**：跑同一测试与同一 PoC，确认转为通过/被阻断
   （输出存 `evidence/<face>-<id>-after.txt`）。
5. **模块门禁**（按触及模块选择，全部为必须）：

```bash
# noj-core（触及 core 时）
cd noj-core && deno task check && deno task test:domain <domain>
# noj-ui
cd noj-ui && deno task check && deno task test
# noj-judge（触及 judge 时）
cd noj-judge && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo nextest run --all-targets
# noj-llm-gateway
cd noj-llm-gateway && deno task check && deno task test
# root
deno run -A scripts/check-all.ts
```

6. **不新增静默跳过**：`deno run -A scripts/silent-skip-report.ts --check` 必须通过。

### T.5 Agent Note

- 路径：`.agents/notes/implemented/<分类>/2026-09-28-<slug>.md`（分类 ∈
  `bug-fix|feature|simplification|architecture|process|testing`）。
- 必须含 `# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` /
  `## Alternatives considered` / `## Consequences`。
- 校验：`deno run -A scripts/verify-agent-note-format.ts` 必须通过。

### T.6 收口提交

```bash
jj describe -m "<type>(<scope>): <中文描述>"
jj new
```

- 一个面内**每条修复各自一个 change**（即每条修复独立走一次 T.5 + T.6）。
- 面结束后打 bookmark：

```bash
jj bookmark create contest-readiness/<NN>-<face> -r @-
jj git push --bookmark contest-readiness/<NN>-<face>
gh pr create --draft --base <栈内前一个 bookmark 或 main> \
  --title "<type>(<scope>): <中文描述>" \
  --body "见 dev-docs/unattended/2026-09-28/final-report.md 对应章节"
```

- 每面结束后向 `dev-docs/unattended/2026-09-28/progress-log.md` 追加时间线条目。

---

## Task 0: 前置冻结（22:00–22:40）

**Files:**
- Create: `dev-docs/unattended/2026-09-28/baseline.md`
- Create: `dev-docs/unattended/2026-09-28/progress-log.md`
- Create: `dev-docs/unattended/2026-09-28/logs/`（基线命令输出）
- Modify（仅补提交消息，不改内容）: `e515aafb`

**Interfaces:**
- Produces: 锚点 SHA（`origin/main` = `6dbdd76b`）、jj bookmark 栈基、门禁基线快照、judge 二进制构建时间与镜像 digest —— 后续所有 Task 的对照基准。

- [ ] **Step 1: 冻结锚点并核验红线可满足**

```bash
cd /home/xyber-nova/Github/neuro-oj
date                                            # 记录开始时间
git rev-parse origin/main                       # 期望 6dbdd76b57d7d23ee776a292aebd9a1a8ece0511
git rev-list --count origin/main..HEAD          # 期望 1（e515aafb）
jj bookmark list main                           # 期望 qrsktulv 6dbdd76b
jj status                                       # 期望 "The working copy has no changes."
jj config get signing.sign-all                  # 期望 true
```

- [ ] **Step 2: 给 `e515aafb` 补合规提交消息（不重写内容）**

```bash
jj describe -r @- -m "style(ui,root): 全站配色对齐 noj-docs 浅蓝科技调并同步设计 token 规范"
jj log -r @- --no-graph -T 'commit_id.short() ++ " " ++ description.first_line() ++ "\n"'
```

预期：输出含 `style(ui,root): 全站配色对齐 noj-docs 浅蓝科技调并同步设计 token 规范`。
> 备选（若 Owner 不希望推送该提交）：改为 `jj rebase -d main@origin` 把今晚的栈挪到
> `origin/main` 之上，让 `e515aafb` 留在本地不动。**二选一，默认执行本 Step 的补消息方案。**

- [ ] **Step 3: 把 `e515aafb` 作为独立 Draft PR 推出（使后续 PR 的 base 成立）**

```bash
jj bookmark create style/cyber-azure-tokens -r @-
jj git push --bookmark style/cyber-azure-tokens
gh pr create --draft --base main \
  --title "style(ui,root): 全站配色对齐 noj-docs 浅蓝科技调并同步设计 token 规范" \
  --body "设计 token 统一（48 文件）。Agent Note: .agents/notes/implemented/feature/2026-09-28-unify-cyber-azure-design-tokens.md"
```

- [ ] **Step 4: 记录门禁与测试基线（后台作业，不占 API 并发）**

```bash
mkdir -p dev-docs/unattended/2026-09-28/{findings,verification,evidence,logs}
deno run -A scripts/check-all.ts 2>&1 | tee dev-docs/unattended/2026-09-28/logs/check-all-baseline.txt | tail -20
```

> 若基线**不绿**：按 Global Constraints，先在 `origin/main` 的独立副本上复现同样失败以定性
> "是否 main 固有"，把结论与失败清单写进 `baseline.md`。**不绿不是阻塞项**，但它是后续
> "失败数不增加"的对照基准。

- [ ] **Step 5: 重建 judge 二进制（关键：本机二进制是 9-11 的，早于 9-28 加固）**

```bash
cd noj-judge && cargo build --release 2>&1 | tail -5
ls -l --time-style=full-iso target/release/noj-judge
```

预期：构建时间变为今晚；把构建时间写入 `baseline.md`。

- [ ] **Step 6: 起 e2e 栈并确认 `noj-eval-net` 真实存在**

```bash
bash scripts/e2e/setup.sh 2>&1 | tail -30
docker network inspect noj-eval-net --format '{{.Name}} | containers={{len .Containers}}' 2>&1
docker network inspect noj-eval-net --format '{{range .Containers}}{{.Name}} {{end}}' 2>&1
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedSince}}' | rg 'noj-(evaluator|solution)-python:latest'
```

预期：`noj-eval-net` 存在；容器列表**只应含** `noj-e2e-llm-gateway`（隔离生效的判据）；
记录 evaluator/solution 镜像的 ID 与创建时间到 `baseline.md`。
> 注意：e2e 栈使用独立端口（PG 5433 / Redis 6380 / core 8099 / MinIO 9002），与在跑的
> dev 基础设施（5432 / 6379 / 9000）不冲突。

- [ ] **Step 7: 写 `baseline.md` 与 `progress-log.md`**

`baseline.md` 必须含：锚点 SHA、jj 状态、门禁基线输出摘要、judge 二进制构建时间、
`noj-eval-net` inspect 结果、镜像 digest、以及"哪些基线的红是 main 固有"的定性结论。

- [ ] **Step 8: 提交前置产物**

```bash
jj describe -m "docs(root): 新增公开赛开赛前无人值守审计 spec 与实施计划"
jj new
```

**验收（Task 0 完成判据）**：`baseline.md` 存在且含 Step 1/4/5/6 的全部实测输出；
`origin/main` 仍为 `6dbdd76b`；`jj status` 干净。

---

## Task 1: 面 1.1 — noj-judge 可用性（评测机被卡）

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/01-judge-availability.md`
- Create: `dev-docs/unattended/2026-09-28/verification/01-judge-availability.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/01-*.txt`
- Test: `noj-judge/tests/` 或 `noj-judge/src/**` 内既有测试文件的扩展

**Interfaces:**
- Consumes: Task 0 的 judge 二进制构建时间与镜像 digest。
- Produces: bookmark `contest-readiness/01-judge-availability` + Draft PR。

**本面任务书要点（填入模板 T.1）**

- 类型：**II 二次审计**。
- 上一轮结论（须粘贴进任务书）：VULN-15（实例标识 `{HOSTNAME}-{PID}` 导致孤儿容器清扫失效）已修为
  `resolve_instance_id` 12 位哈希 + 双标签；VULN-16（写管道无超时导致编排死锁）已修为
  `PIPE_WRITE_TIMEOUT = 3s` + `PipeWriteOutcome`；VULN-17（支持包逐文件 exec）已修为单 tar 单次 exec；
  VULN-18（支持包失败静默放行）已修为 `return Err`；VULN-14（Solution 可发 `FRAME_SHUTDOWN`）
  裁定 Won't Fix；VULN-19（ZIP 全量驻留堆内存，512MB 峰值）未做流式；多副本
  `WORK_DIR/.instance_id` 共享风险已在 `noj-judge/AGENTS.md` 标注。
- 主攻方向：槽位永久占用、总超时在**所有**路径的有效性、孤儿容器回收、队列背压与优先级、
  资源限制绕过（无限输出 / fork bomb / 内存爆炸 / 写满磁盘 / 编译轰炸 / 大量小文件注入）、
  并发洪峰；并**尝试推翻** VULN-14/19 的裁定与多副本约束的实际风险。
- 已知覆盖盲区（要求重点核）：`judge::runner` 支持包失败早退**只有单元测试**；
  `drain::cleanup_containers_after_drain` **无 E2E**。

**验收断言映射**：spec §6 L3 的 **A1–A5**（输入 → 期望 → 实测输出，逐条落表）。

- [ ] **Step 1: 执行模板 T.1（派发前台 subagent）**
- [ ] **Step 2: 执行模板 T.2（报告落盘）**
- [ ] **Step 3: 执行模板 T.3（复核三态 + 假阳性率）**
- [ ] **Step 4: 实测 A1–A5**（每条的输入与期望见 spec §6 L3；命令示例）

```bash
# A1/A2：单次恶意提交不能永久占死槽位
cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_abnormal -- --ignored --test-threads=1
# A3：孤儿容器回收（重启后按实例标签清扫）
docker ps -a --filter 'label=com.noj.managed-by=noj-judge' --format '{{.ID}} {{.Names}} {{.Status}}'
# A4：资源限制
NOJ_RUN_E2E=1 cargo test --test e2e_resource_limits -- --ignored --test-threads=1
# A5：队列语义
NOJ_RUN_E2E=1 cargo test --test e2e_problem_limits -- --ignored --test-threads=1
```

- [ ] **Step 5: 逐条执行模板 T.4（修复 + 成对证据 + 门禁）**
- [ ] **Step 6: 逐条执行模板 T.5（Agent Note）**
- [ ] **Step 7: 执行模板 T.6（收口 + bookmark + Draft PR）**

**本面完成判据**：A1–A5 每条都有"输入 / 期望 / 实测输出"三列结论；
`findings/01-*.md` 与 `verification/01-*.md` 存在且含假阳性率；
所有"确认"项已修且有 before/after 证据；`cargo nextest run --all-targets` 与
`deno run -A scripts/check-all.ts` 绿。

---

## Task 2: 面 1.2 — noj-judge 沙箱与容器逃逸

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/02-judge-sandbox-escape.md`
- Create: `dev-docs/unattended/2026-09-28/verification/02-judge-sandbox-escape.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/02-*.txt`
- 可能 Modify: `noj-judge/src/sandbox/*`、`noj-judge/src/dual/*`、`noj-judge/sdk/**`、
  `noj-judge/Dockerfile*`（视 finding 而定）

**Interfaces:**
- Consumes: Task 0 的镜像 digest；Task 1 的容器生命周期结论。
- Produces: bookmark `contest-readiness/02-judge-sandbox-escape` + Draft PR。

**本面任务书要点**

- 类型：**II**。
- 上一轮结论：VULN-21（tmpfs 缺执行位约束）已加 `noexec,nosuid,nodev`；VULN-22
  （`noj-download://local` 无告警）已加 warn + `redact_local_path`；VULN-20（Evaluator 默认
  bridge）已改 `noj-eval-net`。容器基线：`cap_drop ALL`、`no-new-privileges`、
  `network_mode none`（除联网题）、`ipc_mode none`、`pids_limit 256`；ZIP 拒绝路径穿越、
  ≤1000 条目 / 64MiB 单文件 / 512MiB 总解压。
- 主攻方向：cap / privileges / network / ipc / pids / tmpfs / user 的实际生效性、挂载面、
  宿主 docker socket 暴露、**镜像内 SDK 与 evaluator runner 的攻击面**、
  `noj-download://` 协议面、解压路径（`../` 穿越、绝对路径、symlink / hardlink 逃逸、解压炸弹）。
- 强制要求：**逐条核对"代码里写了限制"与"容器里真的生效"**（用 `docker inspect` 实测，
  不接受只读代码就下结论）。

**验收断言映射**：spec §6 L3 的 **B1–B6**。

- [ ] **Step 1: 执行模板 T.1（派发前台 subagent）**
- [ ] **Step 2: 执行模板 T.2（报告落盘）**
- [ ] **Step 3: 执行模板 T.3（复核三态 + 假阳性率）**
- [ ] **Step 4: 实测 B1–B6**（真实 e2e 栈内构造探针容器；命令示例）

```bash
# B1/B2：Evaluator 网络可达性（DNS 与路由都必须不可达）
docker run --rm --network noj-eval-net noj-evaluator-python:latest \
  sh -c 'getent hosts noj-postgres; getent hosts noj-core; timeout 3 sh -c "echo > /dev/tcp/172.17.0.1/5432" && echo REACHABLE || echo BLOCKED'
# B3：cap / no-new-privileges / docker.sock
docker inspect <evaluator-container> --format '{{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}'
# B4：tmpfs 挂载选项
docker inspect <evaluator-container> --format '{{json .HostConfig.Tmpfs}}'
# B5：解压路径（用既有 ZIP 安全测试 + 自造恶意 zip）
cd noj-judge && cargo test extract_zip -- --nocapture
# B6：Evaluator 只能触达 llm-gateway
docker exec <evaluator-container> sh -c 'getent hosts noj-llm-gateway || getent hosts noj-e2e-llm-gateway'
```

- [ ] **Step 5: 逐条执行模板 T.4（修复 + 成对证据 + 门禁）**
- [ ] **Step 6: 逐条执行模板 T.5（Agent Note）**
- [ ] **Step 7: 执行模板 T.6（收口 + bookmark + Draft PR）**

**本面完成判据**：B1–B6 每条有实测命令与输出；"代码写了限制"与"实际生效"逐条对照完毕；
所有"确认"项已修且有成对证据；`NOJ_RUN_E2E=1` 的 judge E2E 套件绿。

---

## Task 3: 面 1.3 — root / compose 生产拓扑隔离

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/03-prod-topology-isolation.md`
- Create: `dev-docs/unattended/2026-09-28/verification/03-prod-topology-isolation.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/03-*.txt`
- 可能 Modify: `docker-compose.prod.yml`、`docker-compose.e2e.yml`、`.env.prod.example`、
  `noj-cli/`（**注意：`noj-cli` 不在审计范围内，但若拓扑修复必须同步其默认值，属"修复的必然连带"，
  需在 Agent Note 里显式标注**）

**Interfaces:**
- Consumes: Task 0 的 `noj-eval-net` inspect 结果；Task 2 的容器网络结论。
- Produces: bookmark `contest-readiness/03-prod-topology-isolation` + Draft PR。

**本面任务书要点**

- 类型：**II**。
- 上一轮结论：`docker-compose.prod.yml` 新增 `noj-eval-net`（显式 `name:`
  `NOJ_EVAL_NETWORK_NAME` 可覆盖）；只有 `llm-gateway` 双网卡（`noj-net` + `noj-eval-net`），
  是唯一受控入口；`noj-judge` 的 `evaluator_network_mode` 默认 `noj-eval-net` 且在
  `Config::validate()` 里**拒绝** `bridge`/`host`；`noj-cli` 两个默认值同步；
  restore-drill 用 `${projectName}_noj-eval-net` 避免冲突。
- 主攻方向：隔离是否**物理层**成立（不只看 compose 文本）、**gateway 双网卡是否成了横向
  通道**（gateway 被 SSRF/被攻破时能否代达内网）、端口暴露矩阵（宿主发布面）、
  judge 容器自身对宿主的面、`NOJ_EVAL_NETWORK_NAME` 被误配时的失效模式、
  多套 stack 同宿主的冲突面。
- 强制要求：**逐条给出 `docker network inspect` / `docker compose config` / 探针实测证据**；
  compose 文本级结论不算证据。

**验收断言映射**：spec §6 L3 的 **B1 / B2 / B6**（拓扑视角）+ 端口暴露矩阵表。

- [ ] **Step 1: 执行模板 T.1（派发前台 subagent）**
- [ ] **Step 2: 执行模板 T.2（报告落盘）**
- [ ] **Step 3: 执行模板 T.3（复核三态 + 假阳性率）**
- [ ] **Step 4: 实测拓扑隔离**

```bash
docker compose -f docker-compose.prod.yml config 2>&1 | rg -n 'networks:|noj-eval-net|noj-net' | head -40
docker network inspect noj-eval-net --format '{{range .Containers}}{{.Name}} {{end}}'
docker network inspect noj-net --format '{{range .Containers}}{{.Name}} {{end}}'
# 端口暴露矩阵
docker compose -f docker-compose.prod.yml config 2>&1 | rg -n 'ports:' -A3 | head -60
```

- [ ] **Step 5: 逐条执行模板 T.4（修复 + 成对证据 + 门禁）**
- [ ] **Step 6: 逐条执行模板 T.5（Agent Note）**
- [ ] **Step 7: 执行模板 T.6（收口 + bookmark + Draft PR）**

**本面完成判据**：`noj-eval-net` 的容器列表与设计意图一致（只应含 gateway 与 Evaluator）；
端口暴露矩阵逐项有裁定；B1/B2/B6 有实测输出；所有"确认"项已修且有成对证据。

---

## Task 4: 面 1.4 — noj-core 数据泄露（全域读路径矩阵）

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/04-core-data-leakage.md`
- Create: `dev-docs/unattended/2026-09-28/verification/04-core-data-leakage.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/04-*.txt`
- 可能 Modify: `noj-core/src/domains/contest/services/problem-secrecy.ts`、
  `contest-window.ts`、`problem-exposure.ts`、`domains/*/routes/*.ts`

**Interfaces:**
- Consumes: 9-28 的 `problem-secrecy.ts` 单一真相源（`unendedPublicContestForProblem` /
  `isProblemInUnendedPublicContest` / `filterUnendedContestIds`）与其回归测试。
- Produces: bookmark `contest-readiness/04-core-data-leakage` + Draft PR。

**本面任务书要点**

- 类型：**II，本面是二次审计的主战场**。
- 上一轮结论：VULN-01（答疑默认全场广播）改为默认私密；VULN-02（题解/讨论门控形同虚设）
  改为服务层写入门控 + 覆盖 `discussion` 与赛前窗口；VULN-03（客观题即时回显对错）改为竞赛
  模式返回回执 + `stripContestJudgement`；VULN-07（题库/聚合页泄露赛题）在列表/题单/个人主页/
  搜索注入 `NOT unendedPublicContestForProblem(...)`；VULN-09（封榜期隐私倒挂）把身份守卫提到
  视图判定之前；VULN-10（提交监听链）剔除 `submission_id` + 订阅前归属校验；
  VULN-11/13（队列泄密与权限倒挂）改为 fail-closed。
- 主攻方向：**穷举读路径**（列表 / 详情 / 搜索 / 题单 / 个人主页 / 导出 / 导出快照 / SSE（实时 +
  重放）/ 队列 / 统计 / 管理端非特权视图 / 通知 / 审计接口 / 对象存储直链与预签名 /
  `problems` bundle 下载），逐条判定是否被 `problem-secrecy` 覆盖。
- 强制任务：对 VULN-01/02/03/07/09/10/11/13 **逐条构造绕过尝试**。
- **判据（本面特有）**：**任一读路径被遗漏即整面不通过**——因为上一轮的修法是"枚举路径并注入
  过滤谓词"，漏路径即漏密。因此本面要求交付一张**完整的读路径矩阵表**（路径 → 是否受控 →
  证据）。

**验收断言映射**：spec §6 L3 的 **C1–C5**，且必须给出穷举矩阵。

- [ ] **Step 1: 执行模板 T.1（派发前台 subagent）**
- [ ] **Step 2: 执行模板 T.2（报告落盘）**
- [ ] **Step 3: 执行模板 T.3（复核三态 + 假阳性率）**
- [ ] **Step 4: 建立读路径矩阵并实测**（别名：先用 `rg` 穷举路由面）

```bash
rg -n "app\.(get|post|put|delete|patch)\(" noj-core/src/domains/*/routes/*.ts | wc -l
rg -n "unendedPublicContestForProblem|isProblemInUnendedPublicContest|filterUnendedContestIds" noj-core/src | wc -l
cd noj-core && deno task test:domain contest
```

- [ ] **Step 5: 逐条执行模板 T.4（修复 + 成对证据 + 门禁）**
- [ ] **Step 6: 逐条执行模板 T.5（Agent Note）**
- [ ] **Step 7: 执行模板 T.6（收口 + bookmark + Draft PR）**

**本面完成判据**：读路径矩阵表完整（每行有"是否受控 + 证据"）；VULN-01/02/03/07/09/10/11/13
的绕过尝试逐条有结论；C1–C5 逐条有实测；所有"确认"项已修且有成对证据。

---

## Task 5: 面 1.5 — noj-core 赛时公平性信道

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/05-core-fairness-channels.md`
- Create: `dev-docs/unattended/2026-09-28/verification/05-core-fairness-channels.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/05-*.txt`
- 可能 Modify: `noj-core/src/domains/contest/**`、`domains/community/**`、`domains/messaging/**`、
  `domains/system/**`（视 finding 而定）

**Interfaces:**
- Consumes: Task 4 的读路径矩阵（两面的信道集合有交叠，避免重复判定）。
- Produces: bookmark `contest-readiness/05-core-fairness-channels` + Draft PR。

**本面任务书要点**

- 类型：**II**。**明确排除反作弊系统的功能设计与改进**——只修"被利用或导致既有防护静默
  失效的 bug"。
- 上一轮结论：VULN-01/02/03（通信与 oracle 通道）、VULN-09/10（榜单与 SSE）、VULN-11/13（队列）
  已修；VULN-04/05（邀请赛挂公开题不受遮蔽，仅前端提示）**维持现状**，需本面给出明确裁定。
- 主攻方向：赛中可用**通信信道**（答疑 / 讨论 / 题解 / 私信 / 社区帖子与评论 / 公告 /
  训练与题单共享 / 用户名与个人主页），赛中可用的**探测信道**（排名变化、提交次数、
  评测耗时、评测完成时点、SSE 事件、队列位置），**回执 oracle**（任何可做二分探测的回显），
  重测与提交次数上限是否服务端强制，封榜与结算时序倒挂，以及**时间窗口判定的 SSOT 一致性**
  （`problem-secrecy` / `problem-exposure` / `contest-window` / 社区自建 SQL 是否仍各自为政）。
- 强制任务：对 VULN-04/05 给出"维持 or 升级"的明确裁定（附证据）；对"赛中可否用于广播解法"
  给出可判定结论。

**验收断言映射**：spec §6 L3 的 **D1–D5**，且必须给出**信道矩阵表**（信道 → 断言 → 实测）。

- [ ] **Step 1: 执行模板 T.1（派发前台 subagent）**
- [ ] **Step 2: 执行模板 T.2（报告落盘）**
- [ ] **Step 3: 执行模板 T.3（复核三态 + 假阳性率）**
- [ ] **Step 4: 建立信道矩阵并实测**

```bash
rg -n "is_public|notGatedContestContent|runningContest|unendedWindowCondition" noj-core/src | head -40
cd noj-core && deno task test:domain contest && deno task test:domain community && deno task test:domain messaging
```

- [ ] **Step 5: 逐条执行模板 T.4（修复 + 成对证据 + 门禁）**
- [ ] **Step 6: 逐条执行模板 T.5（Agent Note）**
- [ ] **Step 7: 执行模板 T.6（收口 + bookmark + Draft PR）**

**本面完成判据**：信道矩阵表完整；D1–D5 逐条有实测；VULN-04/05 有明确裁定与证据；
所有"确认"项已修且有成对证据。

---

## Task 6: Phase 1 收口（不晚于 03:00）

**Files:**
- Create: `dev-docs/unattended/2026-09-28/final-report.md`（先建骨架，Task 13 补全）

- [ ] **Step 1: 核验 Phase 1 五面全部满足各自完成判据**；未满足的面在 `progress-log.md` 记为"进行中"并写明卡点。
- [ ] **Step 2: 记录 Phase 1 断言矩阵总表**（A1–A5 / B1–B6 / C1–C5 / D1–D5 每条的结论三态：通过 / 已修 / 未取证）。
- [ ] **Step 3: 核验 L0 红线**（`origin/main` 仍为 `6dbdd76b`；`main` bookmark 未前进；提交签名有效）：

```bash
git rev-parse origin/main
jj bookmark list main
git log --show-signature -1 --format='%H %G? %s' | head -3
```

- [ ] **Step 4: 提交收口产物**

```bash
jj describe -m "docs(root): 公开赛开赛前无人值守审计 Phase 1（四轴）结论与断言矩阵"
jj new
```

---

## Task 7: 面 6 — noj-core 非四轴残余面

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/06-core-residual.md`
- Create: `dev-docs/unattended/2026-09-28/verification/06-core-residual.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/06-*.txt`

**本面任务书要点**：类型 **I + II**（混合：9-15 全量审计覆盖过的面属 II）。
主攻 RBAC/越权、限流（含 `rate_limit_search_max_ip_total` 兜底的实际语义）、输入校验与
分页上界（9-21 修过 `parsePage` 与 `/internal/usage`，须做同类漏网搜索）、事务与竞态、
MQ 消费（消费者自愈、幂等）、错误处理与日志脱敏（UUID 截断 / score 隐藏 / DB 密码脱敏）。
上一轮结论：BYOK 白名单按请求作用域判定；分页上界 `MAX_SAFE_PAGE`；搜索限流 IP 兜底默认 600。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `06-core-residual`，bookmark `contest-readiness/06-core-residual`）

**完成判据**：报告含假阳性率与"审过无问题"子面清单；所有"确认"项已修且有成对证据；
`cd noj-core && deno task check` 与 `bash scripts/test-shared.sh` 绿。

---

## Task 8: 面 7 — 测试体系健康度

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/07-test-health.md`
- Create: `dev-docs/unattended/2026-09-28/verification/07-test-health.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/07-*.txt`
- 可能 Modify: `scripts/check-test-discovery.ts`、`scripts/gate-list.ts`、
  `scripts/silent-skip-report.ts`、`dev-docs/engineering/test-silent-skips.baseline.json`

**本面任务书要点**：类型 **II**。主攻假绿形态：写了却永不执行的测试（含
"先定义后调用的工厂"这一 9-21 已知局限）、门禁双入口分叉、静默跳过棘轮的绕过方式、
覆盖率报告口径、`GATE_SELF_TESTS` 登记完整性、测试发现性启发式的双向失准。
上一轮结论：`scripts/*_test.ts` 必须全部登记的元自检已加入；`GATE_SELF_TESTS` 已补 6 项；
`looksLikeFunctionBrace` / `isImmediatelyInvoked` 已修正，已知局限为
`function make() { Deno.test(…) } make();`。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `07-test-health`，bookmark `contest-readiness/07-test-health`）

**完成判据**：`deno run -A scripts/check-all.ts` 绿；`silent-skip-report --check` 绿；
报告含"当前仍存在的假绿面"清单与各自的守卫方式。

---

## Task 9: 面 8 — root / scripts / CI 供应链

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/08-root-ci-supply-chain.md`
- Create: `dev-docs/unattended/2026-09-28/verification/08-root-ci-supply-chain.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/08-*.txt`
- 可能 Modify: `.github/workflows/*.yml`、`scripts/**`、`lefthook.yml`

**本面任务书要点**：类型 **I**。主攻 workflow 权限（`permissions` 是否最小化、
`pull_request_target` 风险、secrets 暴露面、`GITHUB_TOKEN` scope）、release 资产完整性
（下载 + SHA-256 校验链路、9-27 修过的点名号改写问题）、脚本注入（`${{ }}` 插值进 `run:`）、
供应链（action 版本固定、`deno.lock`/`Cargo.lock` 一致性、镜像来源）。
开赛前特别关注：**release / install / update 链路**（运营者用它部署）。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `08-root-ci-supply-chain`，bookmark `contest-readiness/08-root-ci-supply-chain`）

**完成判据**：workflow 权限与插值面逐条裁定；`deno run -A scripts/check-all.ts` 绿。

---

## Task 10: 面 9 — noj-llm-gateway

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/09-gateway.md`
- Create: `dev-docs/unattended/2026-09-28/verification/09-gateway.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/09-*.txt`

**本面任务书要点**：类型 **I**。主攻额度与限流绕过（含 `/internal/usage` 分页上界与
`OFFSET` 插值面是否彻底消除）、Provider Key 加密与取用路径（谁能读出明文、日志是否泄露）、
`eval_token` 的签发与校验、SSRF（gateway 作为唯一双网卡入口，其出站目标是否受控）、
账单一致性（billed token 口径）、以及**竞赛场景下 gateway 被滥用为对外通信跳板**的可能。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `09-gateway`，bookmark `contest-readiness/09-gateway`）

**完成判据**：`cd noj-llm-gateway && deno task check && deno task test` 绿；
报告含"gateway 作为唯一跨网入口"的风险裁定。

---

## Task 11: 面 10 — noj-ui

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/10-ui.md`
- Create: `dev-docs/unattended/2026-09-28/verification/10-ui.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/10-*.txt`

**本面任务书要点**：类型 **I**。主攻 XSS（含 markdown 渲染与 sanitizer 的已知绕过：
9-21 修过 unknown tag SSR XSS 与 unquoted attr XSS，须做同类漏网搜索）、SSR 泄露
（服务端把内部数据渲进 HTML）、JWT Cookie 作用域与 `HttpOnly`/`SameSite`、
Nitro 代理注入（`useFetch` 透传、状态码强转、SWR 与鉴权重定向）、前端泄露内部端点或密钥
（`runtimeConfig` 的 public 面）、以及**赛期页面的信息泄露**（题库/竞赛列表/排行在前端可见的字段）。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `10-ui`，bookmark `contest-readiness/10-ui`）

**完成判据**：`cd noj-ui && deno task check && deno task test` 绿；XSS 与 SSR 泄露逐条裁定。

---

## Task 12: 面 11 — 文档与实现漂移

**Files:**
- Create: `dev-docs/unattended/2026-09-28/findings/11-docs-drift.md`
- Create: `dev-docs/unattended/2026-09-28/verification/11-docs-drift.md`
- Create: `dev-docs/unattended/2026-09-28/evidence/11-*.txt`

**本面任务书要点**：类型 **II**。主攻**开赛运营依赖的文档**与代码实现的一致性：
`noj-docs` 的运维 / 出题人 / 用户文档、`dev-docs/engineering/`（route-catalog、
metric-catalog、event-catalog、test-silent-skips、domain-boundaries）、模块 `AGENTS.md`、
`ROADMAP.md`（历史上只漏报不虚报，须按"漏报侧"口径核对）。
强制：**每条漂移必须给出代码位置作为证据**；不得只凭文档互相比对下结论。

- [ ] **Step 1–7: 执行模板 T.1 → T.6**（面名 `11-docs-drift`，bookmark `contest-readiness/11-docs-drift`）

**完成判据**：`deno run -A scripts/verify-md-links.ts` 与 `check-runbooks` 绿；
每条漂移有代码位置证据。

---

## Task 13: 收尾与交付（06:00–07:00，不开新面）

**Files:**
- Create（补全）: `dev-docs/unattended/2026-09-28/final-report.md`
- Create: `.agents/notes/implemented/process/2026-09-28-contest-readiness-unattended-audit-outcome.md`

- [ ] **Step 1: 补齐 `final-report.md`**，必须含四部分：
  1. **证据文档**：finding → 复核结论 → 修复 → 成对证据（命令 + 输出）→ change/PR 链接；
  2. **工作日志**：时间线 + 每面状态（完成 / 进行中 / 未开始）；
  3. **待人工 review 清单**：未取证项（附复验条件）、存疑项、被证伪项、设计级问题
     （含被排除的反作弊系统设计建议）、以及 **`noj-cli` 与 `noj-lmcc-extension` 未审的风险提示**；
  4. **Draft PR 清单**：逐条声明 base。
- [ ] **Step 2: 汇总四轴断言矩阵结论**（A/B/C/D 每条的最终三态）。
- [ ] **Step 3: 核验 L0 五条红线**并逐条记录证据：

```bash
git rev-parse origin/main                      # 必须仍是 6dbdd76b
jj bookmark list main                          # 必须仍是 qrsktulv
git log --format='%H %G? %s' -8                # 抽样确认签名有效（%G? 为 G/U）
rg -n "JUDGE_INSTANCE_ID|NOJ_EVAL_NETWORK_NAME" .env.prod 2>/dev/null || echo "未改 .env.prod（正确）"
```

- [ ] **Step 4: 写 outcome Agent Note** 并校验：

```bash
deno run -A scripts/verify-agent-note-format.ts
```

- [ ] **Step 5: 提交收尾产物**

```bash
jj describe -m "docs(root): 公开赛开赛前无人值守审计最终报告与结论"
jj new
```

- [ ] **Step 6: 判定整晚结论**（spec §6 L5）：成功 / 可接受但未完成 / 失败，并把判据与证据
  写进 `final-report.md` 首屏。
- [ ] **Step 7: 07:00 硬停**——停止开新工作，确认工作副本干净（`jj status`）、所有产物已提交。

---

## Self-Review

**1. Spec coverage（逐节核对）**

| Spec 章节 | 覆盖它的 Task |
|---|---|
| §4 Phase 1 面 1.1–1.5 | Task 1–5 |
| §4 Phase 2 面 6–11 | Task 7–12 |
| §4 阶段职责（前置 / 四轴 / 广度 / 收尾） | Task 0 / 1–5 / 7–12 / 13 |
| §5.1 串行 subagent 硬实现 | 模板 T.1（`run_in_background: false`）+ Global Constraints（禁用 Agent Teams / workflow） |
| §5.2 两类审计任务 | 各 Task 的"本面任务书要点"显式标注类型 I/II |
| §5.3 任务书模板 | 模板 T.1 内逐字给出 |
| §5.4 复核（>5 条另派 verifier） | 模板 T.3 |
| §5.5 修复循环 + 每面一个 PR | 模板 T.4/T.6 |
| §6 L0 红线 | Task 0 Step 1、Task 6 Step 3、Task 13 Step 3 |
| §6 L1 审计质量 | 模板 T.1 任务书 + T.3 |
| §6 L2 修复质量 | 模板 T.4 |
| §6 L3 A1–A5 | Task 1 Step 4 |
| §6 L3 B1–B6 | Task 2 Step 4 + Task 3 Step 4 |
| §6 L3 C1–C5 | Task 4 Step 4 |
| §6 L3 D1–D5 | Task 5 Step 4 |
| §6 L4 交付完整性 | Task 13 Step 1 |
| §6 L5 成功判定 | Task 13 Step 6 |
| §7 熔断截断停下上报 | Global Constraints + 模板 T.1 超时熔断 + Task 13 Step 7 |
| §8 产物目录 | Task 0 Step 4 + 模板 T.2 |
| §9 风险处置 | Task 0 Step 4/5/6、Global Constraints、Task 13 Step 3 |

**2. Placeholder scan**：无 TBD / TODO；所有步骤均给出确切命令或确切产物路径。
各 Task 的差异参数（面名、finding id、断言编号）已逐条写明，不依赖"同上"。

**3. Type consistency**：finding 文件编号 `01`–`11` 与 Task 1–5、7–12 一一对应；
bookmark 命名统一为 `contest-readiness/<NN>-<face>`；产物目录统一为
`dev-docs/unattended/2026-09-28/{findings,verification,evidence,logs}`；
模板编号 T.1–T.6 全文一致。

**执行方式说明**：本计划**由 Lead 亲自内联执行**（用户协议：subagent 只做审计与证伪，
修复必须由 Lead 自己做），故不提供 subagent-driven 选项。
