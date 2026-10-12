# 面 7 — 测试体系健康度审计报告

> 审计面：测试体系健康度（假绿 / 静默跳过 / 门禁自测 / 环境漂移） ｜ 类型：II 二次审计
> 派发：2026-09-29 08:31 ｜ 返回：2026-09-29 08:4x ｜ 审计员：subagent（只读；探针使用只读 SELECT）
> 复核：**未经独立复核**（按 L1 口径，下列结论为单方证据 + 本轮会话的一手复现）
> 说明：本面 A 部分的 6 条来自**本会话真实踩到的伤痕**（我提供现象与怀疑机制），审计员逐条验证/证伪

## A. 逐条验证（本会话一手伤痕）

| id | 类别 | 结论 | 位置 | 证据（要点） | 影响面 | 最小修法 |
|---|---|---|---|---|---|---|
| **A1** | 产品缺陷（类型谎言）+ 环境缺陷 | **确认**（机制实测） | `shared/base/sql-rows.ts:74-90`、`identity/.../users-profile-queries.ts:85,221-232`、`users-profile-types.ts:44,93`、`users-profile.ts:67,130` | 审计员实测：**PGlite `count(*)` → `number 2`**；**postgres.js（真 PG）→ `string "2"`**；`count(*)::int` 两者皆 number。即 `sql<number>` **只是类型断言、无运行时转换**。全仓裸 `count(*)`（无 `::int`）**12 处生产点**（users-profile-queries、banlist、checkin、queue、submissions-crud、users、submissions-rejudge、contests、messages、community-feed） | 消费侧靠**散落的 `Number()` 兜底**（7 处已兜）；**漏兜一处即生产返回 string**（前端做算术/分页即错）。本轮 CI 红即此通道的产物：测试作者被迫手写 `Number(...)` 规避 | 12 处一律 `count(*)::int`（或统一转换函数）；原始行类型改 `number \| string` 逼消费点显式转换；补一条**跨引擎**断言（真 PG 下 `typeof === 'number'`） |
| **A2** | 测试写法缺陷 + 环境缺陷 | **确认现象**，具体触发进程**存疑** | `identity/tests/services/search-events.test.ts:12-40`、`tests/helper/search-events.ts:9-36`、`shared/mq/connection.ts:88`、`main.ts:305` | 用例唯一依赖 = **进程外全局 Redis 键 `noj:search:index`** 上 5s 内 `lrange` 到事件；`REDIS_URL` 未设时硬编码 `redis://127.0.0.1:6379/`（dev Redis）；测试文件自己的注释承认"同分片并行操作同一键 → 全量分片必现假失败、单文件必过"；9 个域各复制一份、**无前缀隔离、无清理**。候选机制：`startSearchIndexConsumer()` 只在 `main.ts:305` 启动 → 本地若同时跑着 `deno task dev`，dev 消费者会 BRPOP 搬走事件 | 本地该域**稳定红** → 开发者对 search 相关红免疫，**真回归与假失败无法区分**；同一断言 CI 绿 → 本地结论不可信 | 测试改独立 key 前缀 / 独立 redis db（如 db 15），并把"禁止与 dev 消费者共用 6379/db0"写进 test:domain 环境；或对 producer 注入 fake redis 做单元断言 |
| **A3** | 门禁缺陷 | **确认：既过严又过松** | `scripts/silent-skip-report.ts:52-76`（计数）、`:182-201`（比较）、baseline | 规则 `ignore: <标识符>` **不求值、只按模式计数** → `ignore: skip` 即使 `const skip = false` 也 +1（`ignore: skip` 419 处、`skipEnv` 44、`skipDb` 43 → **506/661 属标识符式**，语义不可判定）。同时实测正则：`ignore: (skip)` **MISSED**、`ignore: !skipEnv` **MISSED**、跨行 `ignore:\n skip` **MISSED** | **双向失真**：不跳过的写法照样计数（卡人 → 人们倾向 `--update-baseline` 抬基线 → 棘轮退化）；**真跳过可用一对括号或 `!` 无痛绕过门禁**（门禁失效） | 对 `ignore: <const>` 做同文件常量求值（`false/undefined/null` 不计）；把 `(`/`!`/跨行纳入扫描；在 `silent-skip-report_test.ts` 加这两类对抗用例 |
| **A4** | 环境缺陷 + 门禁缺陷 | **确认** | 缺跳过项：`verify-md-links.ts:5-15`、`silent-skip-report.ts:206-215`（有 `.deno_cov_cache` 无 `.deno_cache`）、`check-file-size.ts:56-66`、`check-log-migration.ts:178-188` | 已有跳过：`check-test-discovery.ts:42`、`verify-domain-ci.ts:150`、`verify-compile-safe-imports.ts:182`、`check-dashboards.ts:165`；`check-deno-version.ts:120-125` 以"跳过所有 `.` 开头目录"覆盖。**关键**：仓库自己就把 DENO_DIR 放进仓库 —— `.github/workflows/ci.yml` 18 处 + `e2e.yml:73` 用 `DENO_DIR=${{github.workspace}}/noj-core/.deno_cache` 且用 `actions/cache` 缓存它；`noj-llm-gateway/deno.json` 用 `.deno_cov_cache` | 今天 CI 未炸**只因 Root Gates job（ci.yml:471-486）恰好不设 DENO_DIR**；一旦把它提到 job 级或并入带缓存 job，`verify-md-links` 立即被第三方 README 淹没（本轮实测 5560 条错误）。同时**淹没真链接错误** | 建共享 `EXCLUDED_DIRS`（含 `.deno_cache`/`.deno_cov_cache`/`.test-cache`）供所有遍历型门禁引用；加自测：临时目录造 `.deno_cache/x.md` 断言不被扫 |
| **A5** | 环境缺陷（脚本） | **确认** | `scripts/e2e/setup.sh:50`（无 `-p`）、`scripts/e2e/teardown.sh:20`（`down -v` 同样无 `-p`）、两份 compose **均无顶层 `name:`**、`.github/workflows/e2e.yml:57` | 两份 compose 都缺顶层 `name:` → 项目名默认取目录名（仓库根）→ **e2e 与 dev 同项目 `neuro-oj`**；`up` 按"项目+服务名"认领已存在的 dev 容器，配置哈希不同（container_name/端口/镜像全不同：5432/6379/9000 vs 5433/6380/9002）→ **直接重建为 `noj-e2e-*`**。**CI 侧有 `COMPOSE_PROJECT_NAME: noj-e2e`（保护只存在于 CI，本地没有）**。`down -v` 更重：删项目内匿名卷 | 一次 `bash scripts/e2e/setup.sh` 即中断本地 dev DB/Redis/MinIO（**本会话实际发生**）；`teardown.sh` 后 dev 容器/网络消失（dev 具名卷因未在 e2e 文件声明而侥幸存活） | setup.sh / teardown.sh 统一 `export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-noj-e2e-local}"`（或每条 compose 命令加 `-p`）；`check-setup.sh:26` 已在 grep setup.sh 的 compose 行 → 加一条"必须带 `-p`/COMPOSE_PROJECT_NAME"断言即固化为门禁 |
| **A6** | 门禁缺陷（覆盖） | **确认今天仍成立（根 scripts 无漏网）** | `scripts/gate-list.ts:31-58、93-95、129-135` | `comm` 比对 `scripts/*_test.ts`（25 个）与 `GATE_SELF_TESTS` → **差集为空**；唯一"列出但根目录不存在"的 `check-schema-parity_test.ts` 带 `cwd: "noj-core"`（真实存在于 `noj-core/scripts/`，非漂移）；`scripts/deploy/*_test.ts` 由 `gate-list.ts:93-95` 单独条目执行 | 根 scripts 自测无漏网；**漏网在 `scripts/deploy/` → 见 B2** | 保持清单；B2 收口后加元检查 |

