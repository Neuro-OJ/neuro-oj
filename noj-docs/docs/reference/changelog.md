# 更新日志

按时间倒序记录近期值得关注的变更。完整历史见 GitHub 仓库提交记录。

## 预发布版本

- **评测运行时收敛**：OI 题目统一由本地受限 Docker 沙箱（`noj-oi-cpp`）执行，Worker 并发控制收敛为本地 `JUDGE_MAX_CONCURRENT_JUDGES`；移除 WASI/Wasmtime、`go-judge` 远端沙箱、Redis 资源组容量锁及 `noj-cli judge reset-config`。

- 出题人与选手体验：竞赛风控新增「相似提交」复核界面（可调阈值、按题筛选、跳转含代码的提交详情）；
  题目通过率对所有人公开（竞赛进行中自动隐藏），出题人可查看评测状态分布与用例失败分布；
  题解支持官方标记并置顶，竞赛赛期自动隐藏题解（含发布入口）并在赛后提供复盘入口。
- GitHub/OIDC 第三方登录：支持登录、首次登录设置本地密码，以及在设置页绑定/解绑第三方账号。
- 多赛制竞赛：已支持 Kaggle 分数赛、OI、IOI、IOI 严格与 ACM/ICPC 五种赛制，支持每题提交次数限制、赛时分层社区静默与 SSE 实时排名。
- 产物提交题：支持上传 zip 产物，并在 Solution / Solution AI 隔离容器中统一评测。
- LLM 能力演进：平台默认由域级/平台托管 Provider 提供调用能力并支持 BYOK 恢复接入，题目只需声明调用别名与预算。
- **移除无域兼容路由**：`GET /api/v1/queue`、`GET /api/v1/queue/events`、
  `GET /api/v1/submissions/:id/events`、`POST /api/v1/problems/:id/self-test`、
  `GET /api/v1/problems/:id/self-tests`、`GET /api/v1/self-tests/:id` 与本人跨域
  提交列表 `GET /api/v1/me/submissions` 已删除（返回 404）。请改用
  `/api/v1/domains/:slug/...` 或 `/api/v1/instance/queue` 等价接口；本人提交详情与
  产物下载 `/api/v1/me/submissions/:kind/:id`、`/me/submissions/submission/:id/artifact`
  继续保留。

## 2026-08

- LLM Gateway：新增 `noj-llm-gateway` 服务，支持 Provider 托管、eval_token、限流/额度与用量审计；P 型题可接入 LLM 调用。
- 统一题目包（Problem Bundle）导入：`import-bundle` 端点与 CLI 工具集，支持按 `(type, number)` 幂等更新/新建（#182）。
- 优化 CI 与测试运行效率：按模块路径过滤 job、测试分组并行（#183）。
- 社区系统：关注动态流与社区功能修复（#178）。
- 竞赛系统：类 Kaggle 分数赛、每题提交次数限制与 SSE 实时排名（#174）。
- 题单（training）：用户可创建/管理题单，管理员可发布、置顶、编辑任意题单（#224）。
- 公告系统：公告 CRUD、发布/下架、置顶与 SSE 变更推送（#231）。
- 客观题套卷：单选/多选/判断小题，服务端即时判定，可并入竞赛。
- TFA / 两步验证：TOTP 启用/禁用、恢复码、登录二次验证（#228）。
- 自测（self-test）：编辑器内提交自测任务，不进入正式提交记录。

## 2026-07

- 引入统一 API 调用层 `useApi` 并全量迁移调用点（#180）。
- Nuxt UI v4 组件框架迁移与 Tailwind v4 基建。
- 后台管理数据完整性修复（#176）。
- 全面测试审计与补强（#172）。
- 文档：新增 AI 优先使用开发工具脚本的硬性要求（#173）。
- 双容器评测架构（Evaluator + Solution，NDJSON 编排）落地。
- 测试并行分片（`TEST_SCHEMA` 隔离）与 CI 优化。

## 历史里程碑

- **Phase 0**：浏览器注册 → 做题 → 提交 → 看到评测结果。
- **Phase 1**：榜单可查，题目可筛选，管理后台可用（另已交付：竞赛、社区、RBAC）。
- **Phase 2**（进行中）：可创建考试 → LMCC 认证闭环（竞赛已交付，考试模式待做）。
- **Phase 3**（规划）：多 Worker 并发评测与高可用。
