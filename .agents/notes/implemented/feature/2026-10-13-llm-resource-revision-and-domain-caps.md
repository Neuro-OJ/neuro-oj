# Agent Note: LLM 配置资源版本与实例上限视图

Status: implemented

## Problem

Domain LLM Provider 与配额管理缺少资源 revision。旧 Provider 管理只在 core 读取
updated_at 后校验，随后远端无条件覆盖，不能防止两个进程同时写入。 配额旧 upsert
也可能用过期界面状态重新插入缺失 ID。域 UI 无法展示实例允许的
日/月额度上限，用户只能在提交后获知超限。

## Decision

- 独立 Gateway Provider 与 quota 行增加 revision，初始 1，数据库 CHECK 要求
  不低于 1；Schema 与生成迁移由 root 统一管理。
- 所有配置写入要求 If-Match：新建使用 0，更新和停用使用所读取资源 revision。
  Gateway UPDATE 在同一 SQL 条件内比较 id、domain_id 与 revision，成功原子
  增加版本并返回结果；不靠 core 预读、Domain revision 或进程锁避免覆盖。
- 配额无 id 时创建新 UUID，有 id 时只更新既有行，缺失返回 404。版本冲突返回
  409，缺少前置条件返回 428。停止 Provider 保留原历史依据与版本。
- core 的 Domain 路由和旧 main 管理路由均透传前置条件，删除旧 updated_at
  预读中间件；不保留旧入口无条件覆盖能力。
- Domain quotas GET 保留 data 数组，附加当前持久 caps day/month。配置异常
  返回明确不可用，显式 null 额度原样保存，不以 null 触发默认额度。
- 既有域权限、实例上限、域管理员只能降低总额度、Provider 密钥加密及跨域条件
  保留，新增字段不扩大管理资源或题目数据权限。

## Alternatives considered

- 只在 core 读 revision 后远端普通 UPDATE：检查与写入分离，仍会覆盖，不采用。
- 使用 Domain revision 替代 Provider/quota revision：独立 Gateway 持有真实配置，
  不满足资源并发约束，不采用。
- 无 If-Match 时偷偷读取最新版本：将过期草稿解释成当前决定，拒绝。
- 继续按 id upsert：不区分创建与更新，可能重新创建已失效资源，不采用。

## Consequences

core、Gateway 与客户端须协调升级。客户端可用 409 保留编辑草稿并提示重新读取。
独立版本冲突不影响其他 Provider、配额或域设置的编辑内容。

真实 PostgreSQL 并发测试覆盖 Provider/quota 两写者使用同一 revision 时仅一次
成功、旧版本不覆盖、新建前置条件、跨域 ID、停用及显式 null 持久化。 Gateway
带独立随机 PostgreSQL schemas 与 Redis 的标准全量测试为 111 passed / 0 failed /
1 ignored；忽略项为需真实收费上游的既有测试。 core Gateway 标准 PGlite 与
PostgreSQL 测试各 30 passed / 0 failed，真实组合根 HTTP 回归覆盖 caps、428/409
和旧管理入口。完整 Judge 与浏览器旅程仍由根验收处理。
