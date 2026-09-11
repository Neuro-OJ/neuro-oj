# Agent Note: 基线稳定性修复（分片迁移、评测结果竞态、镜像权限、测试产物）

Status: implemented

## Problem

2026-09-11 对本仓库做无人值守开发前的基线核查，发现基线并非绿色，且若干失败被长期误归因为「偶发」：

1. **`deno task test:parallel` 5 个测试确定性失败**（905 passed / 5 failed）。典型报错是
   `contest_ranking_snapshots` 违反外键约束——父行刚插入却报 FK 失败。多个失败用例跨 4 个文件，
   单独执行 `deno task test:domain contest` 却全绿（38 passed），因此被当作分片并发竞态。
2. **main 上 `Judge Sandbox E2E` 红灯**，失败用例 `e2e_abnormal.rs` 的
   `support_package_missing_still_finished`：断言「无支持包也应 finished」，实得 `status=error`
   且 `output` 仅剩 `---RESULT---`。该用例历史上 8 次运行 7 次通过，被判定为 flaky。
3. **本地 `deno task test:domain` 与 CI 行为不一致**：脚本自身不提供 `JWT_SECRET`，注释只说
   「CI 会显式传入」，本地执行时 contest 域 4 个用例以「JWT_SECRET 未设置」失败。
4. **双容器 E2E 套件在本地大面积失败**（`e2e_dual_container` 5 个用例），报错为评测容器内
   `PermissionError: [Errno 13] ... noj_sdk_common/__init__.py`。
5. **测试产物噪声**：`.test-storage/` 已在 `.gitignore` 排除，但 11 个二进制产物仍被跟踪，
   而 `test:parallel` 每次清空 `.test-storage/db/`，导致每次跑测试都产生 6 个删除 diff。

## Decision

**1. 迁移跨 schema 前缀：改历史迁移文件，去掉 `"public".` 前缀，不新增迁移。**

用 `pg_constraint` 查询证实 `test_db` 内恰有 3 个指向 public 的 FK
（`content_review_queue → public.users`、`contest_ranking_snapshots → public.contests`/`public.users`）。
分片下 `TEST_SCHEMA=test_db` 通过 libpq `-csearch_path` 生效，表建在 `test_db`，而
`REFERENCES "public".x` 写死了解析目标，父行永远无法满足约束——**这是确定性失败，不是竞态**。

生产环境全部对象位于 public，前缀恰好正确，因此该缺陷只在非 public schema 暴露。
去掉前缀让 FK 按连接的 `search_path` 解析，与 2026-07 处理 `0010/0027/0029` 同类问题的既定
做法一致；`noj-core/CLAUDE.md` 亦已明确「新增迁移请保持不带 schema 前缀」。

**2. 评测结果竞态：这是真实产品缺陷，不是 flaky 测试。**

编排循环的阶段 2 以 `result_payload.is_none()` 为守卫，但阶段 1 是 `while !evaluator_started`
循环——收到首条输出（例如只含 `---RESULT---` 标记的那个 chunk）后即正常退出，此时
`result_payload == Some("")`（已见标记、payload 待读）。守卫判定为 false，**阶段 2 被整体跳过**，
payload 永远不被读取，尾部逻辑遂按「已见标记但无 payload」把合法结果判为 SystemError。
标记与 payload 落在同一个 chunk 时恰好正常（payload 留在解析器缓冲、由尾部 drain 取回），
分成两个 chunk 到达则必然丢结果——这解释了长期偶发。

修复三处：守卫改为「payload 尚未完整取得」；抽出幂等的 `drain_eval_tail()` 在 Evaluator EOF
与循环收尾处取回无换行结尾的残留 payload；循环内恢复「payload 完整即收尾」这一首选退出条件
并置于「双流结束」之前——Solution 容器是常驻 host 进程、只认 shutdown 帧，等它自然 EOF 必然
拖到总超时（表现为 error「Evaluator 总超时」）。

**3. 镜像权限：在 Dockerfile 显式归一化，而非仅修本地文件模式。**

容器以 `USER noj`（uid 10001）运行，`COPY` 原样保留构建上下文的文件模式；本地
`sdk/common/noj_sdk_common/*.py` 为 600（git 记录 100644，属本地环境漂移），复制进镜像即
root:root 0600，非 root 用户无法读取。git 只跟踪可执行位，CI 全新检出为 644 因而正常，
所以该问题**只在本地复现**且报错指向 Python 而非权限根因。在 `COPY` 后加 `chmod -R a+rX`
使镜像不再受源码模式影响（纵深防御）。

**4. 测试产物停止跟踪；`test-domain.sh` 提供 JWT_SECRET 缺省值。**

