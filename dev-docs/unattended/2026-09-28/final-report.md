# 公开赛开赛前无人值守审计 —— 最终报告（2026-09-28 / 29）

> 窗口：2026-09-28 22:00 → 2026-09-29 07:00（CST）
> Spec：[`2026-09-28-contest-readiness-unattended-audit-design.md`](../../superpowers/specs/2026-09-28-contest-readiness-unattended-audit-design.md)
> Plan：[`2026-09-28-contest-readiness-unattended-audit.md`](../../superpowers/plans/2026-09-28-contest-readiness-unattended-audit.md)

## 0. 结论（按 spec §6 L5 口径）

**判定：可接受但未完成（L0 零违反；覆盖面远低于计划）。**

| 判据 | 结果 |
|---|---|
| L0 五条红线 | ✅ **零违反**（逐条证据见 §2） |
| 四轴断言矩阵 | ⚠️ **A 轴部分完成**（A1–A5 有结论，A3 经复核证伪）；**C 轴审计完成 + 修 3 项**；**D 轴审计完成（未修，含 1 Critical + 1 High 待裁决）**；**B 轴（容器逃逸）仍未开始** |
| 每轴"审计结论 + 已修项 + 未完成项说明" | ✅ A / C / D 三轴满足；⛔ B 轴只有"未开始" |
| 面完成数 | **3 / 11**（1.1 judge 可用性：审计+对抗复核+5 修复；1.4 core 泄露：矩阵+Lead 复核+3 修复；1.5 core 公平性：信道矩阵审计，**0 修复**） |

**根因（不是能力问题，是执行窗口问题）**：会话在 2026-09-28 22:23 之后被挂起，
直到 2026-09-29 07:29 才恢复执行——**无人值守窗口内实际只运行了约 40 分钟**。
恢复时已越过 07:00 硬停，按 spec §7 立即停止开新面，只把面 1.1 收口。

证据：`findings/01-judge-availability.md` 时间戳 22:09、`verification/01-judge-availability.md`
时间戳 22:23，而修复类证据（`evidence/01-*`）时间戳为 07:29–07:33；dev 容器 `Up 9 hours`
（我在 22:05 恢复它们）同样印证。

## 0.1 追加（2026-09-29 07:39–07:52 补做）：面 1.4 完成

Owner 把截止延长到 **08:45** 后，剩余预算投给了**面 1.4（noj-core 数据泄露读路径矩阵）**——
它是"枚举式修复"结构性弱点所在、赛前最危险，且**纯代码分析、可在当前环境真实取证**。

| 项 | 结果 |
|---|---|
| 交付物 | `findings/04-core-data-leakage.md`（**全域读路径矩阵** + 9 条 finding + 上一轮 8 项 VULN 逐条裁定 + Lead 逐条复核状态 + F-02 补丁提案） |
| 修复① | **F-01（High）**：个人主页题解门控补齐**赛前筹备期**（口径从 `running` 收敛到 SSOT 的 `unended`）→ commit `cd58542b` |
| 修复② | **F-03（Medium）**：自测路径对赛前保密题改返 **404**（消除"403 vs 404"存在性预言机；其他拒绝语义不变）→ commit `7d8a81e9` |
| 修复③ | **F-08（Low）**：修正 `problem-access.ts` 与实现矛盾的陈旧注释（"题库列表不排除该题"），并写明不得据此删掉列表过滤 → 同 commit |
| 修复④ | **F-04a（Medium）**：个人主页 `total_submissions/accepted/solved_count` 与列表**改为同一按查看者门控口径**（复用 `contestSecrecyCondition`）——原实现三者**全无过滤**，而兄弟列表有，"计数 5 / 列表 4 行"的差额本身即泄露"存在一道保密题且该用户已通过"→ commit `1e1be020` |
| 成对证据 | `evidence/04-F01-profile-gating.txt`、`evidence/04-F03-selftest-404.txt`、`evidence/04-F04a-profile-stats-count.txt`：三处均做**反向验证**——撤掉修复后用例 FAILED，断言信息正是缺陷形态 |
| 门禁 | `deno task check`（core fmt/lint/types）**EXIT=0**（三度复核）；identity 域 **303 passed / 2 failed / 25 ignored**；submission 域 **128 passed / 1 failed** |
| 失败定性（L2 #5） | 两处失败均为 `search-events.test.ts`（"搜索索引事件未发布"）家族。**真 A/B 定性**：撤销本次改动后 —— identity 域同样失败；submission 域由 128/1 变为 **127/2**（多出的那 1 条正是我新增的 F-03 用例，即"修复缺失时它必须失败"）。结论：**该失败家族为本环境既有问题，与本次改动无关** |
| 未修（**F-02 High**，已出补丁提案） | `GET /api/v1/rankings` 共 **7 处** SQL 只判 `affect_global_ranking`、**无任何时间窗口**，且匿名可读 → 赛中他人进度/得分侧信道（正是公平性轴 D2 的目标）。正确修法要动 7 处 SQL + 向 contest 门面新增窗口谓词导出 + **改变全局榜语义**（产品决策）→ 按 spec §7「设计级变更」不下手，改为 findings 文件内的精确补丁提案（含测试与回滚） |
| 未修（其余） | F-05（全局 `full_score` 聚合构成判分 oracle 旁路，路由层已确认无竞赛过滤，可利用性未实测）、F-06/F-07（聚合计数）、F-09（客观题提交 403 vs 404） |