## B. 审计员独立发现的假绿/体系缺陷

| id | 类别 | 结论 | 位置 | 证据（要点） | 影响面 | 最小修法 |
|---|---|---|---|---|---|---|
| **B1** | 产品缺陷 + 门禁缺陷（**死守卫 + 注释方向写反**） | **确认** | `shared/base/sql-rows.ts:74-90` | `countToNumber` 全仓仅 2 处引用：自身定义 + `tests/shared/sql-rows.test.ts:59-65` → **生产 0 调用**（门禁写了、没人用）。且注释声称 "PGlite→string / postgres.js→number"，与实测（PGlite→number、postgres.js→string）**完全相反** | 后来者按注释会"往反方向修"；A1 的类型谎言因此没有强制收口点 | 删函数或强制采用（lint/门禁禁裸 `count(*)`）；注释改为实测口径；补跨引擎断言 |
| **B2** | 测试写法缺陷 + 门禁缺陷（**写了却永不执行**） | **确认** | `scripts/deploy/restore-drill-verify_test.ts` | 全仓引用仅 `scripts/README.md:55` 与 dev-docs 计划文档；`gate-list.ts` 无该文件 test 条目（相邻两个 `verify-*_test.ts` 有，`:93-95`）；`check-test-discovery.ts:36-42` **只覆盖 noj-core 模块测试目录**，不管 `scripts/` | 弃用闸门（deploy.sh/restore-drill.sh 的 y 确认、非 TTY 不挂起、零副作用）的测试**无声腐坏** | 加入 `gate-list.ts:93-95` 那条 `deno test`；并给 check-test-discovery 加元检查"仓库内每个 `_test.ts` 必须出现在某执行入口" |
| **B3** | 门禁缺陷（**检查恒真 + 只读门禁有副作用**） | **确认** | `scripts/silent-skip-report.ts:296-300` vs `:330-336` | `--check` 分支先**无条件** `writeTextFile(REPORT_PATH, md)`，随后才 `readTextFile` 与**同一个 `md`** 比较 → `onDisk !== md` **永远为假**，"报告过期"这条检查是**死检查**；同时 `--check` 会改写 git 跟踪的报告文件 | 报告新鲜度完全不设防（git 里可任意陈旧，CI 自动覆盖）；CI 里改工作树会污染后续 diff/门禁 | 先读盘上报告比对，**仅在非 `--check` 时**才落盘 |
| **B4** | 门禁缺陷（**棘轮可被合法洗白**） | **确认** | `silent-skip-report.ts:182-201、317-322`、baseline | 比较只判 `count > base`（reason 与 file 两维）；`--update-baseline` 直接落盘、**无任何"必须净减少"约束**；基线绝对值已 1014（ignore 661）；叠加 A3 的绕过写法 | 门禁退化为"每次改动抬一格基线"的仪式：噪声高却拦不住真实新增跳过 | `--update-baseline` 强制 `total` 单调递减（否则需显式 `--allow-growth=<理由>`）；先剔除 A3 的 `skip=false` 假阳性再重定基线 |
| **B5** | 环境缺陷（**本地/CI 结论不可比，且无等价性断言**） | **确认** | `noj-core/scripts/test-domain.sh:66-78`、`.github/workflows/ci.yml:580,617` | `test-domain.sh` 在未设 `DATABASE_URL` 时**静默走 PGlite**（本地默认），CI 同名 job 显式设 `DATABASE_URL` → 真 PG；两者跑同一批用例，但**全套用例里没有一条断言两种引擎的返回类型/语义等价**（grep 无 count 类型断言） | **"本地绿"不代表"CI 绿"**（反之亦然）；类型级漂移只能等 CI 红才发现（A1 正是此盲区漏出来的） | 加 `tests/db/engine-parity_test.ts`：对 count/numeric/日期/`::int` 等易漂移列断言 typeof + 值，在 PGlite 与真 PG 两种模式都跑并进 CI |

