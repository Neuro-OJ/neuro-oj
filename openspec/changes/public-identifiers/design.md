## Context

完整设计见 `docs/superpowers/specs/2026-08-25-public-identifiers-design.md`。

## Decisions

1. **存储载体**：业务表新增 `public_id` 唯一列，而非统一映射表。
2. **生成规则**：创建时生成 `前缀 + 8 位随机字符`，字符集 `123456789abcdefghjkmnpqrstuvwxyz`，不可变。
3. **用户标识**：使用 `username`。
4. **题目标识**：沿用 `display_id = type + number`。
5. **兼容**：后端 API 双解析，前端只生成公开标识。
6. **范围**：前端含 admin 全面切换。

## 标识规则

| 实体 | 公开标识 | 前缀/来源 |
|------|---------|-----------|
| 用户 | `username` | 已有 |
| 题目 | `display_id` | 已有 |
| 竞赛 | `public_id` | `ct-` |
| 训练 | `public_id` | `tr-` |
| 提交 | `public_id` | `sub-` |
| 社区帖子 | `public_id` | `post-` |
| 公告 | `public_id` | `ann-` |
