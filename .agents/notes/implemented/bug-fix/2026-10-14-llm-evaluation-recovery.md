# Agent Note: LLM 评测错误恢复与配额诊断

Status: implemented

## Problem

LLM 评测将瞬时分钟限流和累计额度耗尽统一返回 out_of_usage，选手收到错误归因。单请求上游 500 导致整批评测退出。客户端结束后 Gateway 和独立 Judge 转发器继续等待上游，失败预占的 token 也未归还。生产校园助手旧版 180 秒时限无法容纳思考模型的长尾延迟。

## Decision

分钟限流使用 rate_limit_exceeded 并返回到下个分钟窗口的 Retry-After；累计配额维持 out_of_usage。Redis Lua 返回被拒计数器及当前值、增量和上限，网关在审计参数和脱敏日志中保存不含标识符的诊断。失败、断开的请求归还 token 预占，调用次数仍保留。

Gateway 合并客户端取消与上游请求截止信号。固定目标网络转发器检测客户端连接关闭，shutdown 上游 socket，使取消能跨隔离网络传播。Evaluator SDK 默认对瞬时 5xx、网络错误、可重试限流最多重试一次，额度耗尽和鉴权错误不重试。SDK 请求超时包含 Provider 最长 60 秒排队和 120 秒上游请求，重试的请求仍受原有评测预算约束。

## Alternatives considered

只提高总时限无法解决失败预占、错误归因或请求取消。移除额度限制无法控制调用预算。无界重试会放大上游故障；现在保持重试上限和平台额度检查。重新升级整套生产服务容易覆盖既有自测热修复，因此运维补丁以既有 v0.10.5 镜像为基线构建，仅更新 Gateway 与 Evaluator SDK。

## Consequences

无需数据库迁移。审计 error_code 的配额超限值仍为 limit_exceeded，细节位于 request_params.quota_limit。失败预算恢复不代表上游未计费，Gateway 无法确定异常请求的实际计费。SDK 可通过 max_retries=0 保持不重试行为；调用预算应留出重试余量。独立 Judge 网络的转发器需单独替换脚本并重启，不能只更新 Gateway。

验证包括网关测试、SDK 单元测试、客户端断开传播的真实 TCP 测试，以及生产中受影响提交的定向重测。
