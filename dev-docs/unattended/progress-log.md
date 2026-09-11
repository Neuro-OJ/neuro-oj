# 无人值守执行工作日志

> 本文件记录一次无人值守会话的进度与实测证据。
> 目标与验收标准见 `dev-docs/superpowers/specs/2026-09-11-unattended-24h-objective-design.md`。
>
> **性质说明**：这是一份**时点快照**，不是持续维护的看板。最后更新：2026-09-11 02:10 (CST)。
> 此后的事实变化不会自动同步到本文件；需要最新状态时以各 PR 与 `.agents/notes/` 为准。

- 开始时间：2026-09-11 01:0x (CST)
- 执行者：AI Agent（无人值守）
- 预算：不超过 24 小时
- 交付约定：**只推分支 + Draft PR，绝不推 main、绝不合并**

## 状态标注口径

下表「状态」列只表示**该目标的代码已写完、且所在 Draft PR 的 CI 为绿**，不表示已合并或已发布
（本栈全部为未合并的 Draft PR，`main` 未被触碰）。各 PR 的 CI 覆盖并不一致，见「交付」列的备注。

---

## 状态总览

| 项 | 内容 | 状态 | 交付 |
|---|---|---|---|
| D0 | 基线转绿（迁移分片 / judge RESULT 竞态 / 镜像权限 / 测试噪声） | ✅ 完成 | [neuro-oj#486](https://github.com/Neuro-OJ/neuro-oj/pull/486)（CI 39 pass） |
| D1 | noj-problems WIP 固化 | ✅ 完成 | [noj-problems#1](https://github.com/Neuro-OJ/noj-problems/pull/1)（该 PR 无 CI） |
| D2 | noj-problems CI | ✅ 完成 | [noj-problems#2](https://github.com/Neuro-OJ/noj-problems/pull/2)（题库检查 pass） |
| D3.1 | 新题：解码采样器 | ✅ 完成 | [noj-problems#3](https://github.com/Neuro-OJ/noj-problems/pull/3) |
| D3.2 | 新题：BPE 分词器 | ✅ 完成 | [noj-problems#4](https://github.com/Neuro-OJ/noj-problems/pull/4) |
| D3.3 | 新题：LLM 评测指标 | ✅ 完成 | [noj-problems#5](https://github.com/Neuro-OJ/noj-problems/pull/5) |
| D3.4 | 新题：RAG 引用问答（LLM 工程题） | 🔶 **代码完成，平台 E2E 未取证** | [noj-problems#6](https://github.com/Neuro-OJ/noj-problems/pull/6)（**该 PR 无 CI**；平台 E2E 见下方说明） |
| D3.5 | 平台端到端验证（**P 型 3 题**通过） | ✅ 完成 | 见下「平台 E2E 实测」——**不含 D3.4 的 LLM 题** |
| D4.2 | judge 跨 worker 并发公平性缺陷 | ✅ 完成 | [neuro-oj#488](https://github.com/Neuro-OJ/neuro-oj/pull/488)（CI 23 pass；新增 Redis 用例的 CI 执行见该 PR 评审） |
| D4.3 | 代码相似度检测 | ✅ 完成 | [neuro-oj#490](https://github.com/Neuro-OJ/neuro-oj/pull/490)（**当时无 CI 结果**，仅 CLA + Pages） |
| D4.4 | 成绩单导出补全 | ✅ 完成 | [neuro-oj#491](https://github.com/Neuro-OJ/neuro-oj/pull/491)（**当时无 CI 结果**，仅 CLA + Pages） |
| D4.5 | 题目脚手架 `problems init` | ✅ 完成 | [neuro-oj#489](https://github.com/Neuro-OJ/neuro-oj/pull/489)（CI 26 pass） |
| D5 | 平台代码审查与改进 | ✅ 完成（含陈旧镜像陷阱修复） | [neuro-oj#492](https://github.com/Neuro-OJ/neuro-oj/pull/492)（CI 23 pass） |
| D6 | 验收证据文档 + 待人工 review 清单 | 🔶 进行中（工作日志已完成，证据文档见 #493） | [neuro-oj#493](https://github.com/Neuro-OJ/neuro-oj/pull/493) |

> **D3.4 为何不是 ✅**：`rag-cited-qa` 的产物已写完并通过离线自测，但**平台 E2E 未取证**——
> 本环境没有可用的真实 LLM Provider（见「未验证项」）。同批的 3 道 P 型题（D3.1–D3.3）已在
> 真实平台跑通，下表「平台 E2E 实测」只覆盖这 3 题，**不包含 D3.4**。此外 D3.4 的
> 反刷分门禁（spec §7 L1.9）也尚未在平台上实测。

---

## 重大发现（超出原计划范围，但对项目有长期价值）

### 发现 1：judge 存在真实产品缺陷 —— 合法评测结果被误判为系统错误

**这是 D0 调查中最重要的发现，且此前被长期误判为「flaky 测试」。**

- **现象**：`e2e_abnormal.rs` 的 `support_package_missing_still_finished` 在 main 上偶发失败
  （断言「无支持包也应 finished」，实得 `status=error`，`output` 仅剩 `---RESULT---`）。
- **根因**：编排循环阶段 2 以 `result_payload.is_none()` 为守卫，但阶段 1 是
  `while !evaluator_started` 循环——收到首条输出（例如只含 `---RESULT---` 标记的那个 chunk）
  即正常退出，此时 `result_payload == Some("")`（已见标记、payload 待读）。守卫判定 false
  → **阶段 2 被整体跳过** → payload 永不读取 → 尾部逻辑按「已见标记但无 payload」把合法结果
  判为 `SystemError`。
- **触发条件**：标记与 payload 落在**同一个** chunk 时恰好正常（payload 留在解析器缓冲、
  由尾部 drain 取回）；**分成两个 chunk 到达则必然丢结果**——这就是「偶发」的来源。
- **真实影响**：不只影响测试。**选手的正确答案会被报为系统错误**（提交丢分），
  且表现为随机发生，运维与出题人都难以定位。
- **修复**：三处（守卫语义、幂等的 `drain_eval_tail()`、恢复「payload 完整即收尾」的首选退出条件）。
- **证据**：新增回归测试 `result_payload_survives_solution_eof` 把竞态**确定化**
  （Solution 立即结束、Evaluator 写完标记后 sleep 1s 再写 payload）——
  修复前**稳定复现**，修复后通过。全量 judge E2E：42 passed / 0 failed
  （`noj-judge/tests/` 下共 9 个 `e2e_*.rs`，其中 8 个需要 Docker；`e2e_solution_ai`
  含 1 个非 Docker 用例，故计入 CI 的 `--ignored` 用例总数为 42）。

### 发现 2：一个 E2E 套件长期「静默跳过」，把上述缺陷掩盖成绿色

- `isJudgeAvailable()` 只接受 `judging`/`finished` 状态。当 judge 因发现 1 把评测统一判为
  `error` 时，该函数返回 false → `priority_queue.test.ts` 整个套件**跳过执行**，
  并以 **201µs** 「通过」。
- **因果链**：judge 缺陷 → 评测结果为 error → 探针判定 judge 不可用 → 套件静默跳过 → CI 绿色。
  这解释了缺陷为何能长期存在。
- **处置**：
  1. `isJudgeAvailable()` 改为接受 `error`（判据是「judge 是否在消费队列」，error 说明 worker
     领取并处理了任务）；
  2. 修复由此**暴露**的用例自身时序竞态：原顺序「压入 high 洪峰 → 创建提交 → 立即重测」必然
     400（重测要求提交处于 finished/error），改为「先创建并等其完成 → 再制造洪峰 → 最后重测」。
- **验证**：CI `E2E submission` 从 fail(6m → 重测失败 400) 变为 **pass (6m36s)**，
  即该套件现在**真实执行**而非空跑。

### 发现 3：迁移文件的跨 schema 硬编码前缀（分片测试确定性失败）

- 3 个迁移含 drizzle-kit 生成的 `REFERENCES "public".` 前缀，在 `test:parallel` 的分片 schema
  下 FK 指向 `public` 而表建在分片 schema → 5 个测试**确定性失败**
  （905 passed / 5 failed）。
- 生产环境全部对象在 `public`，前缀恰好正确 → **只在非 public schema 暴露**，
  因此长期被误判为「分片并发竞态」。
- 修复：去掉前缀让 FK 按连接 `search_path` 解析（与 2026-07 处理 `0010/0027/0029` 的既定做法一致）
  → **910 passed / 0 failed**。

### 发现 4：镜像权限归一化（本地复现的隐蔽故障）

- 容器以 `USER noj`（uid 10001）运行，而 `COPY` 原样保留构建上下文的文件模式。
  本地 `noj-judge/sdk/common/noj_sdk_common/*.py` 为 `600`（git 记录 `100644`，属本地环境漂移），
  复制进镜像即 `root:root 0600` → 非 root 无法 import，**一次性打挂整个双容器 E2E 套件**，
  且报错指向 Python 而非权限根因。
- git 只跟踪可执行位，CI 全新检出为 644 因而正常 → **该问题只在本地复现**。
- 修复：两个 Dockerfile 在 `COPY` 后 `chmod -R a+rX`（纵深防御）。

### 发现 5：仓库失真情况（供 Owner 参考）

- **ROADMAP 存在「漏报已实现项」**（已逐条实测确认）：成绩单 CSV/JSON 导出
  （`noj-core/src/domains/admin/routes/contest.ts:529,546`）、judge 三级优先级队列
  （`noj-judge/src/mq.rs:11` `PRIORITY_SEQUENCE`）、队列背压
  （`noj-core/src/domains/submission/mq/producer.ts:84` 单条 Lua 原子「容量检查 + 入队」）
  都已在代码中实现，但 ROADMAP 未勾选。
- **`plans/` 的 checkbox 不可信**：**47 份中 40 份**含未勾项，但对应工作早已上线
  （`2026-09-03-noj-core-organization-refactor.md` 有 139 未勾，对应域化重构已交付）。
  **不能当作待办清单使用**。
  计数命令：`rg -l '^\s*-\s\[ \]' dev-docs/superpowers/plans/*.md | wc -l`（分子）、
  `ls dev-docs/superpowers/plans/*.md | wc -l`（分母）。
- `.test-storage/` 产物被误提交（已在 `noj-core/.gitignore` 排除却仍被跟踪），导致每次跑测试
  都产生删除 diff，污染每个 PR、使干净基线不可达 → 已停止跟踪。

> **更正（自查推翻了子代理的一条结论）**：初步盘点曾报「Agent Note 声称的 judge ZIP 模糊
> 测试实际不存在（全仓 `fuzz` grep = 0），属文档虚报」。**该结论是错的**——子代理只检索了
> 英文单词 `fuzz`，而该测试实际存在且命名不同：
> `noj-judge/src/sandbox/container.rs:423` 的 `test_extract_zip_random_bytes_never_panics`
> 使用固定 LCG 种子（`0x1234_5678`）+ 有界迭代（200 次），与 Agent Note 的描述
> 「固定 LCG 种子、有界迭代」**完全吻合**。因此**不存在该文档漂移**，原计划的 D4.6
> （补 ZIP 模糊测试）**取消**。
> 教训：对子代理的「grep 0 命中 ⇒ 功能不存在」类结论必须二次核实——命名差异会导致假阴性。

---

## 时间线

### 2026-09-11 01:00–02:00 — 基线调查与 D0

- 核实基础设施（PG/Redis/MinIO/gateway 在线；评测镜像齐全；judge 二进制已编译）
- 复现并**定性**基线 5 个失败：在 main 的独立 worktree 上复现完全相同的失败 → 确认 main 固有
- 用 `pg_constraint` 查询证实跨 schema FK（3 个）→ 锁定迁移前缀根因
- 定位 judge RESULT 竞态（用临时 `eprintln!` 插桩逐步收敛，最终锁定阶段 2 守卫）
- D0 拆为 7 个独立 change 并推栈 → PR #486
- **CI 首轮结果**：29 pass / 1 fail（`E2E submission`）→ 深入调查发现「静默跳过」因果链
  → 修复用例时序与探针口径 → **CI 全绿（39 checks pass, 0 fail）**

### 2026-09-11 02:00–02:30 — D1 / D2

- D1：审阅 noj-problems 未提交 WIP（40 文件 / +4177 行），**独立核验**而非引用其 README：
  - 44 tests 全绿；剧本校验 0 ERROR
  - `strong` + judge=50 → **1000/1000**（满分链路可达）
  - `generic`（零 LLM）→ 0–100
  - **7 类 rogue × 6 剧本 = 42 组合全部 0 分**（反刷分成立）
  - 确定性：同 seed 必同剧本；600 次抽样覆盖全部 6 剧本（无死剧本）
  - 修正一处 `ResourceWarning`（未关闭文件句柄）
- D2：新增题库 CI（`ci_checks.sh` + `validate_manifest.py` + workflow）
  - **CI 首轮失败**，抓出 D1 中的 Python 3.12 兼容缺陷（`NameError: Any`）——
    本机 python3.14 因 PEP 649 延迟注解求值而掩盖了它
  - 修复并跨版本验证：**3.10 / 3.11 / 3.12 / 3.13 / 3.14 全部 44 tests OK**
  - 负例验证：注入 ERROR 后 CI 退出码 1；还原后 0 —— 门禁真实有效

### 2026-09-11 02:30–03:00 — D3.1 解码采样器

- 原创题：LLM 解码采样流水线（重复惩罚 → 温度 → top-k → top-p → softmax → 逆变换采样）
- 48 个单元测试 + 6 项离线自测全过
- 新增**通用**打包脚本 `scripts/build_bundle.sh`（供后续所有题目复用）
- 遇到一次栈错位（新题文件落在 D1 而非新 change），已用 jj 修正并保持 D1 洁净
- CI 自动发现新题并纳入检查（8/8 通过），验证 D2 的「按目录发现」设计

---

## 平台 E2E 实测（L1 门禁 #8 —— 在真实平台上跑通，非离线推断）

搭建独立平台栈（新库 `noj_unattended_e2e` + 独立 Redis db + local 存储），
对三道新题逐一执行「导入题目包 → 提交参考解 → 校验判定与分数」：

| 题目 | 状态 | 分数 | 隐藏/可见用例 | 隐藏字段泄露 |
|---|---|---|---|---|
| `decoding-sampler` | `finished` | **10000**（满分 100.00） | 22 / 3 | 无 ✅ |
| `bpe-tokenizer` | `finished` | **10000**（满分 100.00） | 34 / 4 | 无 ✅ |
| `llm-metrics` | `finished` | **10000**（满分 100.00） | 38 / 4 | 无 ✅ |

**反蒙分实测（平台侧）**：提交 `template.py`（`solve` 抛 `NotImplementedError`）→
`status=error`、`score=0`、`cases=0`。符合设计契约（运行期异常上抛 → evaluator 不输出
`---RESULT---` → judge 收尾为 error），且满足「非 AC 且 0 分」的反蒙分要求。

> 结论：**P 型三道新题**（D3.1–D3.3）的门禁 #1（包可导入）、#2（参考解满分 / 模板 0 分）、
> #3（隐藏数据零泄露）、#8（平台 E2E）**均已在真实平台取证**，非仅离线自测。
> **D3.4 的 LLM 题不在本表覆盖范围内**（无真实 Provider，平台 E2E 未取证）。

### 搭建平台栈时踩到的环境坑（供后续复现参考）

1. **release 二进制陈旧**：`noj-judge/target/release/noj-judge` 是 8-08 构建的，
   而「评测任务三级优先级队列」特性 9-10 才合入 → 该二进制等待的是旧队列名，
   表现为「任务入队但永不消费」。改用新构建的 `target/debug/noj-judge` 即正常。
   （与 D0 发现的陈旧 Docker 镜像属同一类「本地陈旧产物」问题。）
   **注意两者是不同层的东西，都要处理**：本坑是**宿主机上的 judge 二进制**陈旧，
   重新 `cargo build` 即可；而 `.agents/notes/implemented/bug-fix/2026-09-11-baseline-stability-fixes.md`
   讲的是**评测容器镜像**陈旧（改了 `noj-judge/sdk/**` 后镜像不会自动重建）。
   跑 E2E 前两者都需要是新的：宿主二进制要重建，SDK 镜像需由 `ensure_sdk_images`
   按构建输入哈希判定后重建（该判定本身在 #492 中修过）。
2. **judge 拒绝 HTTP 的 S3 预签名 URL**：`S3 下载 URL 必须使用 HTTPS` 是刻意的安全约束
   （仅 HTTPS、禁重定向）。本地 MinIO 是 HTTP，因此必须改用
   `STORAGE_PROVIDER=local` + 共享 `SUPPORT_PACKAGE_DIR`（与 e2e compose 的做法一致）。
3. **开发库迁移状态不一致**：`noj-core/.env` 指向的 `noj` 库落后于代码（67 vs 83 个迁移），
   直接迁移会因历史 DDL 冲突失败。改用**全新库**最省时。
4. **强制改密会拦住导入**：`authMiddleware` 对 `must_change_password=true` 的 token
   在白名单外一律 403，E2E 脚本必须显式完成 `change-password`。

### 平台侧的一个设计观察（非缺陷）

题目 `details` 中自定义的汇总字段（如 `hidden_passed` / `hidden_total`）
在提交详情中**不会**返回——提交结果投影（`applySubmissionProjection`）按白名单裁剪。
`details.cases[]`（含 `case_id`/`status`/`hidden`）正常保留。
出题人若想让某个汇总字段可见，需确认其在投影白名单内。

---

## 待人工 review 清单

每条给出**可执行的判定动作**，而不是需要 reviewer 自行猜测的判断题。

1. **judge RESULT 竞态修复的正确性**（最高价值）
   - 动作：读 `noj-judge/src/dual/mod.rs` 阶段 2 的退出条件顺序（payload 完整 → 双流结束 → 超时）。
   - 判定：`git show 72d628389:noj-judge/src/dual/mod.rs` 中 `result_payload.as_deref().is_some_and(|p| !p.is_empty())` 必须先于 `evaluator_done && solution_done`；并确认 `drain_eval_tail` 在两条路径上都被调用。
2. **`isJudgeAvailable()` 放宽为接受 `error`** 是否影响其他 E2E 用例的跳过语义
   - 动作：`rg -n 'judgeOk|isJudgeAvailable' noj-tests/e2e/`，逐个确认没有用例依赖「error 即视为 judge 不可用」。
   - 已知残留：`rejudge.test.ts` / `pipeline.test.ts` / `contest_lifecycle.test.ts` / `tags.test.ts` 仍用 `judgeOk` 提前 return 的写法——本次只修了 `priority_queue.test.ts` 触发的那条链。
3. **迁移文件直接修改而非新增迁移**
   - 动作：`psql -c "SELECT count(*) FROM <schema>.__drizzle_migrations"` 确认目标环境是否已应用 0056/0063/0066。
   - 已复核结论：drizzle `migrate` 只比较 `created_at` 与 `folderMillis`，**从不比对已记录的 hash**，故已应用环境不会重跑、不受影响；但**不会自愈**——任何用旧文本迁移过的非 `public` schema 会永久保留错误 FK，需 `DROP SCHEMA test_db, test_unit CASCADE` 后重建。
4. **`.test-storage` 停止跟踪**：`git ls-tree -r HEAD | rg test-storage` 应无输出；`noj-core/.gitignore` 已覆盖该目录。
5. **`test-domain.sh` 兜底 JWT_SECRET**：确认为测试专用固定值可接受（CI 显式传入优先）。
6. **LLM 题的真实模型质量**：需在配置真实 LLM Provider 后复验（当前环境无 Provider）。这也是 D3.4 无法标 ✅ 的原因。
7. **WARN 12 条**（trial-snowy-manor 剧本）：均已被论证为「有定价的残余面」，是否继续收敛属设计取舍。
8. **新题的「判据非空转」证据**：三道 P 型新题的离线自测都包含「让一个近似正确的实现被降分」
   的实测（如 BPE 的规则顺序反转 → 67.65、LLM 指标的分桶归上桶 → 92.11）。
   建议 review 时确认这些「近似实现」确实代表了选手的典型错误。
9. **防复发（本次自查发现，原清单遗漏）**：迁移的 `public.` 前缀问题没有门禁兜底——
   `noj-core/drizzle.config.ts` 未设 `schemaFilter`，`rg schemaFilter` 全仓 0 命中，
   因此 `deno task db:generate` 会**继续**生成 `REFERENCES "public".`。当前仅靠
   `noj-core/CLAUDE.md` 的散文约定。建议加一条静态检查（断言 `drizzle/*.sql` 不含
   `REFERENCES "public".`），否则同类缺陷会随下一个迁移回归。
