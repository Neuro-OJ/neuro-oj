## Why

对比分析（`comparison-hydrooj.md`）将"提交重测"列为 P1 核心缺失功能。当前管理后台仅提供提交查看与删除操作，当题目测试用例、评测脚本或环境配置更新后，管理员无法对已有提交重新评测，必须要求用户手动重新提交。实现此功能可让管理员一键重测，补全通用 OJ 平台的基础管理能力。

## What Changes

- 新增管理 API `POST /api/v1/admin/submissions/:id/rejudge`，触发提交重测流程
- 新增 `rejudgeSubmission()` 服务函数：重置提交状态、清除旧评测结果、重新推送评测任务到 MQ
- 管理后台提交页操作列新增"重测"按钮，含二次确认弹窗
- 重测过程对用户透明：提交记录保持原 ID 不变，新结果覆盖旧结果

## Capabilities

### New Capabilities

- `admin-submission-rejudge`: 管理员一键重测提交。支持对所有状态（finished/error/judging/pending）的提交发起重测，自动重置状态并推送评测任务，新评测结果覆盖原有数据（提交 ID 不变）。

### Modified Capabilities

- `admin-submission-management`: 在操作列新增"重测"能力，为管理员提交管理页面增加重测交互入口。

## Impact

- **API 变更**: 无破坏性变更。新增 `POST /api/v1/admin/submissions/:id/rejudge` 端点
- **数据库**: 重测过程中删除旧 `evaluation_results` 记录，复用原 `submissions` 记录
- **前端**: 管理后台提交页增加按钮和确认弹窗，无页面结构变更
- **评测队列**: 复用现有 MQ 机制，无需新增队列或消费者
