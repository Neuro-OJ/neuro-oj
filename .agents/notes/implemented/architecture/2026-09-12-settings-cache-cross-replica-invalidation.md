# Agent Note: 系统设置缓存的跨副本失效（重新加载语义）

Status: implemented

## Problem

`system-settings.ts` 的配置缓存是**进程内** `Map`，失效只做本地 `cache.delete()`，`Channels` 里也没有 settings 频道 → 多副本下"A 副本改设置，B/C 副本永不感知"，会出现"管理员改了但部分用户行为不一致"。

实现时发现一个**语义陷阱**：`getSetting()` 在缓存未命中时**不回查 DB**，而是走 env → default 兜底链。因此"只删缓存"的跨副本失效会让副本读到**默认值**而不是 A 副本刚写入的 DB 值——比不失效更糟。

## Decision

1. `Channels` 新增 `noj:events:settings`；`updateSetting` / `resetSetting` / `cleanupBootstrapRow` 成功写库后广播 `{type:"settings:changed", key}`。
2. 订阅端执行**重新加载**而非删除：指定 key 走 `reloadSingleKey()`（先读 DB 再替换缓存，不留"读不到"的窗口），无 key 走 `loadAllIntoCache()`（原子替换全量缓存）。bootstrap（env-owned）项跳过，避免把 DB 残留值缓存进来。
3. 监听在模块加载时注册（幂等），与既有 `registerDbResetCallback` 同风格；用既有的 `onEvent` 注册表，不需要改动 shared 依赖方向。
4. `dev-docs/engineering/domain-boundaries.md` 新增「多副本约束」表（逐项登记进程内状态与多副本后果，其余项标注"单副本专用"），顶层 `AGENTS.md` §8.2 增加对应规则。

## Alternatives considered

- 只 `cache.delete()`：会让副本读到 env/default（见上），已在文档与代码注释中明确禁止。
- 把 `getSetting()` 改成 async 直接查 DB：调用点极多，破坏面大。
- 用 Redis 保存配置做共享缓存：引入新的失效/一致性面，收益不抵成本。
- 在事件总线里硬编码 settings 处理：会让 shared 反向依赖 domains，违反域边界规则。

## Consequences

跨副本设置一致性收敛；`src/domains/system/tests/services/system-settings-invalidation.test.ts` 用"直接改库模拟另一副本 + 派发通知"验证收敛，且显式断言失效后 `source === "db"`（而非 default）。`stats-cache` 计数器、`banCache`、限流计数等其余进程内状态登记为单副本专用，未做 Redis 化。
