## Why

第一轮测试补强（P0-P2）已修复关键测试问题和新增 14 个测试，但仍有 P3-P4 盲区未覆盖：SSE 推送、私信、审计日志、支持包 S3 上传、重测等关键路径缺少全链路验证，CI 缺少快速冒烟子集。

## What Changes

- **SSE 推送 E2E 测试** — 验证 SSE 端点推送事件正确性
- **私信 E2E 测试** — 覆盖全链路收发消息流程
- **审计日志 E2E 测试** — 验证管理员操作被正确记录
- **支持包 S3 上传 E2E 测试** — 覆盖 S3 模式下支持包上传与下载
- **重测（rejudge）E2E 测试** — 覆盖提交重测流程
- **CI 冒烟测试子集** — 在 CI 中添加快速冒烟子集，避免每次 PR 需跑完整 E2E 栈

## Capabilities

### New Capabilities
- `sse-testing`: SSE 推送端点的事件传递正确性验证
- `messaging-e2e`: 站内私信全链路 E2E 测试
- `audit-log-e2e`: 审计日志记录与查询 E2E 测试
- `support-package-upload-e2e`: 支持包 S3 存储模式上传/下载 E2E 测试
- `rejudge-testing`: 提交重测流程 E2E 测试
- `ci-smoke-tests`: CI 中快速冒烟测试子集

### Modified Capabilities

无（现有 spec-level 行为不改变，仅新增测试覆盖）

## Impact

- `noj-core`: 新增 routes/services 测试文件，扩展 mock 工具
- `noj-tests/e2e/`: 新增 3-6 个 E2E 测试文件
- `noj-core/tests/`: 新增支持包上传测试
- `.github/workflows/`: 新增/修改 CI 工作流，增加冒烟测试 job
- CI 成本：冒烟测试约 2-3min，全量 E2E 按需触发
