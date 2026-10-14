# Agent Note: 域提交频率的共享受理限额

Status: implemented

## Problem

域配置中的提交频率必须限制全域受理量，多个用户与多个 core 副本不能各自使用独立计数。升级任务重复派发不能重复消耗同一次受理额度。

## Decision

新增 workspace 公共门面 `consumeDomainSubmissionQuota`，调用时读取持久化域额度和实例上限。Redis Lua 使用 Redis TIME 的分钟桶，并在同一次操作中检查域计数、增加计数与写入域内用户及服务器操作 ID 的幂等标记。超额返回 429；有限额度下 Redis 未就绪或调用失败返回 503；null 额度直接放行。

本记录交付公共限额原语及真实 Redis 回归；普通提交、自测和升级入口接入由后续 submission 变更记录验收。实例及用户既有限流继续保留。

## Alternatives considered

进程计数无法跨副本共享；浏览器时钟或表单域身份无法作为可信计量依据；只在任务创建时计数无法限制批量升级产生的提交量。

## Consequences

配置降低在下一次受理时生效。已受理操作的重试保持幂等，失败重试使用相同服务器操作 ID。真实 Redis 测试覆盖两名用户竞争末个名额、同键重试、域间隔离、即时降低上限、Redis 断线及 null 不限额。
