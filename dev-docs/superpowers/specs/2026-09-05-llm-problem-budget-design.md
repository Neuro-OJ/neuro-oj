# 题目级 LLM 调用/token 上限设计

> Status: proposed
> Date: 2026-09-05
> Scope: noj-core / noj-llm-gateway / noj-judge SDK / noj-ui / noj-problems(trial-snowy-manor)

## 1. 背景

当前单次评测的 LLM `max_calls` / `max_tokens` 由 noj-core 从平台环境变量
`NOJ_LLM_MAX_CALLS` / `NOJ_LLM_MAX_TOKENS` 统一读取，并签入 `eval_token`。
所有 LLM 题共享同一预算，无法让不同题目声明各自需要的“有限 token 解题”预算。

PR #421 已引入 billed-token 计费口径：上游返回 `usage.prompt_tokens_details.cached_tokens`
时，缓存命中部分不计入限额；gateway 在超限时返回 OpenAI 兼容
`429 { error: { code: "out_of_usage" } }`。这为“题目声明自己的上限并由 gateway 强制”
提供了现成的执行通道。

trial-snowy-manor 当前在 evaluator 侧维护一套本地 LLM 预算
（`NOJ_TRIAL_MAX_LLM` / `NOJ_TRIAL_MAX_TOKENS`，默认 30 / 20000），在转发 gateway 前
自行计数拦截，并在 `scoring()` 中计算 LLM 效率分。该机制与“题目级预算由 gateway 统一
强制”的架构重叠，且会因题目声明值与本地默认值不一致而误停或漏停。

## 2. 目标

- 允许题目在 `problem.json` / 管理端 UI 中声明本次评测的 LLM 调用次数与 token 上限。
- 题目声明值通过现有 `eval_token` 传给 noj-llm-gateway，作为该题整次评测的硬上限。
- 未声明时继续使用平台默认 `NOJ_LLM_MAX_CALLS` / `NOJ_LLM_MAX_TOKENS`。
- 移除 trial-snowy-manor 的本地 LLM 预算与 LLM 效率分，超限统一由 gateway 返回
  `out_of_usage`，题包捕获后判 0 分。
- 保持 evaluator/选手侧不感知额度（KISS，不注入额外运行时环境，不做剩余额度查询）。

## 3. 非目标

- 不约束用户自带 BYOK（`user_llm`）的调用；BYOK 仍走现状的平台/用户配额保护。
- 不新增 `JudgeTaskLlm` 的显式 `max_calls` / `max_tokens` 字段。
- 不向 evaluator 注入题目预算环境变量。
- 不提供选手侧“剩余额度查询”capability。
- 不改变 noj-llm-gateway 的限流/结算逻辑。
- 不新增数据库列或 SQL 迁移。

## 4. 现状与耦合点

| 耦合点 | 位置 | 说明 |
|---|---|---|
| 题目 LLM 配置 | `noj-core/src/domains/catalog/types/problems.ts` `LlmConfig` | 仅 `provider_id` / `model` |
| manifest 校验 | `noj-core/src/domains/catalog/types/problem-bundle.ts` `validateBundleManifest` | 复用 `isValidLlmConfig` |
| CRUD 校验 | `noj-core/src/domains/catalog/services/problems/problems-crud.ts` | 创建/更新时校验 `input.llm` |
| eval_token 签发 | `noj-core/src/domains/gateway/services/llm-token.ts` `buildJudgeTaskLlm` | 从环境变量读默认上限 |
| 硬限执行 | `noj-llm-gateway/src/limits.ts` + `routes/llm.ts` | 从 `eval_token` 读 `max_calls/max_tokens`，已支持 billed-token 与 `out_of_usage` |
| 题目 UI | `noj-ui/components/editor/CodingProblemEditor.vue` | LLM 区块仅 provider/model |
| trial 本地预算 | `noj-problems/trial-snowy-manor/sdk_evaluate.py`、`evaluate_offline.py`、`scenario_runner.py` | 本地计数 + LLM 效率分 |

## 5. 设计

### 5.1 数据模型与格式

扩展 `LlmConfig`：

```ts
interface LlmConfig {
  provider_id: string;
  model: string;
  /** 单次评测 LLM 调用上限；缺省 = 平台默认 */
  max_calls?: number;
  /** 单次评测 LLM billed token 上限；缺省 = 平台默认 */
  max_tokens?: number;
}
```

- `problems.llm_config` 仍为 JSONB，无 SQL 迁移。
- `problem.json` 示例：

```json
{
  "llm": {
    "provider_id": "REPLACE_WITH_PROVIDER_UUID",
    "model": "REPLACE_WITH_MODEL",
    "max_calls": 30,
    "max_tokens": 20000
  }
}
```