**第四处自我纠错（由我自己造成、也由我发现）**：做 F-04a 的反向验证时，恢复步骤用了
`replace(..., 1)`（只替换第一处匹配），而该文件存在多处同类文本，导致改动落到**错误的函数**上、
把文件改坏——当时"修复后仍 FAILED"其实是我制造的假象。发现后未逐处猜测，而是
`jj restore --from @-` 退回已提交状态再**重新施加修复**，并核对"改动只落在 `queryProfileStats`、
其他函数的 `.where(` 形态未变"，复跑得到 `ok`；被污染的那一版证据文件也已作废重写。
教训：**用脚本做临时改动时必须按唯一锚点精确替换，并在恢复后核对目标位置**。

**口径偏离（必须记录）**：面 1.4 的 finding 数 **9 > 5**，按 spec §5.4 **本应另派 verifier subagent**。
因时间盒只够"审计 + 修复 + 门禁"，**未派 verifier**，改由 **Lead 逐条读证复核**：F-01/F-02/F-03/F-08
经读证**确认成立**（F-01/F-03/F-08 已修），F-04 部分确认，F-05 路由层确认，F-06/F-07/F-09 **未复核**
—— 后者按 L1 口径**不得视为已确认缺陷**，只能作为"待复核候选"。

**另一处自我纠错（同样值得记录）**：F-01 的新回归用例初版照抄了仓库"DB 依赖测试缺
`DATABASE_URL` 时 `ignore`"的惯例，但 `test-domain.sh` 走 **PGlite 模式、本就不设 `DATABASE_URL`**
→ 该用例在本地与 CI 都会**永久跳过**（首次运行显示 `1 ignored`）。已改为与同域 `problems-stats.test.ts`
一致的无守卫写法，并复跑确认真执行（`1 passed`）。**这正是本仓反复治理的"假绿"形态，且由我制造。**

**第三处自我纠错**：本节的 A/B 定性第一次是**无效实验** —— 改动已提交进 `@-`，而我用 `jj restore`
（默认从 `@-` 取）在空的 `@` 上跑出 "Nothing changed"，于是"撤销后仍失败"的结论其实来自**含改动的树**。
改用 `jj restore --from @--` 后才得到有效对照（见上表）。凡"撤销验证"必须确认**撤销真的生效**。

## 0.2 追加（2026-09-29 08:12–08:22）：面 1.5 完成审计（**未做修复**）

最后一段预算投给了**面 1.5（赛时公平性信道）**——四轴中最后一条尚未审计的轴。

