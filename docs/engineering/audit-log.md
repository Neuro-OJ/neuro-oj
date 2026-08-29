# NOJ 可重放审计日志

## 目标

LLM 网关和评测链路应能记录“模型可见内容”，使审计、复现和快照测试可以从日志重建，而不依赖“当时发生了什么”的口头描述。

## 当前状态

- `noj-llm-gateway/src/usage.ts` 的 `recordUsage` 记录用量（token、调用次数、模型等）。
- 评测结果在 PostgreSQL 持久化。
- 尚未保存完整请求/响应 transcript。

## 目标设计

对 LLM 网关的每次模型调用，记录：

```json
{
  "request_id": "uuid",
  "submission_id": "uuid",
  "provider_id": "uuid",
  "model": "deepseek-chat",
  "request": { "messages": [...], "max_tokens": ... },
  "response": { "choices": [...], "usage": {...} },
  "created_at": "ISO8601"
}
```

- 写入 PostgreSQL（或未来 `sse_events` 同库）。
- 响应体过大时截断或只存摘要，避免存储爆炸。
- 支持按 `submission_id` 重放。

## 规则

1. 任何模型可见输入/输出必须可重建。
2. 密钥、eval_token 等敏感字段不得写入日志明文。
3. 审计日志保留策略与 `auditLogs` 对齐（默认 90 天，可配置）。
