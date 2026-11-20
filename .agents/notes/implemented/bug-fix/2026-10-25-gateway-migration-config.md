# Agent Note: 登记 Gateway 迁移目录覆盖配置

Status: implemented

## Problem

Gateway 迁移读取点支持 `NOJ_GATEWAY_MIGRATIONS_DIR`，但配置声明只覆盖数据库、
Redis 和业务运行参数。配置读取门禁因此把它识别为未登记环境变量，导致 CI 的
Config Usage Check 失败；运维也无法从声明清单发现这个打包/测试覆盖点。

## Decision

在 Gateway 自有配置注册表中登记该静态键，说明默认回退到随包 `drizzle` 目录，
并在 Gateway `.env.example` 增加注释示例。迁移代码继续保留现有默认路径和覆盖
语义，不将它登记到 noj-core 的配置注册表。

## Alternatives considered

不把它加入 `REVERSE_EXEMPT` 或文件级豁免；那会让真实可用的迁移目录开关继续
脱离配置审计。也不把 Gateway 配置搬进 Core，因为该变量只由 Gateway 消费。

## Consequences

Gateway 配置声明与读取点一致，配置静态门禁可识别该变量；生产默认行为不变，
需要自定义发布目录时可按 `.env.example` 显式配置。