| 项 | 结果 |
|---|---|
| 交付物 | `findings/05-core-fairness-channels.md`（**信道矩阵** ~30 行 + 6 条 finding + 上一轮 7 项 VULN 逐条裁定 + F-02 影响面补充） |
| **Critical** | **N-01**：社区 `discussion` 帖**省略 `problem_id`** 即绕过写门控，且落库 `problem_id=NULL` 使**所有读门控**（要求 `problem_id IS NOT NULL`）永久放行 → 赛中任何登录用户可 20000 字符/条向全场广播完整解法（`moment`、评论同理）。这是 **VULN-02「已修仍可绕过」** |
| **High** | **N-03**：**VULN-04/05 的裁定由上轮"维持现状"升级为 High** —— `problem-secrecy.ts` 硬编码 `kind='public'`，使邀请赛/私有赛**同时**失去题解写门控与主页/搜索/题库遮蔽（邀请赛=公开题库+公开题解，进度可匿名围观） |
| Medium / Low | N-02（`/community/reports` 在 pending 期回显题解全文，第三处手写窗口）、N-04（bio/头像可作匿名 covert 公告板）、N-05、T-01（口径漂移残余 2 处） |
| 受控面（已审无问题） | 手写时间比较 0 处、无"向全场推文本"的 SSE 信道、私信无竞赛门控需求、服务端强制项（提交上限/rejudge/迟到/赛前/封榜）**全部服务端强制** |
| **修复（本轮追加）** | **N-02（Medium）已修**：`/community/reports` 三处门控由 `isProblemInRunningContest`（running 窗口）改为 SSOT 的 `isProblemInUnendedPublicContest`（unended，含 pending）→ commit `01447e80`。修复前赛前筹备期里 `GET /community/posts/:id` 已 404，而举报接口仍**原样返回题解全文**（`content_snapshot`）；**反向验证**：只把"帖子举报"一处改回 running → 新增用例 FAILED，其余 10 个通过（`evidence/05-N02-report-window.txt`） |
| **Lead 亲验（N-01）** | **N-01 由"单方证据"升级为已确认 Critical**：三处代码的**内部不一致**已被逐行读证 —— ①写门控 `type !== "moment" && input.problem_id`（省略字段即整段跳过）②落库讨论帖 `problem_id = null` ③读门控要求 `problem_id IS NOT NULL` → 结构上永远放行。详见 `findings/05-core-fairness-channels.md` §4.1 |
| **未修（需 Owner 裁决）** | **N-01（Critical）**：本质是**内容政策决策**（赛中是否允许全场广播任意文本），Owner 已明确"反作弊系统的功能设计不在本轮范围"，而该修法正属此类；**N-03（High）**：要改保密 SSOT 的 `kind` 语义（同时改变题库/搜索/主页/社区四类读路径对邀请赛与私有赛的可见性），属 spec §7 的"设计级变更"；N-04/N-05/T-01 加固项 |
| 复核状态 | 本面**未派 verifier、Lead 亦未逐条读证** → 按 L1 口径，全部结论**不得视为已确认缺陷**，仅为"待复核候选"。**建议优先复核 N-01 与 N-03：它们直接决定公开赛能否安全开赛** |

## 0.3 追加（2026-09-29 08:22–）：B 轴取得**真实 Docker 证据**

此前报告称"所有依赖真实容器的结论本轮均未取证"。这条**已被推翻**：不需要整条 e2e 栈
（`scripts/e2e/setup.sh` 会接管 dev 基础设施，本轮已弃用），直接跑 judge 自己的 Docker E2E 即可
——只需 Docker daemon + dev Redis（`redis://127.0.0.1:6379/9`）+ `DOCKER_CONFIG` 改道。

| 套件 | 结果 | 对本轮的意义 |
|---|---|---|
| `e2e_security_isolation`（`NOJ_RUN_E2E=1`） | ✅ **3 passed / 0 failed**（8.72s，exit 0）：`test_network_isolation`、`test_container_no_sensitive_mounts`、`test_evaluation_container_host_boundary` | **B 轴（容器逃逸）首批真实证据**：用**生产路径的 HostConfig 构造器**（`build_host_config_with_cpu`）建容器并断言网络被阻断、无敏感挂载、宿主边界成立 |
| `e2e_support_package` / `e2e_abnormal` / `e2e_dual_container` | ✅ **3 + 6 + 15 = 24 passed / 0 failed** | **覆盖我改过的注入路径**：`e2e_support_package` 的 `test_evaluation_with_support_package` 走真实支持包注入（我改成的 `inject_zip_entries_to_container`）；`e2e_abnormal` 覆盖 `result_payload_survives_solution_eof` 与 `support_package_missing_still_finished`；`e2e_dual_container` 覆盖双容器主编排、`dual_two_containers_isolated`、`dual_solution_readonly_rootfs`。合计 **27 passed / 0 failed**（含隔离套件 3 个），证据见 `evidence/01-judge-docker-e2e.txt` |

**仍未覆盖的 B 轴断言**（诚实标注）：B1/B2 的"沙箱容器对 postgres/redis/minio/core **既无 DNS 也无路由**"（需 `noj-eval-net` 内探针容器）、B3 的宿主 docker socket 可达性、B6 的"Evaluator 只能触达 llm-gateway"。这些仍需面 1.2/1.3 的专项实测。

### 0.3.1 追加：B4 已证；B1/B2 **本环境不可验证**（一次被拦下的假阳性）

