## 摘要

这是基于 `architecture/remediation-p3-p8`（PR #690）的栈顶修复层，所有变更都追加在现有历史之上，没有改写 P3–P8 提交。

当前 head：`30a4ba388fba14f3f669229deb0c5d0a1291d0f2`。本层对应的 CI run 为
`40250118610`，E2E run 为 `40250118673`。

本层收敛整栈验收发现的生产合同问题：

- Domain 竞赛访问统一接受 public ID / UUID 后解析 canonical internal ID，授权、题目绑定、参与者和排名不再混用标识；
- Core 持久化平台错误自动重试，Judge 删除重复业务重试路径；
- Provider 错误码、邀请注册政策、客观题竞赛 admission 与测试清理合同收口；
- Gateway 迁移目录覆盖纳入配置声明，并修复覆盖率 job 中最小测试替身的类型错误；coverage 入口改用隔离 PG/Redis 测试启动器，避免集成测试在 CI 中缺失资源而失败；
- 空间首页首屏改为消费 Domain home BFF 聚合 envelope，覆盖 SSR、身份分支、浏览器水合、SPA 单请求和局部刷新；
- 编辑器主题浏览器 fixture 改用真实 Domain solve 入口，并覆盖 390px 窄屏侧栏交互；
- 浏览器提交 E2E 从 Domain 提交响应取得 submission ID，并在提交详情页轮询终态，避免旧 helper 和不稳定列表页等待；
- 题目删除路由显式注入 `RequestContext`，恢复 `problems.delete` 审计事实；
- 教学 outbox 重放同时登记 P4 `education.recompute` background task，使恢复测试走真实 Core worker 的租约/重启链路；
- 更新文件规模棘轮与验收 Agent Note。

## 验证

- `deno run -A scripts/check-all.ts`：通过（仓库门禁 251/0；Core/Gateway/UI quick check 通过）。
- Core 真实 PostgreSQL 串行全量：2528 passed / 0 failed / 11 ignored（19m42s）。
- Core 本地双分片并行真实 PostgreSQL/Redis：2246 passed / 0 failed / 2 ignored（20m31s；login throttle 环境隔离修复后复验）。
- GitHub CI Core Sharded（独立 PostgreSQL）：2246 passed / 0 failed / 2 ignored（18m10s；job 总时长 18m49s）。
- Core contests：128 passed / 0 failed；evaluations：485 passed / 0 failed。
- Gateway：184 passed / 0 failed / 1 ignored；Judge：297 passed / 0 failed；CLI：526 passed / 0 failed / 4 ignored。
- Gateway coverage 入口：184 passed / 0 failed / 1 ignored；All files 86.1% lines / 85.7% branches / 84.9% functions（本地隔离 PG/Redis，覆盖率模式保留类型检查）。
- UI：Deno 310 passed / 0 failed；组件 367 passed / 0 failed；BFF SSR 与 Redis cache 验收通过。
- UI 编辑器主题：Chromium 1440px、390px 均通过（2 passed / 0 failed），使用 Domain solve fixture。
- 浏览器 E2E 编译/启动器：`deno task test:browser` 为 11 passed / 0 failed / 13 ignored；当前环境未启用完整浏览器运行时，未把类型检查冒充真实浏览器矩阵。
- GitHub 真实 Browser E2E：24 passed / 0 failed（42 steps；job `121340291175`，6m54s）。
- GitHub CI `40250118610`：Root/Core/Gateway/UI/Judge/CLI/WASI 相关 job 全部通过；PR 条件下 Core Perf benchmark skipped。
- GitHub Security `40250118681` 与 Lint Workflows `40250118658`：通过。
- 本轮修复隔离 E2E：system 为 38 passed / 0 failed（含 `problems.delete` 审计）；cross-domain outbox recovery 精确回归为 1 passed / 0 failed / 55 filtered，真实 Core 停机后重启并恢复积压。

## 验收边界

- 未合并、未发布 Release、未切换生产；请先等待 CI 和人工 review。
- 本机 GPG pinentry 不可用；用户明确接受本层新增提交不签名，既有签名提交不变。
- 真实 Provider 请求、完整 rootless Judge 恢复演练、性能门禁、生产 release artifact 与数据库切换仍需外部环境补证；WASI SDK/image 与四种 WASI Acceptance 已在 CI 通过。
- Cloudflare Pages 外部检查失败，`license/cla` pending；这是合并/发布前的外部阻塞，不是本轮 CI/E2E 代码测试失败。
- 本轮本地 E2E 使用唯一 `noj-e2e-local` 容器/端口/卷并已清理；其它验收栈未触碰。

详细证据与明早 review 顺序：`dev-docs/acceptance/2026-10-25-final-repair/README.md`。
