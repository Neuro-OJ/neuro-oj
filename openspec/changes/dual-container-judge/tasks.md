# 双容器 Evaluator/Solution 评测运行时 — 任务拆分

> 总体拆分：4 段 PR（A1 / A2 / B / C），按依赖顺序合并。详细架构与协议见 `design.md`、提案背景见 `proposal.md`、增量规范见 `specs/`。

## 1. PR-A1 — 协议 + SDK + types（无 Docker 依赖）

- [ ] 1.1 `noj-judge/src/types.rs`: 扩展 `JudgeTask`（新增 `mode?: 'single' | 'dual'`、`runtime_config?: RuntimeConfig`）
- [ ] 1.2 `noj-core/src/types/index.ts`: 同步扩展 `JudgeTask` 类型（含 `RuntimeConfig` 接口）
- [ ] 1.3 `noj-judge/sdk/evaluator/` 创建 `noj_evaluator_sdk` Python 包：
  - [ ] `SolutionRunner.call(fn, *args)` + 内部阻塞读 stdin 接收响应
  - [ ] `result.accept(score, ...)` / `result.wrong_answer(score, message, ...)` 写 `---RESULT---` 标记
  - [ ] `configure_logging()` 把 stdout/stderr 重定向（print 到 stderr）
  - [ ] 类型序列化层：仅接受 7 种基本类型 + bytes base64
- [ ] 1.4 `noj-judge/sdk/solution/` 创建 `noj_solution_sdk` Python 包：
  - [ ] `host.py` 模块（stdin/stdout NDJSON 帧收发、line buffering、trace sanitize）
  - [ ] `register(fn)` 函数（重复注册抛错）
  - [ ] `register("name", fn)` 形式支持命名注册
- [ ] 1.5 SDK 单测（无 Docker）：
  - [ ] SolutionRunner 各类型往返（None / bool / int / float / str / bytes / list / dict）
  - [ ] SolutionRunner `call_timeout_ms` 行为
  - [ ] SolutionRunner 非法类型抛 `Rejected`
  - [ ] host.register 重复注册抛错
  - [ ] host 未知函数返回 `NotFound`
  - [ ] host 用户代码 raise 返回 `Exception` + sanitize trace
  - [ ] SDK `configure_logging()` 后 evaluate.py print 不污染 stdout

## 2. PR-A2 — Docker E2E + orchestrator（依赖 PR-A1）

- [ ] 2.1 `noj-judge/dual/` 模块：
  - [ ] `DualContainer` 结构（含两个 Container + 两个 Exec handle）+ RAII Drop 清理
  - [ ] NDJSON 帧解析器（区分 stdout NDJSON / `---RESULT---` / 未知内容）
  - [ ] 消息转发：Evaluator exec stdout → Solution exec stdin；Solution exec stdout → Evaluator exec stdin
  - [ ] 容器创建复用现有 pool/exec/sandbox 基础设施
- [ ] 2.2 `noj-judge/src/judge/runner.rs`: `evaluate_dual()` 入口；与 `evaluate_with_pool` 并存
- [ ] 2.3 `noj-judge/src/main.rs`: `task.mode == 'dual'` 路由到 `evaluate_dual()`；其余走单容器
- [ ] 2.4 `tests/e2e_dual_container.rs` 新增 12 条测试（见 design §9 表格）：
  - [ ] `dual_basic` — A+B Problem Accepted
  - [ ] `dual_persistent` — 多次 call 复用 host 状态
  - [ ] `dual_timeout` — 单次 call 超时返 `Timeout` 而非挂死
  - [ ] `dual_solution_exception` — sanitize trace
  - [ ] `dual_solution_cannot_overwrite_evaluate` — Solution 写盘覆盖失败
  - [ ] `dual_solution_no_network` — socket / urllib / DNS 全部失败
  - [ ] `dual_solution_module_shadowing` — Solution PYTHONPATH 不影响 Evaluator
  - [ ] `dual_solution_read_evaluator_env` — Solution 看不到 Evaluator secret
  - [ ] `dual_solution_cannot_leak_fd` — `/proc/self/fd` 不可读 IPC
  - [ ] `dual_evaluator_no_network` — Evaluator 容器 network 硬编码 none
  - [ ] `dual_legacy_fallback` — 旧 JudgeTask 走单容器
  - [ ] `dual_image_kind_mismatch` — solution image kind=evaluator 返 400
- [ ] 2.5 测试辅助：`tests/common/mod.rs` 提供 dual 任务测试 fixture（动态构建临时镜像 COPY 当前 SDK/agent 源码到 `python:3.12-slim`）

## 3. PR-B — 生产镜像 + judge_images.kind（依赖 PR-A1）

- [ ] 3.1 `noj-judge/docker/evaluator-python/Dockerfile`:
  - [ ] 基于 `python:3.12-slim` + ReadonlyRootfs 友好的构建
  - [ ] COPY `sdk/evaluator/` 至 `/usr/local/lib/python3.12/site-packages/noj_evaluator_sdk/`
  - [ ] 默认 `USER` 设置（运行时再降为 nobody）
- [ ] 3.2 `noj-judge/docker/solution-python/Dockerfile`:
  - [ ] 基于 `python:3.12-slim`
  - [ ] COPY `sdk/solution/` 至 `/usr/local/lib/python3.12/site-packages/noj_solution_sdk/`
  - [ ] entrypoint `python3 -m noj_solution_sdk.host`