| 断言 | 结果 | 证据 |
|---|---|---|
| **B4** tmpfs `noexec/nosuid/nodev` 实际生效 | ✅ **已在真实容器内确认** | 容器内 `mount` 实测 `/tmp` 为 `rw,nosuid,nodev,noexec,relatime,size=262144k`；从 `/tmp` 执行拷入的二进制返回 `Permission denied`（exit 126）。`evidence/03-network-isolation-probe.txt` |
| **B1/B2** 沙箱容器对 postgres/redis/minio 既无 DNS 也无路由 | ✅ **已按路由验证通过**（名字路径不可验证，见下） | 探针初看显示全部 `REACHABLE`（连 `172.17.0.1:5432` 也通）——**但经三步排查确认是本机透明代理造成的假象**：① dev 容器只在 `neuro-oj_default` 上，`noj-eval-net` 容器列表为**空**；② 容器 DNS 的 ExtServers 是 `100.100.100.100`（**Tailscale MagicDNS**，`search tailb83d19.ts.net`）；③ 同一容器内 `example.com` 被解析为 `198.18.0.10`，即 **fake-IP 透明代理标准段**（本机确有 `omniroute`）。**因此必须报"不可验证"，而不是"生产隔离失效"** |

> **由此得到两条结论（都已用判别实验把"代理假象"与"真实路径"分开，见 `evidence/03-network-isolation-probe.txt`）**：
>
> 1. **判别实验**：同一容器对 `172.23.0.1`（eval-net 网关）的**已发布端口 5432** 与**未监听端口 9999** 都能连上
>    → 该路径被代理无差别接管，**不可作为证据**；而对 `172.17.0.1`（docker0）：5432 `CONNECTED`、
>    9999 `ConnectionRefused` → **真实路由**，容器确实能到宿主，5432 通是因为 **dev 的 postgres 发布了 `0.0.0.0:5432`**。
> 2. **生产端口矩阵（决定性）**：`docker-compose.prod.yml` **只有三处发布端口** —— `nginx:${NGINX_PORT:-8080}:80`、
>    `prometheus`/`alertmanager`（**仅绑 127.0.0.1**）；**postgres / redis / minio / core / llm-gateway / judge 均无 `ports:`**。
>    因此"联网 Evaluator 经宿主网关触达内网数据库"**只在 dev 成立，生产不成立**；生产上网关路径只剩
>    `nginx:8080`（平台公开入口，容器本就有 egress，不构成新能力）与仅绑回环的监控端口（不可经网关触达）✓。
>
> 3. **决定性实验（按容器 IP 直连，绕开被代理接管的"名字"路径）**：从 `noj-eval-net` 内直连
>    `noj-postgres`（`172.18.0.4:5432`）与 `noj-minio`（`172.18.0.2:9000`）**均 Timeout 被丢弃**，
>    而宿主地址 `172.17.0.1:9999` 返回 ConnectionRefused（宿主可达、无监听）→ **Docker 的
>    inter-bridge isolation 在本机确实生效，B1/B2 按路由验证通过**。先前所有 "REACHABLE" 都是
>    (a) 名字被 fake-IP 代理接管 + (b) dev compose 把端口发布到 0.0.0.0 两个环境因素叠加所致。
>
> **修正后的建议**：这不是生产漏洞（**不做高危修复**）；但该隔离依赖"宿主不部署覆盖式 DNS/透明代理 + 内网服务不发布端口"
> 这两条**前置条件**，建议在 judge 启动自检里加一条**主动断言**（"从评测网络内探测内网服务应失败，失败则拒绝启动"），
> 把前置条件变成可验证的不变量而非文档约定。

---

## 0.4 追加（2026-09-29 08:31–）：面 7 测试体系健康度（第二阶段）

第二阶段的第一个面。方式：把我今晚**真实踩到的一手伤痕**交给审计员逐条验证（避免重新发现），
再要求其独立扩展。

