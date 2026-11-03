# Agent Note: 按真实变更路径选择 Core/E2E 测试范围

Status: implemented

## Problem

CI 用 `dorny/paths-filter` 按 `noj-core/src/domains/*` 维护 15 个 domain job。
模块迁移到 `src/modules/*` 后这些过滤器长期不命中；同一模块测试又在 legacy
domain job 与完整分片 job 中重复执行。新增/删除/重命名文件无法被正确归类，
选择器可能输出空集合或漏跑业务测试。

## Decision

- `scripts/select-core-ci.ts` 直接接收 base/head 的真实变更路径
  （`git diff --name-status -z -M`，重命名前后路径都参与），按
  `dev-docs/engineering/module-boundaries.json` 的 `ciSelection` 规则分类： Core
  测试文件 → 所属模块 + 固定契约；生产模块 → 模块 + 反向依赖闭包 （合并
  base/head 依赖图），并附加 Browser 与 cross-domain；shared/schema/
  迁移/启动器/模块映射/未知路径 → 全量 Core + 全量 E2E。
- E2E 模块映射写入同一份元数据（access→identity/admin/rate-limit，
  problems→catalog/objective，evaluations→submission/objective，
  contests→contest，communication→community，education/read-models→browser+
  cross-domain，application/http/runtime→全部 API E2E）。
- 选择器解析失败或出现无法解释的路径时扩大到全量并写原因，绝不输出空选择。
- CI 的 Core 回归统一由 `Core Sharded (isolated PostgreSQL)` 执行
  （`test:parallel --shards 4 --jobs 2`）；删除 15 个 legacy domain job、
  `core-shared` 与重复的 `core-perf`；`test:domain` 保留为本地兼容入口。

## Alternatives considered

- 继续维护 paths-filter 规则：新增模块/重命名时仍会静默漏跑。
- PR 一律全量：能满足覆盖但放弃影响范围选择带来的 Runner 节省。
- 只按头侧 import 计算反向依赖：删除/迁移文件时闭包缺失，故合并 base 侧。
- 按模块缩水分片执行：生产依赖存在 access↔platform 等环，闭包几乎覆盖全部
  模块，缩水既不安全也无收益。

## Consequences

- 16 个执行测试的 CI job 被删除；同一文件不再同时在 legacy job 与完整分片执行。
- 选择器有 16 个行为用例，覆盖新增/修改/删除/重命名、legacy 别名、未知路径、
  共享路径、解析失败回退与受跟踪文件全覆盖。
- 文件级耗时基线当前是估算值（source 字段标注），P0 实测后以同一结构替换；
  替换前分片只保证覆盖与确定性，不宣称最优均衡。
