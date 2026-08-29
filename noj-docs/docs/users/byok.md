# 使用自带模型（BYOK）

登录后可以在「设置 → 自带模型」中保存自己的 OpenAI-compatible Provider，并在普通编程题提交时选择它。BYOK 适合希望使用个人 API 配额或指定模型的做题人。

## 配置模型

填写配置名称、模型名、API Key 和服务地址。服务地址必须是 HTTPS 且位于部署者配置的 allowlist 中；默认支持 `api.openai.com`。保存后页面只显示脱敏 Key，无法再次查看完整 Key。

你可以对配置执行：

- 测试连接：发送最小请求，确认凭据和模型可用。
- 轮换 Key：更新凭据，后续请求使用新 Key。
- 删除：立即阻止新的模型调用。

## 提交时选择

在普通编程题编辑器中，从「用户模型」下拉框选择配置；不选择时保持题目/平台原有模型能力。竞赛提交不使用 BYOK 选择，避免改变竞赛既有评测规则。

题目代码不会获得你的 API Key。系统只在服务端 Gateway 请求 Provider 时短暂使用密钥；JudgeTask、Redis、浏览器状态、Solution 和 Evaluator 都不会收到完整 Key。模型返回内容仍可能成为题目评测输入，请不要在 prompt 中放入不应提交给题目代码的隐私信息。

## 常见错误

| 错误 | 含义 |
| --- | --- |
| `provider_target_rejected` | 服务地址不符合 HTTPS 或 host allowlist 规则 |
| `BYOK_CONFIG_UNAVAILABLE` | 配置不存在、被删除、停用或未绑定到本次提交 |
| `BYOK_QUOTA_EXCEEDED` | 本次评测调用额度已用尽 |
| `BYOK_GATEWAY_UNAVAILABLE` | 用户模型网关暂时不可用 |

API Key 轮换或删除后，排队中的新调用会按最新配置重新校验；已经发出的单次 Provider 请求不会被强制撤销。