| 项 | 结果 |
|---|---|
| 交付物 | `findings/07-test-health.md`（A 部分 6 条一手伤痕逐条裁定 + B 部分 5 条新发现） |
| **A 部分：我给的 6 条全部确认** | A1 类型谎言（`sql<number>` 只是断言、真 PG `count(*)` 返回 string，全仓 **12 处裸 `count(*)`**，消费侧靠散落 `Number()` 兜底）；A2 `search-events` 用例依赖**全局 Redis 键**无隔离 → 本地稳定红、CI 绿；A3 静默跳过棘轮**既过严（`ignore: skip` 且 skip=false 也计数）又可绕过（`ignore: (skip)`/`!skipEnv`/跨行全漏检）**；A4 4 处门禁缺 `.deno_cache` 跳过项**而 CI 自己就把 DENO_DIR 指向仓库内**；A5 e2e 脚本无项目名隔离（**CI 有、本地没有**）；A6 根 scripts 自测无漏网 |
| **B 部分：新发现（最有价值三条）** | **B1**：`countToNumber` 守卫**生产 0 调用**（死守卫），且注释把两种引擎的行为**写反了**；**B2**：`scripts/deploy/restore-drill-verify_test.ts` **从未被任何入口执行**（"写了却永不执行"）；**B3**：`silent-skip-report.ts --check` **先写报告再读回来跟同一字符串比** → "报告过期"是**死检查**，且 `--check` 会改写 git 跟踪文件；另有 B4（棘轮可被 `--update-baseline` 洗白）、B5（全套用例**无一条**断言 PGlite 与真 PG 等价） |
| **本轮已修** | **A5（最高优先，唯一会毁掉他人环境的缺陷）**：`setup.sh` / `teardown.sh` 统一 `export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-noj-e2e-local}"`；`check-setup.sh` 增加静态断言；并把该脚本**纳入 `REPO_GATES`**（此前仅手工可跑，缺陷因此无人拦）→ commit `a3e37c9b9`。**前后对照证据**：不设该变量时项目名 = `neuro-oj`（即会认领 dev 栈）→ 设后 = `noj-e2e-local`；dev compose 仍是 `neuro-oj` 不受影响（`evidence/07-A5-e2e-project-name.txt`）。`gate-list_test` 入口一致性自测 7 passed |
| **未修（列入待办，附优先级）** | ① **A1+B1**（"本地绿 CI 红"的根因类：12 处 `count(*)::int` + 一条跨引擎断言）；② **A3+B4**（棘轮口径与可洗白——改门禁语义属设计决策）；③ **B3**（死检查，修法明确）；④ **B2**（把 `restore-drill-verify_test.ts` 接入执行入口）；⑤ A4（共享 `EXCLUDED_DIRS`）；⑥ A2/B5（测试 Redis 隔离与跨引擎等价断言） |

---

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

## 1.1 CI 状态（收尾时点，需 Owner 复核）

PR #594 的 CI 在收尾时点**仍在运行**（最后推送 `8b13d2b1` 触发的新 run 正在启动阶段）。
按 spec §3.3 的口径，本轮验收**以本地全量门禁为主证据**，CI 为补充；已确认的部分：

| job | 结果 |
|---|---|
| **`Root Gates`**（含静默跳过棘轮） | ✅ **pass（20s）**。此前两轮 fail 均为**我可复现并已修的自身缺陷**：① `verify-md-links`（`final-report.md` 相对链接少退一级）② 静默跳过棘轮 +1（新增用例沿用了 `ignore: skip` 模式）。两者都在本地复现、修复、验证后推送 |
| **`Judge Check`**（含 `cargo nextest --all-targets` + Redis） | ✅ **pass（1m26s）** —— 面 1.1 的 5 项 judge 修复在 CI 通过 |
| `Core submission` / `Core catalog` / `Core Quick Check` / `Core Sharded (TEST_SCHEMA)` | ✅ pass |
| **`Core identity`** | ❌ **首轮 fail（1m46s）→ 已修**：失败项是**我新增的** `users-profile-secrecy.test.ts`（`无竞赛时计数应为 1`），原因是 CI 用**真 PG**、`count(*)` 返回**字符串**，而本地 PGlite 返回数字。已用 `Number(...)` 包裹三处断言并推送（commit `01447e80`），**待新一轮 CI 确认** |
| **`Judge Sandbox E2E`**、各 `E2E <domain>` | 收尾时点仍 pending（真实 Docker 沙箱 E2E 耗时长）。**注意：其覆盖内容已由本地 `NOJ_RUN_E2E=1` 的 4 个套件（27 passed / 0 failed）独立取证**，见 §0.3 |

