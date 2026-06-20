## Why

当前 noj-core 已有用户认证系统（Issue #12），但缺少题目查询和代码提交 API。Phase 0 需要：
- 题目 API：用户浏览题目
- 提交 API：用户提交代码并获取评测结果
- Redis MQ Producer：分发评测任务给 noj-judge

## What Changes

- 新增 `GET /api/v1/problems` — 题目列表（分页）
- 新增 `GET /api/v1/problems/:id` — 题目详情
- 新增 `POST /api/v1/submissions` — 创建提交
- 新增 `GET /api/v1/submissions/:id` — 提交详情（含评测结果）
- 新增 `NotFoundError`, `BadRequestError` 错误类
- 新增示例题 1001 T0-LMCC

## Capabilities

### New Capabilities

- `problem-api`: 题目查询、题目详情
- `submission-api`: 代码提交、提交状态查询
- `sample-problem`: T0-LMCC 示例题

### Modified Capabilities

- `user-auth`: 集成 JWT 认证到 submissions 路由

## Impact

- **新增文件**:
  - `src/routes/problems.ts`
  - `src/routes/submissions.ts`
  - `src/services/problems.ts`
  - `src/services/submissions.ts`
  - `data/problems-src/1001/`
  - `scripts/build-packages.ts`
  - `scripts/seed.ts`
- **修改文件**:
  - `src/app.ts` (注册路由)
  - `src/lib/errors.ts` (新增错误类)
  - `deno.json` (新增 setup / seed / build-packages 任务)
- **数据库**: problems 表已存在，无需新表
- **评测**: 通过 Redis MQ 分发任务到 noj-judge