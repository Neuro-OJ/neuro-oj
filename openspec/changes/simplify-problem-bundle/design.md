## Context

动机见 `proposal.md`。现状要点：

- manifest 校验：`noj-core/src/modules/problems/types/problem-bundle.ts`
  （`normalizeBundleManifestFormat` 处理格式 1 → 2，`validateBundleManifest`
  处理题型组合与字段校验）。
- zip 解析：`noj-core/src/modules/problems/services/bundle-parser.ts`
  （`parseBundleZip` 同时识别统一题包与 Hydro `problem.yaml`）。
- 消费方：`problem-bundle-edit.ts` 的 `parseDomainDraftBundle` 已把 manifest
  映射为 `ProblemDraftContent`，其 `kind` 为 `ai` / `oi` / `objective`。
- noj-cli：`src/problem/vendor/` 下三份手工副本，`contract_test.ts` 与 core 侧
  `problem-bundle-contract.test.ts` 共同断言
  `fixtures/problem-bundle-manifest.json`。
- 题包导入后系统剥离 `problem.json` 重建纯净评测包，**存储中不保留 manifest**，
  因此改格式不涉及存量数据迁移。

## Goals / Non-Goals

**Goals:**

- 题型由一个字段决定；每种题型的允许字段一目了然，错误信息统一。
- 最小 AI 编程题 manifest 只需 `format_version`、`kind`、`title` 三个字段。
- 题目包校验只有一份实现，CLI 离线 `lint` 与服务端导入结果一致。
- 旧格式题包无需改动即可继续导入；兼容转换收敛为一个纯函数。

**Non-Goals:**

- 不改变 zip 文件布局、测试数据组织方式或 `evaluate.py` 约定。
- 不改数据库表结构；`problems.is_objective` / `judge_type` 列保持不变。
- 不改评测链路、镜像白名单机制与 ZIP 安全限制。
- 不引入 JSON Schema / zod 等新校验依赖。
- 不改动 Hydro 导入的行为，只调整代码位置。

## Decisions

### D1：格式 3 以 `kind` 判别题型，取值对齐内部 `ProblemDraftContent.kind`

```json
{ "format_version": 3, "kind": "ai", "title": "A+B Problem" }
```

| `kind`      | 允许的题型专属字段                                                             | 根级必需文件                         |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `ai`        | `runtime_config`、`submission_mode`、`template`、`artifact_max_size_mb`、`llm` | `evaluate.py`（`ui` 另需 `ui.html`） |
| `oi`        | `runtime_config`（必填，OI 结构）                                              | `testdata/` 中被引用的文件           |
| `objective` | 无                                                                             | `questions.json`                     |

通用字段（所有 `kind`）：`format_version`、`kind`、`title`、`description`、
`number`、`difficulty`、`tags`、`samples`。

校验实现为「通用字段表 + 每个 `kind` 一张字段表」：先查 `kind`，再查是否有不在
两张表并集内的字段——一条规则替代现有十余条「X 题不允许 Y」。错误信息格式：

> `kind=objective` 不支持字段 `template`；该题型支持：title, description, …

**取名**：沿用内部 `ai` 而非 `code` / `dual`，避免与 `submission_mode: "code"`
混淆，并让 manifest、草稿内容、导入代码共用一套词汇。

**备选**：保留 `is_objective` / `judge_type`，只在文档中整理规则——不能减少
校验分支，也无法给出统一错误，否决。

### D2：`runtime_config` 全字段可缺省，导入时规范化为完整配置

仅 `kind: "ai"`。缺省值集中定义在
`types/problem-bundle.ts`（`AI_RUNTIME_DEFAULTS`）：

| 字段                        | 缺省值                                    |
| --------------------------- | ----------------------------------------- |
| `evaluator.image`           | 官方 `noj-evaluator-python`（加部署前缀） |
| `evaluator.command`         | `python3 /workspace/evaluate.py`（现有）  |
| `evaluator.time_limit_ms`   | 5000                                      |
| `evaluator.memory_limit_mb` | 512                                       |
| `evaluator.network.enabled` | 声明 `llm` 时为 `true`，否则 `false`      |
| `solution.image`            | 官方 `noj-solution-python`（加部署前缀）  |
| `solution.call_timeout_ms`  | 5000                                      |
| `solution.memory_limit_mb`  | 512                                       |

- `submission_mode: "prediction"` 不注入 `solution`（与现有校验一致）。
- 规范化后的完整 `runtime_config` 写入草稿，下游（版本发布、镜像白名单、Judge）
  看到的结构与今天相同。
