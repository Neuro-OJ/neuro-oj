# 2026-10-25 整栈最终修复验收

状态：修复栈顶候选已通过本轮 CI 与真实 Browser E2E；仍为 draft PR，等待人工 review、外部检查处理与发布决策；未合并、未发布、未切换生产。

## 1. 验收范围

本轮变更全部追加在 P3–P8 stack 顶端，没有编辑历史。当前 PR #691 的 base 是
`architecture/remediation-p3-p8`（PR #690，头 `7871d31a`），本轮修复头为
`30a4ba388fba14f3f669229deb0c5d0a1291d0f2`；这里不把 stack 头误称为最新
`main`。本轮重点是把上一轮验收发现的阻塞收敛成可 review 的修复提交：

- Domain 资源同时接受公开 ID 与内部 UUID 时，先解析并使用 canonical internal ID，避免跨域授权、比赛 admission 和排名查询混用标识；
- Core 的平台错误自动重试持久化到 background task，Judge 不再重复承担业务重试；
- Provider 错误码、邀请政策、资源清理和版本化评测夹具保持同一合同；
- Gateway 迁移目录覆盖纳入配置声明，覆盖率阶段的最小 Redis/HTTP 测试替身补齐类型，并让 coverage 经过同一套隔离 PG/Redis 测试启动器；
- 并行验收中的登录限流测试不再修改进程级 `NOJ_ENV`，改用显式 `RATE_LIMIT_ENABLED` 覆盖，避免测试隔离竞态；
- 空间首页 SSR 首屏使用 Domain home BFF 聚合 envelope，避免组件级 Core 直读和身份相关的 SSR 500；
- BFF SSR 夹具补齐 `problem-summaries` 合同，覆盖身份、水合、SPA 单请求和局部刷新。
- 编辑器主题浏览器 fixture 改为真实 `/d/main/solve/:reference` Domain 作答入口；390px
  场景通过“切换侧栏”交互打开默认收起的题面后再验收 Markdown 排版。
- 浏览器提交 E2E 改为从 Domain 提交响应取得 submission ID，再轮询提交详情页的终态；避免
  依赖不存在的旧 helper 或在列表页等待不稳定文本。
- 题目删除路由显式进入 `RequestContext`，让旧审计适配层可以记录认证 actor、目标题目和
  客户端元数据。
- 教学 outbox 重放夹具同步登记 P4 `education.recompute` background task，恢复验收继续走
  真实 Core worker、租约和重启恢复链路。

## 2. Domain 重点结论

Domain 资源边界不再把 URL 中的 `public_id` 当作数据库主键直接下传。`contest-access` 与 contest policy 都在授权前解析 canonical contest row，随后以内部 ID 查询题目绑定和参与者记录；竞赛域回归为 128/0。客观题交卷、公共/私有域隔离和外域 Provider 404 的合同均保留了负向断言，未把“能返回 200”当作授权证据。

首页部分也以域 slug 建立 BFF 边界：聚合请求包含查看者身份，组件只消费初始 section，后续事件/重试才做局部读取。一次真实 SSR 复验发现学生关注流实际为 `{ data: [...] }` 而不是数组；该错误已修复并由学生、教练、助教和游客矩阵覆盖。

## 3. 自动化证据

