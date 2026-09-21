# Agent Note: 全仓文档一致性与 CI 门禁校准（第五轮无人值守）

Status: implemented

## Problem

仓库文档在多次快速迭代（noj-cli 纯 TS 重写、双容器评测、管理端按子域迁移、
可观测性重构）后出现系统性漂移。本轮对全部 Neuro OJ 文档（根级、各模块
`AGENTS.md`/`CLAUDE.md`、`noj-docs/docs/**`、`deploy/`、`scripts/`）做了只读取证
审查，确认的缺陷分三类：

1. **指向已删除能力的文档会误导读者执行失败命令**：
   - `README.md` 资源表把内存硬门槛写成 `noj-cli doctor`，而 `doctor` 已删除
     （`noj-cli/src/cli.ts` 的 `REMOVED_COMMANDS` 会以用法错误退出）。
   - `CONTRIBUTING.md` 与 `dev-docs/engineering/development.md` 推荐
     `noj-cli deploy init --mode dev` 开发部署入口，该入口已随双模态移除。
   - `.env.prod.example` 头部把已废弃且需人工确认的
     `scripts/deploy/deploy.sh install` 标为"推荐路径"。
   - `noj-docs/docs/operators/judge-workers.md` 使用不存在的
     `bash /opt/neuro-oj/noj`、`noj status`、`noj update` 与容器名 `noj-redis`
     （生产容器实为 `noj-prod-redis-1`）。
   - `noj-docs/docs/operators/observability.md` 与 `deploy/monitoring/README.md`
     引用已删除的 `scripts/deploy/test-alert.sh`。
   - `noj-tests/E2E_TESTING.md` 给出不存在的
     `cd noj-core && deno test -A tests/e2e/api.test.ts`。
   - `noj-cli/README.md` 记录 CLI 会显式拒绝的 `backup restore --dry-run`。

2. **接口/协议路径与实现不符**：
   - 社区管理端点、邮件抑制端点、题目预检端点、RPC `bytes` 线格式
     （`__noj_type__`/`base64` vs 实现 `__bytes__`）、搜索队列名
     （裸 `noj:judge:queue` vs 三级 `:high|:medium|:low`）均与代码不一致。
   - `noj-docs/docs/features/contests.md` 同文自相矛盾（一处称支持封榜、一处称不支持），
     且首页把赛制写成 `icpc / ioi / oi`，而实现 `CONTEST_TYPES` 仅 `kaggle`。
   - `noj-docs/docs/features/search-messages.md` 描述了不存在的「共 N 条结果」文案
     与过时的类型 Tab 列表。

3. **清单/计数/树状结构与现实脱节**：
   - `noj-core` 文档仍列已删除的 `src/routes/` 与 `users.role` 列，权限表停在
     5 个资源域（实现 52 条、10 域）；`noj-ui` 文档 composable 数量与多个组件/
     函数名过时；`noj-judge` 文档缺 5 个源文件、4 个测试 binary，并描述了并不
     存在的白名单 RPC 拉取、`ready` 5s 超时、发 `shutdown` 帧、
     `ensure_image_local()`。
   - `noj-tests/E2E_TESTING.md` 的测试清单还是旧编号体系；`scripts/README.md`
     目录树缺门禁单一事实源 `gate-list.ts` 等；`AGENTS.md` 模块表缺 `noj-cli`。
   - `SECURITY.md` 支持版本仍写 `v0.8.1`（当前 `v0.9.5`）。

这些是**纯文档缺陷**：`check-ci.ts` 全绿，`verify-md-links.ts` 只覆盖相对链接
（478 个文件通过），VitePress 本地构建也通过——即现有门禁无法发现上述漂移。

## Decision

1. **逐条以代码取证后修正**，覆盖 17 个文件：根级 `README.md`、`AGENTS.md`、
   `CONTRIBUTING.md`、`SECURITY.md`、`.env.prod.example`；`scripts/README.md`；
   `deploy/README.md`（未改）与其 `deploy/monitoring/README.md`；
   `noj-cli/README.md`；`noj-core`、`noj-ui`、`noj-judge` 的模块文档；
   `noj-tests/E2E_TESTING.md`；`noj-docs/docs/**` 的 features / operators /
   mechanisms / intro / reference / index。
2. **不新增/不删除文档页面**：`.vitepress/config.ts` 侧边栏 54 条绝对链接逐一核对，
   无死链；本次只纠正内容，避免扩大结构面。
3. **告警投递演练改用 Alertmanager v2 API**：仓库已无 `test-alert.sh`，文档改为
   可直接执行的 `curl POST /api/v2/alerts` + `check-observability.sh
   --check-notifications`，而不是保留一个指向不存在脚本的引用。
4. **不修改审计快照**（`dev-docs/audit/**`）：它们是时点记录，按既有约定加修订
   指针而非回溯改写。

## Alternatives considered

- **只在 noj-docs 内修正**：模块 `CLAUDE.md`/`AGENTS.md` 是 AI 助手的首要上下文，
  漂移同样会误导实现；必须一并校准。
- **为文档引入 markdownlint / VitePress build 到 CI**：能挡住格式与锚点类问题，
  但**挡不住语义漂移**（本次绝大多数缺陷是"文字与代码含义不符"，静态格式检查
  无能为力）。新增 CI job 需改 `ci.yml` 并扩大运行面，收益与该 PR 的文档范围不成
  比例，故不纳入本轮；已另行登记为后续候选。
- **保留 `test-alert.sh` 引用并补脚本**：等于恢复一条已随自举 bash 删除的运维
  入口，与 T24 收敛方向相反；用 3 行 curl 说明替代更小、更可信。

## Consequences

- 读者按文档操作不再命中已删除命令或 404 端点；接口路径、线格式、队列名与代码
  一致；清单/计数与磁盘现实对齐。
- `deploy/monitoring/README.md` 的演练步骤变为可执行的最小说明；`observability.md`
  与 `production-deploy.md` 统一指向 `noj-cli backup drill`。
- `noj-core/AGENTS.md` 与 `CLAUDE.md` 为硬链接（同一 inode），编辑一次即同步；
  `deno fmt` 会重排 markdown 表格列宽，已在 `noj-core` 侧执行 `deno fmt` 保持
  `core-quick-check` 的 `deno fmt --check` 通过。
- 仍存在**未纳入本轮**的改进：文档站构建未进 CI、`verify-md-links` 不校验站内
  绝对链接与锚点。二者记录为后续候选，避免本轮范围蔓延。