- 语义：平台固定 LLM 的整次评测总预算，按 billed token 口径由 gateway 强制。
- `null` / `0` / 负数 / 非整数均非法；缺省才表示“用平台默认”。

### 5.2 校验规则

校验分两层，避免纯函数/纯 manifest 校验读取环境变量：

- 纯校验 `isValidLlmConfig` 只做类型与值域检查：
  - `max_calls` 若存在，必须是正整数（`Number.isInteger && > 0`）。
  - `max_tokens` 若存在，必须是正整数。
- 服务层“天花板校验”（写库前执行，读取平台默认作为安全上限）：
  - `createProblem` / `updateProblem`（problems-crud.ts）：若题目声明 `max_calls` > `NOJ_LLM_MAX_CALLS`，拒绝（400）；`max_tokens` 同理。
  - bundle 导入路径 `createViaCrud` / `updateExisting`（problem-bundle.ts）：同样执行天花板校验，不能只依赖 `createProblem` / `updateProblem` 覆盖。
  - 未声明则使用平台默认；声明值只能小于等于平台默认。
- 在 eval_token 签发处仍执行 `Math.min` 防御，防止配置与代码间出现竞态/不一致。

### 5.3 noj-core 改动

新增集中 helper（建议放 `llm-token.ts` 或共享目录，供 CRUD、bundle 导入与 token 签发复用）：

```ts
export function getDefaultLlmLimits(): { max_calls: number; max_tokens: number } {
  return {
    max_calls: Number(Deno.env.get("NOJ_LLM_MAX_CALLS") ?? "100"),
    max_tokens: Number(Deno.env.get("NOJ_LLM_MAX_TOKENS") ?? "50000"),
  };
}

export function resolveLlmLimits(
  llm: Pick<LlmConfig, "max_calls" | "max_tokens">,
): { max_calls: number; max_tokens: number } {
  const defaults = getDefaultLlmLimits();
  return {
    max_calls: Math.min(llm.max_calls ?? defaults.max_calls, defaults.max_calls),
    max_tokens: Math.min(llm.max_tokens ?? defaults.max_tokens, defaults.max_tokens),
  };
}
```

- 服务层（CRUD 与 bundle 导入）在写库前调用 `getDefaultLlmLimits()` 做天花板校验，
  拒绝声明值大于平台默认的请求。
- `buildJudgeTaskLlm`（平台固定 LLM）改用 `resolveLlmLimits(llmConfig)`，
  将结果写入现有 `eval_token` 的 `max_calls` / `max_tokens`：
  - 题目声明了值 → 使用题目值（已 ≤ 平台默认）。
  - 题目未声明 → 使用平台默认。
- `buildJudgeTaskLlmForProvider`（BYOK / sweeper 恢复）保持现状不变，继续读平台默认。
- 各 submission 调用点无需修改，因为它们已经传入完整的 `LlmConfig`。

### 5.4 noj-llm-gateway / noj-judge

- noj-llm-gateway 不需要代码改动：已从 `eval_token` 读取 `max_calls/max_tokens`，
  由 Redis Lua 原子检查 + billed-token 结算强制，超限返回 `out_of_usage`。
- noj-judge Rust worker 不需要代码改动：不新增 MQ 字段，不注入 evaluator 环境，
  SDK 与题包之间仍沿用现有 stdout 协议。
- noj-judge 的 evaluator Python SDK `llm.py` 需要增强错误信息（见 5.5），
  使题包能识别 gateway 429 `out_of_usage`。

### 5.5 noj-judge SDK 错误增强

`noj_evaluator_sdk/llm.py` 的 `LLMError` 增加结构化字段：

```python
class LLMError(Exception):
    def __init__(self, message: str, status_code: int | None = None,
                 error_code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
```

在 `HTTPError` 分支解析响应体：

```python
detail = e.read().decode("utf-8", errors="replace")
try:
    body = json.loads(detail)
    error_code = body.get("error", {}).get("code")
except Exception:
    error_code = None
raise LLMError(
    f"LLM gateway 返回 {e.code}: {detail}",
    status_code=e.code,
    error_code=error_code,
)
```

保持向后兼容：现有 `str(exc)` 行为不变；测试仅新增 429 `out_of_usage` 断言。

### 5.6 noj-ui / 管理端

`CodingProblemEditor.vue`：

- LLM 区块增加两个可留空数字输入：
  - 单次评测调用上限（`llmMaxCalls`，正整数，可空）
  - 单次评测 token 上限（`llmMaxTokens`，正整数，可空）
- 编辑模式从 `llm_config.max_calls / max_tokens` 回填。
- 提交时：
  - 留空则不发送 `max_calls` / `max_tokens` 键（由服务端使用平台默认）。
  - 填写则随 `llm` payload 一起发送。
