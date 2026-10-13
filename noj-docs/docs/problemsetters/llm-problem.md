# 出 LLM 调用题

本页面向出题人：当题目需要让 evaluator 调用真实 LLM API（例如 LMCC 第二轮常见的
"考生提供 Prompt / 生成参数，评测器调用 LLM 评分"）时，如何安全地接入
`noj-llm-gateway`。

## 前置条件

1. 使用域允许 LLM 题，操作者拥有该域资源编辑权限；题目包使用格式 2，不带 P/U
   分类。
2. 使用域已配置 **本域默认 LLM Provider 与模型**（两项须同时配置；域内「LLM →
   Provider 管理」）。未配置的域不能使用源域或默认域密钥。运营者接入步骤见
   [如何提供 LLM 调用能力（运营者）](../operators/llm-call-capability.md)；后台操作见
   [后台管理指南](../operators/admin-guide.md#llm-管理)。
3. 题目必须开启 **Evaluator
   联网**（`runtime_config.evaluator.network.enabled = true`）， 且部署环境已让
   evaluator 加入 `llm-gateway` 所在网络（生产默认 `noj-eval-net`，
   即评测隔离网络）。

::: info Solution 容器始终无网 Solution 容器**始终无网**，也不会拿到任何
`NOJ_LLM_*` 环境变量。LLM 能力只能由 evaluator 经 capability 精确封装后转给
solution。 :::

## 题目配置

在题目 JSON / 统一题目包 `problem.json`（manifest）中增加 `llm` 字段。题目只声明
**需要 LLM 能力**与**本次评测预算**；用哪个 Provider、哪个模型由使用域默认统一
决定，题目不再携带部署期的 Provider UUID 与模型名，因此题包可跨部署直接复用。

```json
{
  "llm": {
    "max_calls": 30,
    "max_tokens": 20000
  },
  "runtime_config": {
    "evaluator": {
      "network": { "enabled": true }
    }
  }
}
```

| 字段                                       | 必填 | 说明                                                      |
| ------------------------------------------ | :--: | --------------------------------------------------------- |
| `llm`                                      |  ❌  | 非 `null` 即启用；`{}` 亦合法，表示启用并沿用平台默认预算 |
| `llm.max_calls`                            |  ❌  | 单次评测 LLM 调用上限，正整数                             |
| `llm.max_tokens`                           |  ❌  | 单次评测 billed token 上限，正整数                        |
| `runtime_config.evaluator.network.enabled` |  ✅  | 启用 LLM 时**必须**为 `true`                              |

::: warning 预算不得超过平台天花板 `max_calls` / `max_tokens`
若提供必须为正整数，且不得超过平台默认上限 （`NOJ_LLM_MAX_CALLS`，默认
`100`；`NOJ_LLM_MAX_TOKENS`，默认 `50000`）， 超限会在写库前被拒绝。 :::

```text
旧题包/存量数据中的 provider_id / model 会被容忍并忽略（不报错），
每次新评测尝试使用目标域的当前默认配置，历史尝试保留冻结配置。
```

创建/更新题目时服务端会强制校验：未开网络或单次预算超过实例上限都会拒绝。

## 在 Evaluator 中调用

`noj_evaluator_sdk` 提供 `llm.complete` 高层封装：

```python
from noj_evaluator_sdk import llm, result

def evaluate(prompt: str) -> str:
    resp = llm.complete(
        # 不要指定 model：使用域默认模型即唯一允许值，省略后 SDK 自动取允许列表首个
        messages=[
            {"role": "system", "content": "你是数学解题助手。"},
            {"role": "user", "content": prompt},
        ],
        temperature=0,
    )
    return resp["choices"][0]["message"]["content"]

# 在 capability 中暴露给 solution，保持“精确封装”的安全边界
from noj_evaluator_sdk import register_capability
register_capability("solve_math", evaluate)
```

- 用哪个模型由**使用域默认**决定，是唯一权威来源：`eval_token` 只允许
  `NOJ_LLM_ALLOWED_MODELS` 中的模型（即使用域默认模型一项），传入其他模型会被
  gateway 以 403 `model_not_allowed` 拒绝。因此请**省略 `model=`**，由 SDK
  取允许列表首个（使用域默认）。
- `llm.complete(messages=..., **params)` 会读取评测时自动注入的
  `NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_ALLOWED_MODELS`（以及
  `NOJ_LLM_PROVIDER_ID`）等环境变量。
- 返回上游 OpenAI 兼容 Chat Completions 响应字典。
- 调用失败（配置缺失、token 失效、上游 4xx/5xx、网络错误）会抛出 `LLMError`。

::: tip 确定性随机可用 `NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ` Judge Worker
还会注入 `NOJ_SUBMISSION_ID` 与
`NOJ_REJUDGE_SEQ`，便于题目侧做**确定性随机**：同一提交重测结果一致，不同提交抽到不同剧本。
:::

## 安全与限额

- 真实上游 API Key **只存在于 gateway**，不会进入 evaluator
  容器、支持包、日志或提交代码。
- 每次评测使用短期
  `eval_token`，绑定使用域/评测尝试/提交/题目/用户/Provider，并在评测时限内过期（TTL
  由 `evaluator.time_limit_ms` 推算）。
- 系统按单次提交、实例/域/域内用户/域内题目日/月维度限制
  calls/tokens/cost；配额（`llm_quotas`）通过域内授权接口维护，域管理员只能降低现有域总额度；平台管理员可在实例上限内治理调整。
- 请像普通网络能力一样封装**精确业务函数**，不要把通用 HTTP 转发注册为
  capability
  （参考[受限网络能力](../mechanisms/capability-networking.md)的安全清单）。

## 验证方法

1. 在使用域「LLM → Provider 管理」确认本域默认 Provider /
   模型同时配置，并在创建/编辑题目时勾选 LLM 配置与 Evaluator 联网。
2. 本地或 E2E 环境提交一次，确认 evaluator 能通过 `llm.complete` 拿到结果。
3. 在「LLM 用量」页确认本次调用已落库（状态 `ok`），并检查
   token/费用是否符合预期。
4. 缺本域 Provider、伪造其他域 Provider 或未开 Evaluator 联网，应被服务端拒绝。