- 缺省镜像名由 `JUDGE_IMAGE_BASE` 前缀拼接，与 `seed-system`
  写入白名单的官方镜像
  同名，因此开箱即在白名单内；仍需通过白名单校验，与显式写镜像时一致。
- 校验函数本身不读环境变量：前缀由调用方（core 导入）通过参数传入，CLI 离线
  `lint` 不传前缀，只做结构校验。
- 显式 `network.enabled: false` 与 `llm` 同时出现 →
  400（冲突声明，不静默覆盖）。

**备选**：缺省值放进系统设置由运营者配置——题包含义随部署变化，同一题包在不同平台
行为不同，违背「题包可跨部署导入」，否决。

### D3：noj-cli 以相对路径直接引用 noj-core 校验代码

不新建 `packages/` 目录。noj-cli 的 `lint` / `pack` / `migrate`
以相对路径直接导入 noj-core 的
`types/problem-bundle.ts`、`types/runtime-config.ts` 与
`services/bundle-parser.ts`。

- 两侧 `deno.json` 对 `fflate` / `yaml` 的导入映射一致，CLI 侧可直接解析；被引用
  的 core 文件需满足 CLI 的 `noUncheckedIndexedAccess`（已修正两处）。
- `deno compile` 会把相对路径模块打进 noj-cli 二进制，发布流程不变；CI 的
  `production-cli` 任务不做路径过滤，core 改动破坏 CLI 时会被类型检查拦截。
- 删除 `noj-cli/src/problem/vendor/` 与 `contract_test.ts`；共享 fixture 移到
  core 测试目录，作为唯一行为基线。

**备选 A**：抽到 `packages/problem-bundle/`——需改动 54 处 core
引用并新增顶层目录， 收益与直接引用相同，否决。**备选 B**：CLI `lint` 调用服务端
dry-run 接口——离线 不可用，否决。

### D4：旧格式长期自动转换

| 输入                 | 处理                                       |
| -------------------- | ------------------------------------------ |
| 格式 3               | 严格校验                                   |
| 格式 2               | `upgradeBundleManifest` 转为格式 3，附告警 |
| 格式 1（P）          | 同上；U 包或未声明分类仍拒绝               |
| Hydro `problem.yaml` | 规范化为 `kind: "oi"` 格式 3，行为不变     |

- 不设删除时间点：已有题包（含 `noj-problems` 中的格式 1 题）无需改动即可导入。
- `upgradeBundleManifest` 是纯函数，导入期告警与 `noj problem migrate`
  共用；它不 注入平台缺省值，因此 `pack` / `migrate` 写回的 manifest
  不会固化部署相关镜像。
- 迁移规则：`is_objective: true` → `objective`；`judge_type: "oi"` → `oi`；其余
  → `ai`；删除 `type` / `domain_id`；`llm` 只保留 `max_calls` / `max_tokens` /
  `models`；格式 3 不认识的字段（如
  `categories`）丢弃并告警；题型不匹配的已知字段 保留，交由格式 3
  校验拒绝（与旧行为一致）。

### D5：Hydro 导入保留在 `parseBundleZip`

Hydro 分支只是构造一份 `kind: "oi"` 的格式 3 manifest，拆成独立入口收益有限；本
变更不拆分，留待题包代码迁入 `features/` 时一并处理。

## Risks / Trade-offs

- **未知字段拒绝可能误伤**：只对格式 3 严格；旧格式的未知字段丢弃并告警。
- **缺省镜像依赖白名单**：缺省名与种子写入的官方镜像同名；运营者若改过官方镜像名，
  最小题包导入会以白名单错误失败，需显式写镜像。
- **CLI 依赖 core 源码路径**：core 题包文件移动时需同步 CLI 引用，由 CI
  类型检查兜底。

## Migration Plan

1. CLI 直接引用 core，删除 vendor 与 CLI 契约测试（行为不变）。
2. 格式 3：`kind`、字段表、缺省值、`llm` 隐含网络；旧格式自动转换。
3. `noj problem migrate`、`noj problem init` 生成格式 3、文档改写。

三步在同一 PR 落地；旧格式持续可导入，无需协调外部题源。

## Open Questions

- 题包导入相关代码迁入 `features/problem-bundle/` 留待后续「改到即迁」。
- `noj-problems` 是否批量运行 `noj problem migrate`，由该仓库维护者决定。
