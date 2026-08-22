## Why

API E2E 的重测断言读取了响应根字段，但服务实际将结果放在 `data` 中。内存压力测试在 Docker OOM 检测不可用时会产生 `SystemError`，目前辅助轮询函数会提前抛错，无法表达测试允许的跨平台结果。

## What Changes

- 按实际 `data.submission_id` 契约读取重测响应。
- 允许资源限制测试取得 `error` 终态并断言可接受的结果集合。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无。仅修复 E2E 夹具断言。

## Impact

- `noj-tests/e2e/helper.ts`
- `noj-tests/e2e/06_pipeline.test.ts`
- `noj-tests/e2e/14_rejudge.test.ts`
