# Tasks

## Issue #5: 题目与提交 API

### 交付

- [x] `GET /api/v1/problems` — 题目列表（分页）
- [x] `GET /api/v1/problems/:id` — 题目详情
- [x] `POST /api/v1/submissions` — 创建提交
- [x] `GET /api/v1/submissions/:id` — 查询提交状态
- [x] 示例题 1001 T0-LMCC

### 实现任务

#### 1. 题目服务

- [x] 创建 `src/services/problems.ts`
- [x] 实现 `listProblems(page, limit)` 分页查询
- [x] 实现 `getProblem(id)` 按 ID 查询
- [x] 实现 `initSampleProblems()` 初始化示例题

#### 2. 题目路由

- [x] 创建 `src/routes/problems.ts`
- [x] 实现 GET /problems 列表
- [x] 实现 GET /problems/:id 详情

#### 3. 提交服务

- [x] 创建 `src/services/submissions.ts`
- [x] 实现 `createSubmission(userId, input)` 创建提交
- [x] 实现 `getSubmission(id, userId)` 查询提交
- [x] 集成 Redis MQ pushJudgeTask

#### 4. 提交路由

- [x] 创建 `src/routes/submissions.ts`
- [x] 实现 JWT 认证中间件
- [x] 实现 POST /submissions 创建
- [x] 实现 GET /submissions/:id 查询

#### 5. 示例题

- [x] 创建 `data/problems/1001/`
- [x] 添加 README.md 题目描述
- [x] 添加 evaluate.py 评测脚本
- [x] 添加 visible.jsonl 可见数据
- [x] 添加 hidden.jsonl 隐藏数据

#### 6. 错误处理

- [x] 添加 NotFoundError
- [x] 添加 BadRequestError

### 验证

- [x] deno fmt 代码格式
- [x] deno lint 代码检查
- [x] deno check 类型检查
- [x] 手动测试 API