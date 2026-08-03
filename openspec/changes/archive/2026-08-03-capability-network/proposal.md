# 评测网络能力（capability-network）

## Why

LMCC 大模型能力评测中，用户应用（solution）可能需要与外部网络 API 交互（如 LLM 接口、检索服务）。当前评测沙箱对所有容器统一 `network_mode: none`，无法支持此类题目。需要一种**安全受控**的方式：solution 保持无网，由 evaluator 提供经注册的 capability，solution 通过 RPC 转发调用。

## What Changes

- **配置**：`runtime_config.evaluator.network` 新增可选对象字段（`enabled: boolean`，默认 `false`），开启后 evaluator 容器以 Docker `bridge` 模式联网；solution 容器保持 `network_mode: none` 不变。
- **协议**：NDJSON 新增 `capability` 帧（`{"type":"capability","id","name","args":[...]}`），由 solution 发出、judge 转发至 evaluator；响应复用现有 `result/error` 帧按 `id` 匹配返回。judge 侧 `handle_eval_chunk` 需新增转发 evaluator stdout 的 `result/error` 帧。
- **SDK**：`noj_solution_sdk` 新增 `call_capability(name, *args)`（替换现有文档占位，当前代码中不存在）；`noj_evaluator_sdk` 新增 `register_capability(name, handler)`。solution 侧 `host.py` 需从单线程 reader 重构为 reader 线程 + 单 worker 队列（避免用户函数内阻塞等待响应导致死锁）。
- **UI**：admin 题目编辑表单（`ProblemEditor.vue`）新增「evaluator 联网」开关。
- **文档**：做题人文档新增 capability 使用说明；出题人文档新增 `register_capability` 用法与「如何提供受限网络能力」最佳实践（封装精确函数如 `request_llm_completion` 而非 `fetch_url`）；更新 `what-is-noj.md` / `glossary.md` 现状表述（移除"规划中"）。

## Capabilities

### New Capabilities
- `network-capability`: solution → evaluator 的 capability 调用协议、SDK API 与安全模型（solution 无网、evaluator 显式注册、调用边界即信任边界）

### Modified Capabilities
- `problem-runtime-config`: `runtime_config.evaluator` 增加可选 `network` 字段及其校验规则
- `docker-sandbox`: evaluator 容器网络模式由固定 `none` 变为按配置可选 `bridge`；solution 保持 `none`

## Impact

- **noj-judge**：`src/types.rs`（`EvaluatorRuntime.network`）、`src/sandbox/host_config.rs`（network_mode 参数化）、`src/dual/container.rs`、`src/dual/mod.rs`（帧转发）、`src/dual/protocol.rs`（`FRAME_CAPABILITY`）、SDK 两端（`noj_solution_sdk` / `noj_evaluator_sdk`）、新 E2E binary `e2e_network_capability`。
- **noj-core**：`src/types/index.ts`（类型）、`src/services/problems-types.ts`（`validateRuntimeConfig` 校验）。
- **noj-ui**：`components/editor/ProblemEditor.vue`。
- **noj-docs**：`users/`（新 capability 页面）、`problemsetters/`（solution-sdk.md / evaluator-sdk.md / 新增受限网络能力指南）、`intro/what-is-noj.md`、`reference/glossary.md`、`.vitepress/config`（侧栏注册）。
- **安全影响**：solution 借 evaluator 网络逃逸（SSRF）风险——由「capability 显式注册 + 出题人参数校验」承担；网络层白名单代理列为文档中的未来兜底选项，本期不实现。