用 `jj file untrack` 停止跟踪 `.test-storage/**`（磁盘文件保留、`.gitignore` 继续生效）。
`test-domain.sh` 提供仅用于测试的固定密钥；**有意不兜底 `DATABASE_URL`**——未显式设置时测试
走 PGlite 内存库（安全），若默认指向本地 PG，`resetDbForTest()` 的 TRUNCATE 会作用到真实开发库。

## Alternatives considered

- **迁移问题改用「分片 schema 也建一份 public 表」或调整 `search_path` 顺序**：会让分片间共享
  对象、破坏隔离语义，且掩盖迁移本身的可移植性缺陷。
- **迁移问题新增一个「修正 FK」的迁移**：生产环境前缀本就正确，新增迁移要写条件逻辑区分
  schema，复杂度高且无收益；历史迁移尚未在生产之外产生分叉，直接修正更简单。
- **把竞态归因为测试 flaky，加重试或放宽断言**：会掩盖真实丢分缺陷——选手正确答案被报为
  系统错误，属最严重的一类错误。实测把竞态确定化后修复前稳定复现，证明它不是 flaky。
- **只在本地 `chmod 644` 源码，不改 Dockerfile**：能解当下，但任何开发者再次出现权限漂移都会
  复发，且症状误导性强（整套 E2E 挂掉、报错指向 Python import）。
- **让 `ensure_sdk_images` 无条件重建镜像**：可避免陈旧镜像，但显著拖慢每次 E2E；本轮不改其
  行为，仅在后续平台审查中评估「按源码 mtime 判断是否需要重建」。
- **在 `test-domain.sh` 一并兜底 `DATABASE_URL`**：会让本地域测试静默连上真实开发库并 TRUNCATE，
  风险远大于便利。

## Consequences

- 去掉 schema 前缀后，分片与非分片路径的 FK 解析都依赖连接的 `search_path`；**新增迁移必须
  继续保持不带 schema 前缀**，否则分片测试会再次静默失败。
  该约束现已**有 CI 兜底**：`core-test-sharded` 作业跑 `scripts/test-parallel.ts --shards 1`
  （TEST_SCHEMA 路径），这是此前完全缺失的覆盖——CI 各域作业走 `test-domain.sh <domain>`，
  单 schema、无 TEST_SCHEMA，因此这类缺陷在 CI 中不可见、回归也不会被发现。
  另有 `test-parallel.ts` 的**陈旧 schema 前置校验**：分片 schema 的最后一条迁移记录若落后于
  当前迁移集，直接以「DROP SCHEMA ... CASCADE 后重跑」的指引失败，而不是让测试报出难归因的
  跨 schema FK 错误（该误导是本轮排查耗时的主要来源）。
- 阶段 2 的退出条件是「payload 完整 → **evaluator_done** → 超时」。
  注意条件 2 是 `evaluator_done` 而**不是** `evaluator_done && solution_done`：
  Solution 是常驻 host 进程，只在收到 shutdown 帧或 stdin EOF 时退出，而编排循环全程持有
  `sol_input` 既不关闭也不发 shutdown，故 `solution_done` 在生产中不可达；若以它作为条件，
  评测器无 RESULT 结束（崩溃/`sys.exit(1)`）时会空转到总超时才收尾——实测 23.2s，修复后 1.8s。
  该快速失败语义由 `e2e_abnormal.rs` 的 `evaluator_eof_without_result_fails_fast` 守住
  （断言实际耗时 < time_limit_ms 的 3/4）。
- `drain_eval_tail()` 是幂等的，允许在 EOF 与收尾处重复调用。
- 镜像不再继承源码文件模式，本地权限漂移不会再污染镜像；但**镜像内容陈旧问题仍存在**
  （`ensure_sdk_images` 见到 tag 即跳过重建），本地改 SDK 后需手动重建镜像，否则 E2E 验证的是旧 SDK。
- `.test-storage/` 产物不再进入版本控制，测试运行的 diff 噪声消除，干净基线可达。
- 本地执行 `deno task test:domain <domain>` 与 CI 行为一致；仍建议排查此类「本地缺省与 CI 不一致」
  的脚本，避免同类误导性失败。
- **迁移文件的历史修订不会自愈**：drizzle migrator 只比较 `created_at` 与 `folderMillis`，
  **从不比对已记录的 hash**，因此已用旧文本迁移过的 schema 会永久保留旧约束。生产（对象都在
  `public`）不受影响；用旧文本迁移过的非 `public` 分片 schema 需手工 `DROP SCHEMA ... CASCADE`
  重建（上述前置校验会明确指出这一点）。
