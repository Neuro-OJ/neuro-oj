# byok — 用户自带模型

登录用户保存自己的 OpenAI 兼容 Base URL、模型与 API Key，在**练习**中提交 LLM
题时可选择用自己的 Key 评测。Key 由 `noj-llm-gateway` 的 `llm_user_providers`
表加密保存，core 只转发、不落库。

| 文件                   | 职责                                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `index.ts`             | 唯一对外出口：`feature` 声明与类型                                     |
| `routes.ts`            | `GET/PUT/DELETE /api/v1/me/llm-provider`、`POST /me/llm-provider/test` |
| `service.ts`           | 字段白名单解析、gateway 错误码映射、测试限流（账号 10 次 / 10 分钟）   |
| `tests/routes.test.ts` | 路由测试（假 gateway）；`deno task test:domain byok`                   |

关键约束：

- 提交时 `use_own_llm_key: true` 才使用自带模型；比赛与作业返回
  `400 BYOK_NOT_ALLOWED`（`submission-create.ts`）。
- eval_token 的 `provider_id` 为 `byok:<user_id>`；gateway 校验其与 token 内
  `user_id` 一致，只计单次评测预算，不占域/用户/题目共享额度。
- 实例开关由 gateway 的 `NOJ_LLM_BYOK_ALLOWED_HOSTS` 决定（精确主机、https、
  公网 DNS）；为空时 BYOK 关闭，`GET` 返回 `enabled: false`。
- 一次评测尝试冻结时记录 `byok:` Provider，重新派发仍用自带模型；用户删除或
  停用后重新派发返回 `BYOK_NOT_CONFIGURED` / `BYOK_DISABLED`。
