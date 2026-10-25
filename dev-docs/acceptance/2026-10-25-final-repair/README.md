# 2026-10-25 整栈最终修复验收

状态：修复栈顶候选，等待 CI 与人工 review；未合并、未发布、未切换生产。

## 1. 验收范围

本轮变更全部追加在 P3–P8 stack 顶端，基线为最新 `main`（`2f488599`），既有 stack 头为 `7871d31a`。本轮重点是把上一轮验收发现的阻塞收敛成可 review 的修复提交：

- Domain 资源同时接受公开 ID 与内部 UUID 时，先解析并使用 canonical internal ID，避免跨域授权、比赛 admission 和排名查询混用标识；
- Core 的平台错误自动重试持久化到 background task，Judge 不再重复承担业务重试；
- Provider 错误码、邀请政策、资源清理和版本化评测夹具保持同一合同；
- 并行验收中的登录限流测试不再修改进程级 `NOJ_ENV`，改用显式 `RATE_LIMIT_ENABLED` 覆盖，避免测试隔离竞态；
- 空间首页 SSR 首屏使用 Domain home BFF 聚合 envelope，避免组件级 Core 直读和身份相关的 SSR 500；
- BFF SSR 夹具补齐 `problem-summaries` 合同，覆盖身份、水合、SPA 单请求和局部刷新。

## 2. Domain 重点结论

Domain 资源边界不再把 URL 中的 `public_id` 当作数据库主键直接下传。`contest-access` 与 contest policy 都在授权前解析 canonical contest row，随后以内部 ID 查询题目绑定和参与者记录；竞赛域回归为 128/0。客观题交卷、公共/私有域隔离和外域 Provider 404 的合同均保留了负向断言，未把“能返回 200”当作授权证据。

首页部分也以域 slug 建立 BFF 边界：聚合请求包含查看者身份，组件只消费初始 section，后续事件/重试才做局部读取。一次真实 SSR 复验发现学生关注流实际为 `{ data: [...] }` 而不是数组；该错误已修复并由学生、教练、助教和游客矩阵覆盖。

## 3. 自动化证据

| 层级 | 结果 | 说明 |
| --- | ---: | --- |
| Core 全量真实 PostgreSQL（本轮最终串行） | 2528 passed / 0 failed / 11 ignored | 真实 PostgreSQL、Redis、storage 隔离 run；19m42s |
| Core 双分片并行真实 PostgreSQL/Redis | 2246 passed / 0 failed / 2 ignored | 修复 login throttle 环境隔离后复验；20m31s |
| Core evaluations 域 | 485 passed / 0 failed | 含自动重试、版本化评测与终态撤销夹具 |
| Core contests 域 | 128 passed / 0 failed | 含公开 ID/内部 ID canonicalization、ranking、admission |
| Core access 精确回归 | 1 passed / 0 failed / 402 filtered | login throttle 失败累加；另有单文件 6/6 隔离回归 |
| Core 静态门禁 | passed | fmt、lint、types、contracts |
| LLM Gateway | 184 passed / 0 failed / 1 ignored | Provider 状态与跨域 400/404 合同 |
| Judge | 297 passed / 0 failed | `cargo fmt --check`、`cargo check --all-targets` 通过；Docker E2E 按环境跳过 |
| CLI | 526 passed / 0 failed / 4 ignored | check、普通测试、production 测试 |
| UI Deno 测试 | 310 passed / 0 failed | 生产构建前后的非组件测试 |
| UI 组件套件 | 367 passed / 0 failed | 96 个测试文件 |
| UI 类型/格式/静态检查 | passed | fmt、lint、Deno/Nuxt typecheck |
| UI BFF SSR | passed | 四种身份；真实构建、SSR、浏览器水合、SPA 单请求、局部刷新 |
| UI BFF Redis cache | passed | 两个生产构建副本共享 Redis 命中；TTL 30 秒；Redis 不可用时 200 + bypass 降级 |

并行 Core 的第一次旧候选曾有 2240 passed / 6 failed / 2 ignored；本轮修复 contest fixture 的稳定清理方式，并让 login throttle 测试只使用显式 `RATE_LIMIT_ENABLED`，不再删除/恢复共享的 `NOJ_ENV`。修复后的新双分片 run 已得到 2246 passed / 0 failed / 2 ignored（20m31s）。这证明当前验收栈在本地并行 runner 下无已知失败，但生产签核仍须等待 CI、人工 review 及下方外部证据。

## 4. 尚未被本地证据覆盖的项目

- 当前环境没有可用的完整真实浏览器矩阵运行时；BFF 脚本使用本地构建和可执行的 headless 浏览器路径，不能替代 CI/人工浏览器验收。
- 没有 Provider 凭据，因此没有发起真实 LLM 请求，未产生费用；Gateway 的合同测试使用受控 provider fixture。
- OI WASM 仍缺少匹配的 WASI SDK/镜像，不能宣称 native 与 WASM 双后端均已验收。
- rootless Docker/slirp 限制了完整 Judge 升级/备份恢复演练；普通 Judge 测试与双容器评测链路已验证。
- 性能门禁、生产备份恢复、真实发布窗口和数据库切换尚未执行。

## 5. 版本与安全边界

- 所有修复以新提交追加，未编辑 P3–P8 历史；未推送 `main`，未合并 PR，未发布 Release，未操作生产服务。
- 本机 GPG pinentry 不可用；用户明确接受本轮新增修复提交不签名。既有签名提交保持不变，PR/验收记录会显式标注此例外。
- 测试资源使用本 run 所有的隔离 PostgreSQL、Redis 和 storage；清理只针对带有本 run 标识的资源。

## 6. 明早 review 顺序

1. 先看 `contest-access`、`contest-policy`、BFF home envelope 和 SSR 夹具，确认 public/private/mixed 三类域的 canonical ID 与 viewer 绑定没有绕过授权。
2. 再看 background task retry、Provider 错误映射和 fixture cleanup，确认业务重试只有一个权威实现。
3. 检查 CI 在最新 `main` 基线上的完整结果；补真实浏览器、LLM、OI WASM 和恢复演练证据后，再决定是否具备生产切换条件。
