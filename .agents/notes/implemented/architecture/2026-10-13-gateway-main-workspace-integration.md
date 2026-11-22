# Agent Note: Gateway 模型别名与节流保留工作空间归属

Status: implemented

## Problem

工作空间升级分支增加 Domain 归属、Provider/配额 revision、token
v3、持久调用账本及额度对账。同期 main 增加模型别名和 Provider RPM/TPM
节流。直接取任一侧的冲突内容，会丢掉另一侧字段、隔离条件或账本结算；排队超时的新增拒绝分支也必须保留使用域及真实模型信息。

## Decision

在隔离集成工作区融合 Gateway 的五处冲突：

- Provider Schema 同时保留非空 `domain_id`、正整数 `revision` 和默认 0 的
  RPM/TPM。
- Provider 创建、查询、内部精简 DTO 及 revision
  条件更新保留域条件，并带上速率字段；不能通过其它域的 Provider ID
  使用或修改资源。
- token 保持 v3，强制 Domain 与评测尝试；别名映射为
  `{alias: upstream_model}`，全部模型仍使用同一个已经冻结的使用域
  Provider。转发和用量记录使用真实模型，审计参数另保留别名。
- Provider 节流保留 main 的共享 Redis
  滑动窗口与队列；域配额及持久账本保留升级分支的预占、结算和失败补算。节流不可用的原行为不能绕过随后失败关闭的域额度检查。
- 排队超时拒绝记录补齐
  `domain_id`、真实模型和别名审计；配额服务故障导致未转发时也释放已占 Provider
  窗口，避免此次合并留下无上游调用的占用。
- 测试 helper 同时支持域和别名冻结，并允许真实 Redis Lua 数组形式的节流返回值。

## Alternatives considered

- 保留工作空间侧、丢弃节流和别名：损失 main 已交付行为。
- 保留 main 侧、退回全局 Provider
  和短暂内存结算：违背域密钥隔离及持久额度恢复规则。
- 为每个别名增加 Provider
  选择：扩大已确认产品范围，破坏一次评测全部模型来自同一使用域 Provider 的契约。

## Consequences

当前集成源码通过冻结锁文件下的标准 Gateway 完整测试：

```bash
cd noj-llm-gateway
NPM_CONFIG_REGISTRY=https://registry.npmjs.org \
NOJ_GATEWAY_TEST_DATABASE_URL=postgres://noj:noj@localhost:5432/noj_gateway_integration_20261013 \
NOJ_GATEWAY_TEST_REDIS_URL=redis://localhost:6390/12 \
NOJ_LLM_TEST_REDIS_URL=redis://localhost:6390/12 \
deno task test --frozen
deno task check
```

真实结果为 127 passed、0 failed、1 ignored；唯一忽略项是需要外部凭据的 DeepSeek
API 调用。PostgreSQL 使用独立测试数据库及随机 Schema，Redis
使用随机测试键并清理本用例键，没有清空共享 Redis。

真实 PG 用例覆盖空库和历史库迁移、Provider/配额跨域 ID 拒绝、并发 revision
更新；增强并发用例同时检查获胜更新的 RPM/TPM，失败更新不能覆盖其值。真实 Redis
用例覆盖 RPM 排队、窗口滑出、超时清理、TPM 预估/实际修正、释放及 FIFO。持久账本
PG/Redis 恢复和去重用例同时运行。模型别名、使用域、Provider
节流组合及错误域/停用拒绝另有路由回归，属于 HTTP handler 与测试上游证据，不冒充
Judge 全链路。

完整 `deno task check` 通过格式、lint 和模块类型检查。日志为
`/tmp/noj-client-integration-gateway-full.log` 与
`/tmp/noj-client-integration-gateway-check.log`。未手工修改锁文件、Gateway SQL
迁移或 journal。两个 `0005` 迁移的完整文件名不同，现 Gateway runner
按完整文件名记录并逐一执行；正式迁移链和后续代码生成仍由集成协调者统一审核。本记录不表示整个
main 集成或最终协调镜像已通过验收。
