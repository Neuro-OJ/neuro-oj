# 出 LLM 调用题

本页面向出题人：当题目需要让 evaluator 调用真实 LLM API（例如 LMCC 第二轮常见的
“考生提供 Prompt / 生成参数，评测器调用 LLM 评分”）时，如何安全地接入
`noj-llm-gateway`。

## 前置条件

- 题目必须是 **P 型（主题题）** 或审核通过的官方题；U 型普通用户题默认禁止启用 LLM。
- 平台已配置 **全局默认 LLM Provider 与模型**（`llm_default_provider_id` /
  `llm_default_model`，后台「系统设置 → LLM」；运营者接入步骤见
  [如何提供 LLM 调用能力（运营者）](../operators/llm-call-capability.md)；后台操作见
  [后台管理指南](../operators/admin-guide.md)）。
- 题目必须开启 **Evaluator 联网**（`runtime_config.evaluator.network.enabled = true`），
  且部署环境已让 evaluator 加入 `llm-gateway` 所在网络（生产为 `noj-net`）。
- Solution 容器**始终无网**，也不会拿到任何 `NOJ_LLM_*` 环境变量。

## 题目配置

在题目 JSON / 统一题目包 `problem.json`（manifest）中增加 `llm` 字段。题目只声明
**需要 LLM 能力**与**本次评测预算**；用哪个 Provider、哪个模型由平台全局默认统一
决定，题目不再携带部署期的 Provider UUID 与模型名，因此题包可跨部署直接复用。

```json
{
  "type": "P",
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

- `llm` 非 `null` 即启用，可只含预算字段（`{}` 亦合法，表示启用并沿用平台默认预算）。
- `max_calls` / `max_tokens` 均可选，若提供必须为正整数；超出平台天花板会被拒绝。
- 旧题包/存量数据中的 `provider_id` / `model` 会被**容忍并忽略**（不报错），
  存量题目自动跟随平台默认。
- 创建/更新题目时服务端会强制校验：非 P 型/审核题、未开网络都会拒绝。

## 在 Evaluator 中调用

`noj_evaluator_sdk` 提供 `llm.complete` 高层封装：

```python
from noj_evaluator_sdk import llm, result

def evaluate(prompt: str) -> str:
    resp = llm.complete(
        # 不要指定 model：平台默认模型即唯一允许值，省略后 SDK 自动取允许列表首个
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

- 用哪个模型由**平台默认**决定，是唯一权威来源：`eval_token` 只允许 `NOJ_LLM_ALLOWED_MODELS`
  中的模型（即平台默认模型一项），传入其他模型会被 gateway 以 403
  `model_not_allowed` 拒绝。因此请**省略 `model=`**，由 SDK 取允许列表首个（平台默认）。
- `llm.complete(messages=..., **params)` 会读取评测时自动注入的
  `NOJ_LLM_GATEWAY_URL`、`NOJ_LLM_TOKEN`、`NOJ_LLM_ALLOWED_MODELS` 等环境变量。
- 返回上游 OpenAI 兼容 Chat Completions 响应字典。
- 调用失败（配置缺失、token 失效、上游 4xx/5xx、网络错误）会抛出 `LLMError`。

## 安全与限额

- 真实上游 API Key **只存在于 gateway**，不会进入 evaluator 容器、支持包、日志或提交代码。
- 每次评测使用短期 `eval_token`，绑定提交/题目/用户/Provider，并在评测时限内过期。
- 系统按单次提交、用户/全局/题目日/月维度限制 calls/tokens/cost；管理后台可配置配额。
- 请像普通网络能力一样封装**精确业务函数**，不要把通用 HTTP 转发注册为 capability
  （参考 [受限网络能力](capability-networking.md) 的安全清单）。

## 验证方法

1. 在管理后台「系统设置 → LLM」确认平台默认 Provider / 模型已配置，并创建/编辑
   P 型题目勾选 LLM 配置与 Evaluator 联网。
2. 本地或 E2E 环境提交一次，确认 evaluator 能通过 `llm.complete` 拿到结果。
3. 在「LLM 用量」页确认本次调用已落库（状态 `ok`），并检查 token/费用是否符合预期。
4. 恶意用例：非 P 型/未开网络创建题目应被服务端拒绝。
