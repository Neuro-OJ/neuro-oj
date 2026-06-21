## Why

用户主页是 OJ 系统的核心功能之一。目前 noj-core
缺少一个聚合用户统计信息（提交数、通过率、解题数）、已通过题目列表和最近提交活动的
API 端点，导致前端无法展示用户个人主页。

## What Changes

- 新增 `GET /api/v1/users/:id/profile` 端点，返回用户主页聚合数据
- 聚合数据包括：用户基本信息、统计信息（总提交数、通过数、通过率、解题数）、已通过题目列表、最近提交活动
- 统计信息通过 SQL 聚合查询实时计算（不引入冗余统计字段）
- 已通过题目列表去重，附带题目难度和通过时间
- 最近提交活动取最近 N 条提交记录（不含 code 字段）

## Capabilities

### New Capabilities

- `user-profile`: 用户主页 API，提供聚合统计、已通过题目列表和最近提交活动

### Modified Capabilities

（无现有 spec 变更）

## Impact

- **新增文件**：`noj-core/src/routes/users.ts` — 用户主页路由
- **修改文件**：`noj-core/src/app.ts` — 注册新路由
- **新增服务函数**：在 `services/auth.ts` 或新建 `services/users.ts`
  中实现聚合查询
- **新增类型**：`UserProfileResponse` 接口定义
- **测试**：新增单元测试和 E2E 测试