| 层级 | 结果 | 说明 |
| --- | ---: | --- |
| Core 全量真实 PostgreSQL（本轮最终串行） | 2528 passed / 0 failed / 11 ignored | 真实 PostgreSQL、Redis、storage 隔离 run；19m42s |
| Core 本地双分片并行真实 PostgreSQL/Redis | 2246 passed / 0 failed / 2 ignored | 修复 login throttle 环境隔离后复验；20m31s |
| Core evaluations 域 | 485 passed / 0 failed | 含自动重试、版本化评测与终态撤销夹具 |
| Core contests 域 | 128 passed / 0 failed | 含公开 ID/内部 ID canonicalization、ranking、admission |
| Core access 精确回归 | 1 passed / 0 failed / 402 filtered | login throttle 失败累加；另有单文件 6/6 隔离回归 |
| Core 静态门禁 | passed | fmt、lint、types、contracts |
| LLM Gateway | 184 passed / 0 failed / 1 ignored | Provider 状态与跨域 400/404 合同；coverage 入口本地隔离 PG/Redis 86.1% lines / 85.7% branches / 84.9% functions |
| Judge | 297 passed / 0 failed | `cargo fmt --check`、`cargo check --all-targets` 通过；Docker E2E 按环境跳过 |
| CLI | 526 passed / 0 failed / 4 ignored | check、普通测试、production 测试 |
| UI Deno 测试 | 310 passed / 0 failed | 生产构建前后的非组件测试 |
| UI 组件套件 | 367 passed / 0 failed | 96 个测试文件 |
| UI 类型/格式/静态检查 | passed | fmt、lint、Deno/Nuxt typecheck |
| UI BFF SSR | passed | 四种身份；真实构建、SSR、浏览器水合、SPA 单请求、局部刷新 |
| UI BFF Redis cache | passed | 两个生产构建副本共享 Redis 命中；TTL 30 秒；Redis 不可用时 200 + bypass 降级 |
| UI 编辑器主题浏览器 | 2 passed / 0 failed | 本地生产构建后 Chromium 1440px、390px；Domain solve fixture 与窄屏侧栏交互 |
| 浏览器 E2E 编译/启动器 | 11 passed / 0 failed / 13 ignored | `deno task test:browser`；当前环境未启用完整浏览器运行时，11 项为类型/入口检查 |
| 真实 Browser E2E（CI run `40250118673`，job `121340291175`） | 24 passed / 0 failed（42 steps） | 隔离栈真实 Chromium；Browser job 6m54s |
| system E2E（本轮修复隔离栈） | 38 passed / 0 failed | 当前工作树、真实 PostgreSQL/Redis、Core HTTP；含 `problems.delete` 审计 |
| cross-domain outbox recovery（本轮精确回归） | 1 passed / 0 failed / 55 filtered | 真实 Core 停机后重启并恢复两个积压事件；Judge/Gateway 保持原进程 |
| GitHub CI `40250118610` | success | Root、Core 全部已触发 Domain（含 objective、workspace、isolated sharded）、Gateway、UI、Judge、CLI、WASI SDK/Image 与四种 WASI Acceptance 均通过；Core Perf 按 PR 条件 skipped |
| GitHub Security `40250118681` / Lint Workflows `40250118658` | success | 依赖审计、CodeQL、actionlint 与工作流门禁通过 |

并行 Core 的第一次旧候选曾有 2240 passed / 6 failed / 2 ignored；本轮修复 contest fixture 的稳定清理方式、login throttle 的环境隔离，以及额度桶 fixture 的稳定题号。修复后的 CI 分片 `Core Sharded (isolated PostgreSQL)` 得到 2246 passed / 0 failed / 2 ignored（18m10s），对应 job 总时长 18m49s。栈顶修复还在带唯一容器/端口/卷的隔离栈中复跑了 system 与 outbox recovery；这证明当前修复可在真实服务链路复现通过，但生产签核仍须等待人工 review 及下方外部证据。

## 4. 尚未被本地证据覆盖的项目

- 当前环境没有可用的完整真实浏览器矩阵运行时；本地 BFF 脚本与 `deno task test:browser` 不能替代真实浏览器证据，但 CI Browser job 已完成 24/0（42 steps）。
- 没有 Provider 凭据，因此没有发起真实 LLM 请求，未产生费用；Gateway 的合同测试使用受控 provider fixture。
- CI 已通过固定来源 WASI SDK、WASI runtime image 以及 standard/compat/analysis/wasi 四种 WASI Acceptance；发布前仍需确认生产 release artifact 与配置指向同一固定来源。
- rootless Docker/slirp 限制了完整 Judge 升级/备份恢复演练；普通 Judge 测试与双容器评测链路已验证。
- 性能门禁、生产备份恢复、真实发布窗口和数据库切换尚未执行。
- Cloudflare Pages 外部检查失败，`license/cla` 仍 pending；二者不是本轮代码测试失败，但在合并/发布前必须由仓库维护者处理。

## 5. 版本与安全边界

- 所有修复以新提交追加，未编辑 P3–P8 历史；未推送 `main`，未合并 PR，未发布 Release，未操作生产服务。
- PR #691：`https://github.com/Neuro-OJ/neuro-oj/pull/691`；CI run `40250118610`、E2E run `40250118673` 均对应上述修复头。
- 本机 GPG pinentry 不可用；用户明确接受本轮新增修复提交不签名。既有签名提交保持不变，PR/验收记录会显式标注此例外。
- 测试资源使用本 run 所有的隔离 PostgreSQL、Redis 和 storage；`noj-e2e-local` 资源已全部清理，
  其它验收栈（包括 `noj-e2e-pr622-validation`）未触碰。

## 6. 明早 review 顺序

1. 先看 `contest-access`、`contest-policy`、BFF home envelope 和 SSR 夹具，确认 public/private/mixed 三类域的 canonical ID 与 viewer 绑定没有绕过授权。
2. 再看 background task retry、Provider 错误映射和 fixture cleanup，确认业务重试只有一个权威实现。
3. 复核 PR #691 的 CI/E2E 证据与外部 Cloudflare/CLA 状态；补真实 LLM、生产 release artifact、完整恢复演练和性能证据后，再决定是否具备生产切换条件。