> 这条差异值得记下：因我的改动触及 `noj-judge/**`，PR 触发了**完整 E2E 流水线**（含真实
> Docker 沙箱 E2E）——这正是本轮在本地**无法取证**的那部分（本机无 e2e 栈、评测镜像未重建）。
> 因此 **CI 的 `Judge Sandbox E2E` 结果是本次 judge 修复唯一可得的真实沙箱验证**，请务必复核。

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
| **B 容器逃逸** | 🟡 **首批真实证据已取得，面未完成** | `NOJ_RUN_E2E=1` 的 judge Docker E2E：`e2e_security_isolation` **3 passed**（网络隔离 / 无敏感挂载 / 宿主边界，用生产 HostConfig 构造器）、`e2e_dual_container` **15 passed**（含 `dual_two_containers_isolated`、`dual_solution_readonly_rootfs`）。**未覆盖**：B1/B2 的"对 postgres/redis/minio/core 既无 DNS 也无路由"（需 `noj-eval-net` 探针）、B3 宿主 docker socket、B4 tmpfs noexec 实际生效、B6 Evaluator 仅可达 llm-gateway |
| **C 数据泄露** | 🟡 **审计完成、部分修复** | 面 1.4 已执行：全域读路径矩阵 + 9 条 finding + 上一轮 8 项 VULN 逐条裁定；修 F-01/F-03/F-08；**F-02（High）出补丁提案待裁决**；F-04–F-07/F-09 未修（见 §0.1） |
| **D 赛时公平性** | 🟡 **审计完成、未修复** | 面 1.5 已执行（信道矩阵 + 6 条 finding + VULN-04/05 升级为 High）；**N-01 Critical 与 N-03 High 均为内容政策/SSOT 语义级变更，按 spec §7 交 Owner 裁决**（见 §0.2）。另：F-02（全站榜单无时间窗口）也属本轴，已出补丁提案 |

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

> ### 🔴 最高优先（先看这条）
>
> **N-01（Critical，赛时公平性）**：社区 `discussion` 帖**省略 `problem_id`** 即绕过写门控，且落库为
> `NULL` 使所有读门控结构上失效 → 赛中任何登录用户可 20000 字符/条**向全场广播完整解法**
> （`moment`、评论同理）。机制已由 Lead 逐行读证确认（见 `findings/05-*` §4.1）。
> **修法属内容政策决策**（赛中是否限制广播类发帖 / 要求讨论帖关联题目 / 赛期内容加审核队列）——
> 因 Owner 明确"反作弊系统设计不在本轮范围"而**未修**。**这条直接决定公开赛能否安全开赛。**
>
> **N-03（High，同源）**：`problem-secrecy.ts` 硬编码 `kind='public'`，使**邀请赛/私有赛**
> 同时失去题解写门控与主页/搜索/题库遮蔽（= 公开题库 + 公开题解 + 进度可被匿名围观）。
> 上轮裁定"维持现状"，本轮**升级为 High**。修法需扩 `kind` 谓词（设计级变更）。
>
> **N-02（Medium）已修**（举报路径口径 running→unended，commit `01447e80`）——它是这三条里唯一
> 不需政策决策的，已闭环。

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
2. ~~**A1 的内存证据是单元级的**~~ → **已补强**：除单元级线程局部分配器对比（60.8MB → 30.4MB）外，
   真实 Docker E2E 已通过（`e2e_support_package` 的注入路径 + `e2e_dual_container`），
   合计 27 passed / 0 failed。但仍**没有**在真实容器里触发过 OOM 来验证"512MiB 上限下的峰值外推"。
3. ~~**A2 的证据是机制级的**~~ → **部分补强**：真实容器上的注入路径已跑通（未挂起、未超时失败）；
   但"容器侧 `tar xf -` 停读 stdin"这一具体触发路径仍**未实测**（需要 SIGSTOP 容器内进程的构造）。
4. **redis 相关测试连的是 dev Redis DB 9**（不是 e2e 栈的 6380），因为 e2e 栈最终没有启动；
   judge 的 Docker E2E 亦同（结果套件不依赖 Redis 队列）。
5. **`noj-judge/target/release/noj-judge` 虽已重建**，但本轮测试跑的是 debug 构建。
6. **本地面板与 CI 环境不一致造成的假红**（面 1.4 新增测试时踩到）：本地 `test-domain.sh` 走
   **PGlite**、CI 走**真 PostgreSQL**，而 PG 的 `count(*)` 返回**字符串** → 我的
   `solution_count` 断言在 CI 失败（`Core identity` 红），本地却绿。已用 `Number(...)` 修正并推送。
   这类"本地绿 CI 红"正是本仓反复治理的形态，**新增测试必须考虑两种后端**。
7. **§2 曾把"栈上提交数 = 2"当作事实写下但未实测**，实际为 4（含栈基提交）。已在核验时
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