- [ ] 3.3 `noj-judge/scripts/build-sdk-images.sh`: 并行 build 两个镜像打 `:dev` tag
- [ ] 3.4 `docker-compose.yml`: 集成新镜像构建步骤（开发环境可选 build）
- [ ] 3.5 Drizzle 迁移 `0018_judge_images_kind.sql`:
  - [ ] `ALTER TABLE judge_images ADD COLUMN kind text NOT NULL DEFAULT 'evaluator' CHECK (kind IN ('evaluator', 'solution'))`
  - [ ] 历史数据全部标记为 'evaluator'（admin 后续手动调整）
- [ ] 3.6 `noj-core/src/services/judge-images.ts`: `CreateJudgeImageInput` 必填 `kind`，写入校验
- [ ] 3.7 `noj-core/src/mq/judge-rpc.ts`: `get_image_allowlist` 返回 `{ image, kind }[]`
- [ ] 3.8 `noj-judge/src/mq/rpc.rs`: 解析升级后的 RPC 响应
- [ ] 3.9 judge 启动时按 kind 分别预热容器池（仅 `evaluator` kind 入池）

## 4. PR-C — DB + core API + UI（依赖 PR-A1、PR-B，可与 PR-A1 并行启动）

- [ ] 4.1 Drizzle 迁移 `0017_problem_runtime_config.sql`:
  - [ ] `ALTER TABLE problems ADD COLUMN runtime_config jsonb`
  - [ ] `CHECK (runtime_config IS NULL OR jsonb_typeof(runtime_config) = 'object')`
- [ ] 4.2 `noj-core/src/db/schema.ts`: `problems` 表增加 `runtime_config` 字段
- [ ] 4.3 `noj-core/src/types/problems.ts`:
  - [ ] `CreateProblemInput` / `UpdateProblemInput` 新增 `runtime_config?: RuntimeConfig | null`
  - [ ] `ProblemResponseWithCategories` 新增 `runtime_config: RuntimeConfig | null`
  - [ ] Zod schema 校验 `runtime_config` 结构、镜像白名单、kind 匹配
- [ ] 4.4 `noj-core/src/services/problems.ts`:
  - [ ] `createProblem` / `updateProblem` 处理 `runtime_config` 字段
  - [ ] 提交时 `runtime_config` 与 `judge_image` / `judge_command` 同步策略
  - [ ] ExportProblem / parseImportPayload 兼容旧版导出（缺失字段仅 warning）
- [ ] 4.5 `noj-core/src/services/submissions.ts`:
  - [ ] 任务构造前 `SELECT ... FOR UPDATE` 锁住题目行
  - [ ] 读 `runtime_config` 决定 `mode` + 构造 `JudgeTask`
- [ ] 4.6 `noj-core/src/routes/admin.ts`: 题目 CRUD 路由透传 `runtime_config`
- [ ] 4.7 `noj-ui` admin 题目编辑表单:
  - [ ] 增加 runtime 配置块（含 Evaluator / Solution 双卡片）
  - [ ] Solution 镜像下拉仅展示 `kind='solution'` 的白名单
  - [ ] Evaluator 镜像下拉仅展示 `kind='evaluator'` 的白名单
  - [ ] admin 提交前客户端预校验
- [ ] 4.8 `noj-core/src/services/audit-log.ts`: 新增 `problems.runtime_config_changed` 审计 action
- [ ] 4.9 `noj-tests/e2e/08_dual_container_judge.test.ts`:
  - [ ] admin API 配置双 runtime 题目 + 提交 → Accepted
  - [ ] 镜像被下架 → `image_not_allowlisted` 错误 + UI 友好提示
  - [ ] 单容器题目回归测试（确保 PR-C 不破坏）

## 5. 文档与 OpenSpec 收尾

- [ ] 5.1 spec 增量文件落盘：
  - [ ] `openspec/changes/dual-container-judge/specs/judge-worker/spec.md`（MODIFIED Requirements）
  - [ ] `openspec/changes/dual-container-judge/specs/judge-image-whitelist/spec.md`（MODIFIED Requirements）
  - [ ] `openspec/changes/dual-container-judge/specs/problem-runtime-config/spec.md`（新增全文）
- [ ] 5.2 各 PR 合并后执行 `openspec archive dual-container-judge` 归档
- [ ] 5.3 更新主 `openspec/specs/judge-worker/spec.md` §6 dual 模式段落（archive 同步时自动完成）
- [ ] 5.4 更新主 `openspec/specs/judge-image-whitelist/spec.md`（archive 同步时自动完成）

## 6. 关键检查点（每 PR 合并前必过）

- [ ] `cargo fmt` + `cargo clippy`（no warnings）+ `cargo test --lib` 全过
- [ ] `deno fmt --check` + `deno lint` + `deno task test` 全过
- [ ] `npm run build`（no-jui）通过
- [ ] Docker E2E：`NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored` 全过（PR-A2 起）
- [ ] 全链路 E2E：`NOJ_RUN_E2E=1 deno task test` 全过（PR-C 起）
- [ ] GPG 签名所有提交
- [ ] 不存在除设计稿允许外的字段（任何 `JudgeTask` 字段新增需更新 design.md）