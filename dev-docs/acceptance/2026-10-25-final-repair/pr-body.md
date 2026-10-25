## 摘要

这是基于 `architecture/remediation-p3-p8`（PR #690）的栈顶修复层，所有变更都追加在现有历史之上，没有改写 P3–P8 提交。

本层收敛整栈验收发现的生产合同问题：

- Domain 竞赛访问统一接受 public ID / UUID 后解析 canonical internal ID，授权、题目绑定、参与者和排名不再混用标识；
- Core 持久化平台错误自动重试，Judge 删除重复业务重试路径；
- Provider 错误码、邀请注册政策、客观题竞赛 admission 与测试清理合同收口；
- Gateway 迁移目录覆盖纳入配置声明，并修复覆盖率 job 中最小测试替身的类型错误；coverage 入口改用隔离 PG/Redis 测试启动器，避免集成测试在 CI 中缺失资源而失败；
- 空间首页首屏改为消费 Domain home BFF 聚合 envelope，覆盖 SSR、身份分支、浏览器水合、SPA 单请求和局部刷新；
- 更新文件规模棘轮与验收 Agent Note。

## 验证

- `deno run -A scripts/check-all.ts`：通过（仓库门禁 251/0；Core/Gateway/UI quick check 通过）。
- Core 真实 PostgreSQL 串行全量：2528 passed / 0 failed / 11 ignored（19m42s）。
- Core 双分片并行真实 PostgreSQL/Redis：2246 passed / 0 failed / 2 ignored（20m31s；login throttle 环境隔离修复后复验）。
- Core contests：128 passed / 0 failed；evaluations：485 passed / 0 failed。
- Gateway：184 passed / 0 failed / 1 ignored；Judge：297 passed / 0 failed；CLI：526 passed / 0 failed / 4 ignored。
- Gateway coverage 入口：184 passed / 0 failed / 1 ignored；All files 86.1% lines / 85.7% branches / 84.9% functions（本地隔离 PG/Redis，覆盖率模式保留类型检查）。
- UI：Deno 310 passed / 0 failed；组件 367 passed / 0 failed；BFF SSR 与 Redis cache 验收通过。

## 验收边界

- 未合并、未发布 Release、未切换生产；请先等待 CI 和人工 review。
- 本机 GPG pinentry 不可用；用户明确接受本层新增提交不签名，既有签名提交不变。
- 真实 Provider 请求、OI WASM 工具链、完整 rootless Judge 恢复演练、性能门禁和完整真实浏览器矩阵仍需外部环境补证。

详细证据与明早 review 顺序：`dev-docs/acceptance/2026-10-25-final-repair/README.md`。
