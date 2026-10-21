# Agent Note: P6 Judge 上下文与评测协议 v3

Status: implemented

## Problem

Judge 执行路径同时携带 worker 资源、单次运行身份、取消状态和旧版协议字段，
容易在多 Worker、租约丢失、取消或 fallback 时把不同运行混在一起。结果封套也
需要由评测过程的每个分支自行补字段，无法保证 Core 收到的正式提交、自测和平台
错误具有同一组身份字段。

## Decision

- 用 `WorkerContext` 集中表示实例、工作目录、缓存目录和镜像前缀；用
  `RunContext` 集中表示 `task_kind`、`run_id`、提交标识、worker 实例标识和
  可传播的取消标志。
- JudgeTask/JudgeResult 统一升级到评测协议 v3。生产提交要求
  `attempt_id == run_id`，自测要求显式 `self_test_run_id == run_id`，并在进入
  执行与发送结果前校验封套完整性。
- 结果通过统一的 `apply_protocol` 入口补齐协议字段；evaluator 的 details
  不是身份来源，也不能覆盖结果封套中的运行标识。
- 保留租约、取消、fallback 和队列恢复的显式负例测试；跨模块夹具同步为 v3，
  不支持新旧评测协议混跑。

## Alternatives considered

- 继续在各个 runner 函数中增加参数：拒绝，因为参数集合会随协议和资源生命周期
  继续扩散，且不能保证每个结果分支使用同一身份。
- 在 Core 侧收到结果后猜测缺失的 `run_id` 或按字符串前缀回填：拒绝，因为这会
  把协议错误伪装成有效结果，并破坏提交与自测的幂等边界。

## Consequences

- Judge 的执行入口现在可以用明确的 worker/run 生命周期测试租约丢失、取消和
  fallback；Core/Judge/跨模块夹具的协议版本必须同步升级。
- `cargo test --all-targets`（两组测试，308 与 286 项）和
  `cargo check --all-targets` 已通过；本轮没有运行真实浏览器或生产评测。
