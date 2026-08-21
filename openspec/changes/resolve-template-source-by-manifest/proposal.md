## Why

题目模板接口把展示题号当作题目源目录名。在管理员导入时自动分配题号或题目源目录与题号不同时，会读取到另一道题目的模板；A+B
Problem 因此展示了星港舱门题的启动代码。

## What Changes

- 模板读取以数据库题目的题号与标题匹配源码目录中的
  `problem.json`，而非直接拼接题号作为目录名。
- 源码目录无法唯一匹配时不返回可能属于其他题目的模板。
- 为非同名目录和同题号冲突目录补充回归测试。

## Capabilities

### New Capabilities

- `problem-template-source-resolution`:
  为题目模板接口安全定位与数据库题目一致的题目源码目录。

### Modified Capabilities

- `problem-bundle-import`: 模板接口在源码目录与题号不一致时的定位要求。

## Impact

- `noj-core/src/services/support-package.ts`
- `noj-core/src/routes/problems.ts`
- `noj-core/tests/services/problem-template.test.ts`
