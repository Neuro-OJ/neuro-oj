# Agent Note: 当前产品契约的真实浏览器门禁与隔离测试栈

Status: implemented

## Problem

旧浏览器门禁使用只含 P 题号的草稿键，域升级后无法恢复代码。E2E Gateway
的默认发布端口与开发 Gateway
重叠，可能把测试调用送入开发配置。已有测试库还包含旧分类数据，不能通过清库掩盖升级问题。

## Decision

浏览器门禁读取已验证测试账号及 main 题目版本，复用客户端 `domainAnswerKey`
预置完整草稿键，实际点击提交、进入提交详情并等待 Judge
结果。满分按数值验证，兼容界面保留小数位；错误答案同样检查数值，避免将 `10.0 分`
当成非满分。

E2E Compose 的迁移、core、Gateway 通过 `E2E_DATABASE_NAME`
使用同一选定数据库；默认仍为 e2e。Gateway 默认发布到 8003，core 发给 evaluator
的地址使用相同端口。开发 Gateway 8001 与原测试库保留。Deno 生产构建按 Deno
runtime 启动，文档和实际启动保持一致。

浏览器截图和 trace 保留在本地
`noj-tests/test-results`，新增忽略规则，不提交测试账号、源码和请求诊断产物。

## Alternatives considered

- 继续使用旧草稿键：无法验证新域编辑器的恢复与提交路径。
- 放宽满分为非空或正数：无法发现评测降分。
- 删除原测试库：不能检验迁移前置约束，也会丢失可追查的开发记录。

## Consequences

当前工作树构建的 core、Gateway、Judge 与 SDK 镜像连接独立新库
`noj_upgrade_e2e_20261013`；原 e2e 与开发库保持。最新 UI 生产构建使用 Deno 在
3000 启动，标准 `deno task test:browser` 14 项通过、0
失败，覆盖注册、登录/退出、正确和错误代码的真实评测、搜索、管理视图、通知和旧入口
404。

identity 标准 HTTP E2E 34 项通过、0 失败、5 项忽略。Judge Docker E2E 45
项全部通过，实际运行容器资源、网络、挂载隔离及 AI/OI Native
执行。上述证据不替代学校教学与 Mixed OJ 的完整浏览器验收，这些场景另行补齐。
