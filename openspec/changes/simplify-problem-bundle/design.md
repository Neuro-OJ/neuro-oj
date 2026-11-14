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
- 兼容层有明确的删除时间点，不再无限期保留。

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

仅 `kind: "ai"`。缺省值集中定义在 `packages/problem-bundle/defaults.ts`：

| 字段                        | 缺省值                                   |
| --------------------------- | ---------------------------------------- |
| `evaluator.image`           | `ghcr.io/neuro-oj/noj-evaluator-python`  |
| `evaluator.command`         | `python3 /workspace/evaluate.py`（现有） |
| `evaluator.time_limit_ms`   | 5000                                     |
| `evaluator.memory_limit_mb` | 512                                      |
| `evaluator.network.enabled` | 声明 `llm` 时为 `true`，否则 `false`     |
| `solution.image`            | `ghcr.io/neuro-oj/noj-solution-python`   |
| `solution.call_timeout_ms`  | 5000                                     |
| `solution.memory_limit_mb`  | 512                                      |

- `submission_mode: "prediction"` 不注入 `solution`（与现有校验一致）。
- 规范化后的完整 `runtime_config` 写入草稿，下游（版本发布、镜像白名单、Judge）
  看到的结构与今天相同。
- 缺省镜像仍需通过平台镜像白名单；运营者未登记官方镜像时，导入报错与今天显式写
  镜像时一致。
- 显式 `network.enabled: false` 与 `llm` 同时出现 →
  400（冲突声明，不静默覆盖）。

**备选**：缺省值放进系统设置由运营者配置——题包含义随部署变化，同一题包在不同平台
行为不同，违背「题包可跨部署导入」，否决。

### D3：校验代码抽到 `packages/problem-bundle/`，两侧相对路径引用

```text
packages/problem-bundle/
  mod.ts            # 唯一出口
  manifest.ts       # 格式 3 字段表 + validateManifest
  migrate.ts        # 格式 1/2 → 3 的纯函数转换（CLI migrate 与导入告警共用）
  zip.ts            # unzipWithLimits、根级文件检查
  defaults.ts
  errors.ts         # BundleValidationError { field, message }
  *_test.ts
```

- **零依赖**：不使用任何导入映射条目，只依赖 Deno 标准库的相对 / `jsr:` 精确
  URL（或完全无依赖），从而规避 #514 当初担心的「noj-cli
  依赖主仓库导入映射」问题。
- noj-core 侧把 `BundleValidationError` 包装为 `BadRequestError`；noj-cli
  侧映射为 lint 诊断。
- `deno compile` 会把相对路径模块打进 noj-cli 二进制，发布流程不变。
- 删除 `noj-cli/src/problem/vendor/`、`contract_test.ts`、core 侧契约测试与
  `fixtures/problem-bundle-manifest.json`；fixture 中的用例转为
  `packages/problem-bundle/` 的单元测试。

**备选 A**：CLI `lint` 调用服务端 dry-run 接口——离线不可用，且 `init` / `pack`
仍需本地规则，否决。 **备选 B**：从一份定义生成 JSON Schema
两侧加载——需引入新依赖，且 schema 难以表达 OI 子任务分值总和等规则，否决。

### D4：兼容策略与删除时间点

| 输入                 | v0.12 系列                                 | v0.13 起                            |
| -------------------- | ------------------------------------------ | ----------------------------------- |
| 格式 3               | 接受                                       | 接受                                |
| 格式 2               | `migrate.ts` 转为格式 3 后导入，结果附告警 | 400，提示运行 `noj problem migrate` |
| 格式 1               | 400，提示运行 `noj problem migrate`        | 同左                                |
| Hydro `problem.yaml` | 独立导入器，行为不变                       | 同左                                |

- 格式 1 在本变更内即删除导入期转换：唯一已知存量 `noj-problems` 先行迁移；
  `noj problem migrate` 仍支持格式 1 → 3，供外部出题人离线转换。
- `migrate.ts` 是纯函数，导入期告警与 CLI 重写共用同一转换，保证一致。
- 迁移规则：`is_objective: true` → `objective`；`judge_type: "oi"` → `oi`； 其余
  → `ai`；删除 `type` / `domain_id` / `categories` / `llm.provider_id` /
  `llm.model`；`runtime_config`
  中等于缺省值的字段**保留不删**（只做语义等价改写， 是否精简交给作者）。

### D5：Hydro 导入拆为独立入口

`parseBundleZip` 只处理统一题包；新增 `parseHydroArchive`（OI 归档已有
`oi-archive.ts`，优先并入该文件）。上传入口按根级文件分派：`problem.json` →
统一题包；`problem.yaml` → Hydro；二者皆无 → 现有错误信息。

## Risks / Trade-offs

- **未知字段拒绝可能误伤**：外部题包带自定义字段会导入失败 →
  错误信息指明字段名； 格式 2 迁移期仍走旧的宽松策略，只对格式 3 严格。
- **缺省镜像依赖白名单登记**：新部署若未登记官方镜像，最小题包导入失败 →
  `noj-cli check` 增加「官方评测镜像已登记」检查项，并在错误信息中提示。
- **删除格式 1 转换影响未知外部用户**：当前没有已知外部存量；CHANGELOG
  与导入错误 中给出 `noj problem migrate` 指令。
- **`packages/` 是新的顶层目录**：仅放题包校验一个包，不借机抽取其他共享代码；
  在根 `AGENTS.md` 顶层目录列表登记。

## Migration Plan

1. 落地 `packages/problem-bundle/`（格式 2 + 3 双读，行为与现状等价），core 与
   cli 切换引用，删除 vendor 与契约测试。
2. 新增 `noj problem migrate`，迁移 `noj-problems` 并在 dev-setup
   种子导入中验证。
3. 删除格式 1 导入期转换；更新文档与 `noj problem init` 生成格式 3。
4. v0.13：删除格式 2 读取路径。

每步独立 PR、可单独回滚；第 1 步完成前不改变任何对外行为。

## Open Questions

- 题包导入相关代码是否在本变更中顺带迁入 `features/problem-bundle/`，还是保持在
  `modules/problems/` 待后续「改到即迁」？倾向后者，避免两个重构叠在一个 PR。
- 缺省时限 / 内存（5000 ms / 512 MB）是否需要按 `submission_mode` 区分（如
  `prediction` 仅需较小 evaluator 内存）？倾向不区分，保持规则简单。
