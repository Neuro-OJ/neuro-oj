# Agent Note: Domain 并行 CI

Status: implemented

## Problem

noj-core 与 noj-tests 的测试此前各自跑在单个大 job 里：`core-test-unit` /
`core-test-db` / `core-smoke` / `judge-e2e` 与一个 `e2e` 全量
job。任何一处改动都会触发整套测试，PR 反馈时间随测试增长线性上升；E2E 大 job
串行跑 39 个文件（约 6-10 分钟），失败时难以定位到域。

同时存在两个隐患：

- 路径过滤粒度粗（只按模块），改一个域的代码也会跑全部域测试；
- 拆分后如果路径过滤有洞，`changes` job 会输出空数组，所有 job 被跳过而 workflow
  仍报成功——「零测试执行的假绿」。

## Decision

把 core 与 E2E 测试按业务域拆分，每个域一个独立
job，并按路径过滤只跑受影响的域。

- **目录重排**：`noj-tests/e2e/<domain>/*.test.ts`（identity / catalog /
  submission / contest / system / community / messaging / objective / admin /
  cross-domain / browser / staging）；`noj-core` 域内测试保持在
  `src/domains/<domain>/tests/`。
- **统一命令**：`deno task test:domain <domain>`（core 与 noj-tests 各一份）+
  `bash scripts/test-shared.sh`（core
  共享测试）。脚本自带域名校验、usage、`BCRYPT_SALT_ROUNDS=4`、`--preload=tests/preload.ts`、`--no-check`，使本地与
  CI 走同一套环境；`AGENTS.md` §8.5 要求按域测试必须用这些命令。
- **路径过滤**：`ci.yml` 的 `core-<domain>` / `core-shared` 与 `e2e.yml` 的
  `e2e-<domain>` / `e2e-cross-domain` / `e2e-browser`。`core-shared` 覆盖
  `noj-core/src/{shared,routes,app,main,mod}`、`drizzle`、`tests`、`scripts`、`deno.json`、`deno.lock`、`drizzle.config.ts`、`package.json`、`data/**`，任一命中即触发全部
  core 域；`e2e-infra` 覆盖
  `noj-core/src/shared`、`noj-core/drizzle`、`noj-judge`、`noj-llm-gateway`、`docker-compose.e2e.yml`、`env.e2e.template`、`scripts/**`、`noj-tests/scripts/**`、`noj-tests/deno.json`、`noj-tests/deno.lock`、`noj-tests/e2e/*.ts`（含被全部
  E2E import 的
  `helper.ts`）、`noj-tests/run-e2e.sh`、`noj-tests/e2e/support-package/**`、`.github/actions/e2e-domain/**`，任一命中即触发全部
  API 与浏览器 E2E。
- **语义化校验**：`scripts/verify-domain-ci.ts` 解析两个 workflow 的 `filters`
  与 `jobs`，断言每个域都有 job 与过滤、workflow 内 domain
  列表与文件系统一致、`e2e/` 根目录无游离测试，并用 glob 匹配 `git ls-files`
  的**每个受跟踪文件**，要求它至少被一个会触发测试的过滤命中（文档/镜像/测试产物走显式白名单）。该脚本接入
  `scripts/check-ci.ts` 与 `scripts/check-all.ts`。
- **其他**：`scripts/staging/acceptance.sh` 指向新路径
  `e2e/staging/staging-smoke.test.ts`；`core-shared` 恢复 issue #430
  的执行摘要（`JWT_SECRET_SOURCE` +
  数据库集成测试实际执行记录）；`E2E_TESTING.md` 与 `testing.md`
  同步新布局与命令。

## Alternatives considered

- **matrix 生成 job**（设计文档曾规划）：能消除 13 个 core job
  的复制粘贴，但每个域的 services / 环境变量 / 测试命令差异需要 `include`
  逐项覆盖，YAML 复杂度并未下降；本次改为「语义校验 +
  文件系统对齐」来消除漂移风险，matrix 留待后续重构。
- **保留单 job + `deno test --parallel`**：PG `resetDbForTest()` 的 TRUNCATE
  在并发下死锁，不可行。
- **只按文件数分片**（shard by
  file）：能提速但失败无法按域归因，且过滤粒度仍粗。
- **路径过滤只列「有测试的目录」**：会漏掉共享 helper / 脚本 / lock
  文件，正是「零触发假绿」的来源；因此改成「每个受跟踪文件必须被某个过滤命中」的强约束。
- **用字符串包含检查回归**：无法发现删除 job、删除某条 pattern
  的情况，已被语义校验取代。

## Consequences

- PR 反馈时间显著下降（E2E 由单 job 串行变为按域并行，各域 4-6
  分钟）；失败定位到域。
- 新增域需要同步 4 处（job、过滤、workflow 内 domain 列表、脚本白名单），但
  `verify-domain-ci.ts` 会在缺任何一处时失败，漂移不再静默。
- `core-shared` 触发全部 core 域、`e2e-infra` 触发全部 E2E，共享文件改动的 CI
  成本较高（约 25 个 job），属于以正确性换成本。
- 本地按域运行需要完整 E2E 栈；`staging` 域仅由验收脚本使用，不在 PR CI
  中执行（已在文档与校验脚本中显式声明）。