## 结论

### ① A 部分逐条裁定
1. **A1 确认**（类型谎言成立、机制实测坐实；本轮 CI 红是修复前伤痕，非当前必现）
2. **A2 确认现象**（本地红/CI 绿的构造成因清楚：全局 Redis 键 + 无隔离 + dev 消费者共存），触发进程**存疑**
3. **A3 确认：既过严又过松**（`ignore: skip` 且 skip=false 属假阳性；`ignore: (skip)` / `!skipEnv` 可绕过）
4. **A4 确认**（4 处门禁缺 `.deno_cache` 跳过项，而 CI 自己就把 DENO_DIR 指向仓库内）
5. **A5 确认**（本地无项目名隔离 → 执行即重建 dev 栈；`down -v` 更危险；CI 有保护、本地没有）
6. **A6 确认**（根 `scripts/*_test.ts` 无漏网；漏网在 `scripts/deploy/`，见 B2）

### ② 最值得优先修的 3 条（审计员排序 + 本轮处置）
1. **A5** —— 唯一会**当场毁掉别人工作环境/数据**的一条，触发成本是"跑一次官方脚本"，修法 3 行 + 一条现成 check-setup 断言。**本轮已修**（见 `evidence/07-A5-e2e-project-name.txt`）。
2. **A1 + B1** —— "本地绿 CI 红"的**根因类**问题，且已在测试里留下 `Number()` 规避痕迹（说明在持续扩散）；B1 证明现有守卫是死的、注释还是反的。修法机械（12 处 `::int` + 一条跨引擎断言）。**本轮未修**，列入待办。
3. **A3 + B4** —— 门禁的**元问题**：棘轮既是当前唯一能拦"静默跳过增长"的机制，又同时存在假阳性与真漏检，叠加基线可抬 → 保护力接近 0 而噪声很高。**本轮未修**（改门禁口径属设计决策），列入待办。
