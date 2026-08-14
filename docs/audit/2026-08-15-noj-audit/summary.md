# NOJ 全模块审计总结报告

- **日期**：2026-08-15
- **基线**：`main` bookmark @ commit `31150781`（支持用户头像上传 #239）
- **范围**：noj-core（~5.7 万行）、noj-ui（~2.1 万行）、noj-judge（~0.7 万行）、noj-docs + 根目录文档/配置（~0.4 万行）
- **方法**：31 个 finder 子代理按模块×维度并行只读审查（250 条原始发现）→ 同根因去重（→225）→ 11 个对抗性 verifier 逐条读码复核 → 父代理聚合
- **结果**：225 条去重发现经对抗验证 **全部为真阳性（0 误报）**；30 条严重级经复核下调，2 条维持「严重」

## 严重级总览

| **严重 2** | **高 17** | **中 57** | **低 98** | **信息 51** |

| 模块 | 真阳性 |
|---|---|
| core | 113 |
| ui | 43 |
| judge | 41 |
| docs | 28 |

## Top 15 优先处理

| ID | 严重级 | 模块 | 标题 | 位置 |
|---|---|---|---|---|
| NOJ-179 | 严重 | judge | BRPOP 无 ACK/无超时重投，judge 崩溃即永久丢失评测任务 | `noj-judge/src/mq.rs:19-22` |
| NOJ-248 | 严重 | ui | 搜索高亮 v-html 未转义用户内容，导致存储型 XSS | `noj-ui/components/feature/search/SearchResultItem.vue:27,85-95` |
| NOJ-032 | 高 | core | 必填项 DATABASE_URL 缺失未在启动期失败，静默降级为 PGlite 内存库 | `noj-core/src/db/connection.ts:32-56` |
| NOJ-000 | 高 | core | JWT 验证未固定算法（未显式拒绝 HS384/HS512） | `noj-core/src/lib/jwt.ts:99-102` |
| NOJ-091 | 高 | core | getClientIp 无条件信任 X-Real-IP，可伪造 IP 绕过 IP 限流与 IP 封禁 | `noj-core/src/lib/rate-limit-env.ts:136-166` |
| NOJ-115 | 高 | core | 本地存储路径穿越：任意文件读取与删除（支持包 URL 未校验） | `noj-core/src/lib/storage/local.ts:53-56, 125-130, 137-149` |
| NOJ-116 | 高 | core | S3 对象任意读取/删除：未校验的 support_package_storage_url 直达 GetObject/DeleteObject | `noj-core/src/lib/storage/s3.ts:102-119, 126-145` |
| NOJ-031 | 高 | core | 生产 TRUSTED_PROXIES 致命校验在系统设置缓存初始化之前执行，读不到 DB 配置 | `noj-core/src/main.ts:122-157` |
| NOJ-066 | 高 | core | 结果消费 at-most-once：BRPOP 后崩溃/DB 失败即丢结果且无重投 | `noj-core/src/mq/base-consumer.ts:69-96` |
| NOJ-074 | 高 | core | 结果 BRPOP 后写 DB 失败被吞掉、不 requeue，结果永久丢失且提交卡在 judging | `noj-core/src/mq/consumer.ts:54-60` |
| NOJ-067 | 高 | core | DB 写入与 LPUSH 非事务，崩溃产生永久 Pending 孤儿提交且无恢复机制 | `noj-core/src/services/submissions-crud.ts:362-389` |
| NOJ-075 | 高 | core | 批量重测用首条提交的 rejudge_seq 覆盖全部提交，多数结果被误判过时而静默丢弃 | `noj-core/src/services/submissions-rejudge.ts:261-266,288-299` |
| NOJ-160 | 高 | judge | ---RESULT--- 标记与结果 payload 跨 chunk 丢失导致误判 SystemError | `noj-judge/src/dual/mod.rs:579, 582-586, 626-634` |
| NOJ-161 | 高 | judge | 成功路径丢失 rejudge_seq，重测结果被 core 静默丢弃、提交卡在 judging | `noj-judge/src/dual/mod.rs:725-750（关键 748）` |
| NOJ-190 | 高 | judge | 镜像名/命令/网络全部来自消息，judge 侧零白名单复验（叠加 Redis 无认证） | `noj-judge/src/dual/mod.rs:155-179` |

## 核心结论（按主题）

1. **评测链路 at-most-once 架构缺陷（最高优先级）**：judge 侧 BRPOP 弹出即删、core 侧 BRPOP 后写库失败即丢，两侧均无 ACK/重投/死信/启动补偿，提交可永久卡在 pending/judging；提交「写 DB→LPUSH」非事务存在孤儿窗口。见 NOJ-179 / NOJ-066 / NOJ-067 / NOJ-074。
2. **可利用的严重漏洞**：搜索高亮 v-html 存储型 XSS（NOJ-248，任意注册用户发帖即可让所有搜索匹配者自动触发）；SSR/降级净化器协议绕过（NOJ-249，验证后降为「高」，SSR 首屏路径仍建议尽快修）。
3. **存储层越权（高）**：`support_package_storage_url` 客户端可控且两侧无校验——local 模式可路径穿越读/删文件（NOJ-115），S3 模式可跨对象读/删他人支持包（NOJ-116）。
4. **judge 沙箱纵深不足**：容器以 root 运行、rootfs 可写、无 CPU 限制、内存上限信任消息、镜像/命令/网络在 judge 侧零复验（NOJ-190/188/189/187）；zip 声明大小绕过可致 judge OOM（NOJ-193）。
5. **限流与封禁缺口**：注册/找回密码/提交代码/私信均无限流；X-Real-IP 无条件信任可绕过 IP 限流与封禁（NOJ-091）；登录代理丢客户端 IP 使 IP 限流退化为共享桶（NOJ-215）。
6. **一致性问题簇**：密码策略文档 12 vs 实现 8（NOJ-120/047）、搜索参数 limit vs per_page（NOJ-225）、公告分页形状、Cookie 属性与规范不符（NOJ-108）、OpenSpec 规范多处漂移（NOJ-109/110/111/112/113/114）、AGENTS/CLAUDE/README 多处过时。
7. **文档站**：noj-docs 与 main 实现存在多处不符（JudgeTask 字段、启动命令、备份路径、镜像名、白名单 RPC 说法等），详见 `docs.md`。

## 建议的修复优先级

- **P0（立即）**：NOJ-248（存储型 XSS）、NOJ-115/116（存储越权）、NOJ-179/066/067/074（消息永久丢失链）
- **P1（短期）**：NOJ-091/215（IP 防护失效）、NOJ-193/190/188（judge 沙箱与 DoS）、NOJ-249（净化器）、NOJ-161/075（rejudge_seq 两处丢失）
- **P2（迭代）**：限流补齐、状态机 TOCTOU（NOJ-065）、性能热点（未读数 N+1、榜单物化视图全量刷新、社区搜索无索引）
- **P3（清理）**：文档/规范漂移、代码质量（巨型文件、硬编码角色名）、依赖锁清理

修复时请遵守仓库约定：OpenSpec 提案先行（`/opsx:propose`）、GPG 签名、Conventional Commits（中文描述）、禁止直推 main。完整明细见 `core.md` / `ui.md` / `judge.md` / `docs.md` 与机器可读 `findings.json`（含每条发现的原严重级、验证结论与合并来源）。中间产物（finder 原始输出、分片与 verdict）保留在 `raw/` 供追溯。
