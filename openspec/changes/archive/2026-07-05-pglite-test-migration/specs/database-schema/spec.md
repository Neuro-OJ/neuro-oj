## MODIFIED Requirements

### Requirement: PG 错误码兼容

系统 SHALL 在检查 PostgreSQL 约束冲突错误码（`23505`）时，同时兼容 postgres.js 错误对象结构（`err.code`）和 PGlite 错误对象结构（`err.cause.code`）。

`problems.ts` 中创建题目并发冲突重试逻辑的错误码检查 MUST 从：
```typescript
(err as { code: string }).code === "23505"
```
改为兼容两种结构：
```typescript
const pgCode = (err as Record<string,unknown>)?.code
  || (err as Record<string,unknown>)?.cause?.code;
if (pgCode === "23505") { ... }
```

#### Scenario: postgres.js 模式下捕获 UNIQUE 冲突

- **WHEN** `DATABASE_URL` 已设置，插入题目触发 `(type, number)` UNIQUE 约束冲突
- **THEN** `err.code === '23505'` 为 true，重试逻辑正常触发

#### Scenario: PGlite 模式下捕获 UNIQUE 冲突

- **WHEN** `DATABASE_URL` 未设置（PGlite 模式），插入题目触发 `(type, number)` UNIQUE 约束冲突
- **THEN** `err.cause.code === '23505'` 为 true，重试逻辑正常触发