- 前端校验：若填写则必须是正整数；最终以服务端天花板校验为准。
- 组件类型定义同步更新（LLM config 类型含可选 max 字段）。

### 5.7 trial-snowy-manor 适配

#### 5.7.1 移除本地 LLM 预算

- `sdk_evaluate.py`：
  - 不再读取 `NOJ_TRIAL_MAX_LLM` / `NOJ_TRIAL_MAX_TOKENS`。
  - 不再用本地计数在调用前拦截。
  - `cap_llm_complete` 改为直接调用 `llm.complete()`；
    - 若 `LLMError.error_code == "out_of_usage"`（或 429 + code），置
      `runner._is_failed = True` 并抛出 `RuntimeError("out_of_usage")`。
    - 其他错误继续按原样抛出/处理。
- `scenario_runner.py`：
  - `TrialRunner` 移除 `max_llm_calls`、`max_llm_tokens` 构造参数。
  - 移除 `used_llm_calls`、`used_llm_tokens`、`llm_called()`。
  - `scoring()` 不再计算 LLM 效率分。
- `evaluate_offline.py`：
  - 不再传 `max_llm_calls=30`，`Api.llm()` 不再调用 `runner.llm_called()`。
  - 返回值移除 `used_llm_calls` / `used_llm_tokens`。
- `README.e2e.md` 删除 `NOJ_TRIAL_MAX_LLM` / `NOJ_TRIAL_MAX_TOKENS` 相关说明。

#### 5.7.2 评分结构调整

- 移除 `EFFICIENCY_SCORE = 50` 与全部效率分计算。
- `MASTERMIND_SCORE` 从 200 调整为 250，使满分保持 1000：

| 分项 | 分值 |
|---|---|
| 反驳（每轮 100 × 5 轮） | 500 |
| 主谋 | 250 |
| 关键证据 | 200 |
| 理由评分 | 50 |
| **满分** | **1000** |

- `scoring()` 各分支的 `max_score` 保持 1000；失败分支仍返回 0。
- 单测中依赖旧满分/效率分的断言同步更新。

#### 5.7.3 超限转 0 分语义

- 选手 Agent 在 `solve_agent` 内通过 `llm_complete` 消耗预算：
  - 预算未耗尽：正常返回。
  - 预算耗尽：gateway 返回 429 `out_of_usage`，`cap_llm_complete` 捕获后置失败并抛出；
    `sdk_evaluate.main()` 的异常捕获路径会把整次评测记为 0 分（或 runner 已 failed）。
- 评测后的 LLM-as-judge 理由评分若遇到 `out_of_usage`，现有异常捕获令
  `reason_score = 0`，不会产生额外扣费。

### 5.8 测试计划

| 模块 | 测试 |
|---|---|
| noj-core types | `isValidLlmConfig` 接受合法 max 字段、拒绝 0/负/非整数 |
| noj-core problem-bundle | manifest 携带合法/非法 max 字段、客观题拒绝、非 P 拒绝 |
| noj-core CRUD | 创建/更新时 max > 平台默认被 400 拒绝 |
| noj-core llm-token | `buildJudgeTaskLlm` 使用题目 max 写入 eval_token；缺省使用平台默认；BYOK 仍用默认 |
| noj-judge SDK | `llm.complete` 对 429 `out_of_usage` 抛 `LLMError(status_code=429, error_code="out_of_usage")` |
| noj-problems | trial 单测适配：TrialRunner 无 LLM 预算、评分满分 1000、失败分支 0 分 |
| noj-ui | 类型检查/模板编译；后续可加组件测试 |

## 6. 兼容性

- 已存在的 `problem.json` / `llm_config` 不包含 max 字段，行为与现状完全一致。
- 已有 `NOJ_LLM_MAX_CALLS` / `NOJ_LLM_MAX_TOKENS` 环境变量语义不变。
- `eval_token` 格式不改变（payload 字段仍为 `max_calls/max_tokens`，只是值来源变化）。
- gateway / judge MQ 协议不变。

## 7. 风险与缓解

- 题目声明值与平台默认不一致导致误判：通过 CRUD/import 写前拒绝 + 签发时
  `Math.min` 双重保障。
- trial 移除本地预检后，若选手死循环调用 LLM，会直接打到 gateway 超限返回 0 分，
  不会再由本地提前停；这是“配额到了直接零分”的题面设计预期。
- LLM-as-judge 评分与选手共用同一预算：若选手耗尽预算，reason 分可能为 0；
  这是“整次评测总预算”语义的预期结果，文档会明确说明。

## 8. 后续（不在本次范围）

- 题目级上限的展示/管理报表（如 usage 页显示题目声明值与实际消耗）。
- 是否让 BYOK 也支持用户级自定义上限。
- 是否把题目上限暴露给 evaluator 做更精细的评分（当前明确不做）。
