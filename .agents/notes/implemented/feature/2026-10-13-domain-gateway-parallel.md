# Agent Note: 使用域 LLM 配置与 Gateway 隔离

Status: implemented

## Problem

多个学校引用同一道公开 LLM 题时，旧的全局 Provider、默认模型及用户/题目额度键
会共用学校之外的配置与预算。Provider 与用量查询也缺少显式使用域边界。

## Decision

Provider、用量和域内配额增加 Domain 归属；原记录迁入默认域，global 配额保持实例
维度及原数值。core 域设置独立保存 Provider/模型与 revision，新域无源域或主域
回退。协议 v3 强制 Domain 与评测尝试，Gateway 在任何上游请求及额度预占前验证
Provider 归属，并用使用域×尝试、域内用户/题目/组合、域总额及实例总额执行原子
Lua。 预估预占与真实结算沿用原机制，明确 `null` 未限制、`0` 禁止。

内部管理使用 core 已授权的 Domain 头，所有 Provider、用量、配额查询与写入都带
该域条件。配额 upsert 对同 ID 的跨域冲突返回 404，Provider
删除改为停用保留历史。 Domain 管理入口拒绝 global
配额，实例操作需额外受信任标记。实例列表也使用该标记，core 提供独立治理门面，
Domain 列表不混入实例配额。

自定义 SQL runner 已有 0000–0004 且没有 Drizzle meta。首次生成的 snapshot 保留
为元数据基线，相应 SQL 仅登记不执行重复 CREATE；0005 三步回填实际归属。未来
generate 使用时间戳前缀，以符合现有文件名排序和只追加约束，不改写生成 journal。

## Alternatives considered

- 引用公共题使用公共域密钥：无法隔离预算和私有调用，采用使用域 Provider。
- 每次重发读取当前模型：会改变已受理尝试，采用冻结选择与续签。
- 物理删除 Provider：丢失历史依据，采用停用阻止新调用。
- 测试复制 Lua 到 FakeRedis 后认为并发已证实：另外执行真实 Redis Lua 并发测试。

## Consequences

standalone 标准任务启用专属 PostgreSQL 与随机 Redis 键集后 106 通过、0 失败、 1
个既有测试跳过；覆盖空库、旧库、重复迁移、密文/用量/配额保留、跨域 ID，及
并发最后一次域额度、实际结算、另一域独立和实例总額。fmt/lint/typecheck 通过。
core gateway PGlite 与专属 PostgreSQL 标准任务各 26 通过、0
失败，冻结选择与越域授权 已验证，公开门面及准备路由类型检查通过。

本记录只签收上述后端能力。完整提交/Judge 联调、实例配额上限、持久用量对账、
故障恢复及浏览器旅程仍由跨模块验收完成。独立 Gateway 写入与 core 审计不是分布式
事务，失败后的协调与审计完善仍是后续任务，不以当前单模块测试声称整阶段完成。
