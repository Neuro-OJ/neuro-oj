# Agent Note: 生产验证基线、AI 评测可视化反馈与通用 VS Code 插件升级

Status: implemented

## Problem

Neuro OJ 已具备双容器沙箱、`noj-llm-gateway` 网关、`noj-cli` 生产部署和 `noj-lmcc-extension` 基础插件，但仍存在三项核心短板：

1. 缺乏面向公开模拟赛的高并发压测/混沌演练工具、深度沙箱对抗测试与升级后的一键 `rollback` 能力；
2. AI 题评测结果只向做题人展示总分与基础测试点，网关采集的 LLM Token/成本/延迟与调用明细未聚合展示，缺少能力维度雷达图与 Badcase 对比；
3. IDE 插件绑定 LMCC 且仅支持单文件草稿与提交，缺少题面预览、本地 Mock Evaluator 调试、多文件 ZIP 提交、云端自测与 IDE 内报告视图。

## Decision

1. **生产稳定性与一键回滚（`noj-judge` / `noj-tests/stress` / `noj-cli` / `noj-docs`）**：
   - `noj-judge` 补齐符号链接与反斜杠路径穿越拦截及 `pids_limit` / OOM / readonly rootfs / capabilities 逃逸对抗用例。
   - 新增 `noj-tests/stress/`（`contest-load-test.ts` 与 `chaos-drain-verify.ts`）覆盖 4:2:1 优先级、用户公平锁与中断重投验证，并配套 `noj-docs/docs/operators/contest-readiness-drill.md` SOP。
   - `noj-cli` 新增 `rollback` 命令与跨版本迁移安全门禁（检测到数据库迁移时默认拒绝单纯回切镜像，要求显式 `--restore-backup` 或 `--force-app-only`）。
2. **AI 评测可视化反馈（`noj-llm-gateway` / `noj-core` / `noj-ui`）**：
   - `noj-llm-gateway` 新增 `GET /internal/usage/submission-summary` 按 `submission_id`/`attempt_id` 聚合统计与时间线，`include_messages=1` 时才返回脱敏消息。
   - `noj-core` 以功能切片 `src/features/evaluation-feedback/` 对外提供 `GET /domains/:slug/submissions/:id/feedback` 与 `/self-tests/:id/feedback`，严格遵循 `result_visibility` 门控并过滤隐藏测试点，普通正式提交默认不返回 `request_messages`。
   - `noj-ui` 落地纯 SVG `MetricRadarChart`、`LlmTraceTimeline`、`BadcaseComparison` 与 `AiFeedbackPanel`，接入提交与自测详情页。
3. **通用 VS Code 插件升级（`noj-lmcc-extension` → `noj-vscode-extension`）**：
   - 将目录、包名（`neuro-oj-vscode`）、CI/Release 资产名（`neuro-oj-vscode-<version>.vsix`）及全仓门禁脚本全面切换为通用 VS Code 插件，保留 `neuroOj.*` 命令前缀兼容现有配置。
   - 零新增第三方依赖实现工作区 `.noj/problem.json` 绑定、题面 Webview、双轨本地 Mock Evaluator（`noj-judge run-local` 与轻量 Python + 内置 OpenAI Mock HTTP Server）、纯 `node:zlib` 标准 ZIP 多文件提交、云端 Self-Test 与 IDE 内可视化反馈 Webview。

## Alternatives considered

- **在 `noj-ui` 引入 ECharts 等重型图表库**：会显著增加前端构建体积并偏离 Nuxt UI + Tailwind token 体系；最终选用零外部依赖的纯 SVG 雷达图。
- **原地保留 `noj-lmcc-extension` 目录名仅改展示名**：仓库定位已扩展至通用 AI 评测与多竞赛场景，继续保留 `lmcc` 命名易误导外部贡献者与官方关系认知，因此同步更名目录及发布资产。
- **在回滚时默认自动还原备份**：数据库还原会丢弃升级后新产生的提交，因此默认采用迁移探测守卫，由运营者显式选择 `--restore-backup` 或 `--force-app-only`。

## Consequences

- `noj-core` 新增切片严格满足 `check-feature-boundaries.ts` 与 `check-module-boundaries.ts` 零违规。
- `noj-vscode-extension` 保持零新增 npm 依赖，与现有 `osv-scanner` 与离线构建兼容；`neuro-oj-lmcc-*.vsix` 发布资产名变更需在后续 Release 说明中提示老用户迁移安装新 VSIX。
- 面向公开模拟赛前仍需在 Linux + Docker 环境下执行一次 `NOJ_RUN_E2E=1` 沙箱测试与真实 staging `--live` 压测以获取实际硬件基线。
