# Agent Note: 内容合规审核（云审核 Provider 抽象 + 统一人工审查队列）

Status: implemented

## Problem

平台已有社区举报/审核/处罚、新用户审核期与站内私信功能，但缺少**主动内容合规**
能力：UGC（帖子/评论）只能事后靠举报处理，私信完全没有自动审核。Issue #413
要求引入云审核（阿里云/腾讯云内容安全）并对 UGC 做同步拦截、对私信做异步送审，
同时把低置信/疑似/审核不可用的内容汇聚到一个统一人工审查队列。

## Decision

- 新增 `src/domains/content-review/` 域：
  - `providers/`：统一 `ContentReviewProvider` 接口（`reviewText(text, ctx)`），
    实现 mock（关键词表/注入规则）、阿里云（green20180509 SDK TextScan）、
    腾讯云（cms SDK TextModeration）三个 Provider；`providers/index.ts` 工厂从
    系统设置实例化，密钥缺失返回 null（fail-open 转人工）。
  - `services/review-decision.ts`：按 `content_review_risk_threshold`（默认 80）
    与 `content_review_review_threshold`（默认 50）把 Provider 结论归一化为
    block / review / pass；block 但分数不足时降级 review。
  - `services/review-runner.ts`：统一执行入口（开关 → Provider → 超时包装 →
    裁决 → 落库）；Provider 异常/超时 → `verdict=error` + 转人工，不阻断业务。
    提供 `_setReviewProviderFactoryForTest` 测试注入钩子。
  - `services/review-queue.ts`：`content_review_queue` 表读写。同 target 已有
    `pending_review` 时去重，避免编辑风暴重复入队；处置落 `reviewed/dismissed`
    并写审计 `review.queued / review.rejected / review.resolved`。
  - `services/review-detail.ts`：队列详情按内容类型附上下文（post/comment 现状、
    message 附会话双方 + 最近 200 条聊天记录，参照举报私信上下文的权限分级）。
  - `services/dm-review.ts`：`noj:review:dm` Redis 队列 producer；只送文本，
    不入队不阻断发送（fail-open）。
- 数据库：新增 `content_review_queue` 表（迁移 `0063_wet_wasp.sql`）——
  状态 `pending_review / approved / rejected / reviewed / dismissed`、
  渠道 `ugc / dm`、内容类型 `post / comment / message`、判定与命中词留痕。
  同步更新 `src/db/schema-ddl.ts`（含 audit_logs action CHECK 扩展）。
- 系统设置（`category: review`，8 项）：`content_review_enabled`（默认关）、
  `content_review_provider`（mock/aliyun/tencent/none）、
  `content_review_provider_key/secret`（secret）、两个阈值、异步开关、超时。
- UGC 同步审核：`community-review.ts` 钩子接入 `createPost/updatePost/
  createComment/updateComment` 落库前——仅当内容最终 `published` 且非审核员
  操作时拦截；`pending`（新用户审核期）内容不重复拦截（互不干扰）。
  高置信违规抛 `ForbiddenError(CONTENT_REVIEW_REJECTED)`。
- 私信异步审核：`sendMessage` 成功后 `enqueueDmMessageReview`（text 消息）；
  `mq/review-consumer.ts` 复用 `createConsumer` 可靠消费；block 在 dm 渠道
  降级为转人工（不做即时拦截），与"私信违规进入队列且双方不受即时影响"一致。
  `main.ts` 启动消费者。
- 管理端：`/api/v1/community/admin/content-review`（列表/详情/处置，组级
  `community_moderation:review` 守卫，与举报后台同一权限模型）。
- UI：`pages/admin/content-review.vue`（状态 Tab + 类型/渠道筛选 + 处置弹窗 +
  私信聊天上下文弹窗），导航「内容审查」，复用 `community-moderation` 中间件。

## Alternatives considered

- 私信消息加 `hidden_by_moderator` 字段支持管理员单条隐藏 → 用户确认第一版
  **仅记录 + 封禁**，不改 messages 表，最小侵入。
- Provider 配置建独立表（仿 LLM Provider CRUD）→ 选择系统设置 KV：零新表、
  天然脱敏/审计/管理 UI。
- 云审核失败时内容强制转 pending → 拒绝：违背 issue 的 fail-open 要求，
  老用户内容会被卡住等待人工，影响可用性。
- Provider 调用用 HTTP + 手写签名而非官方 SDK → 选择官方 SDK 动态导入，
  与 email-providers 的阿里/腾讯模式一致，减少签名维护。

## Consequences

- 审核默认关闭（`content_review_enabled=false`），启用后才产生调用与队列数据。
- mock Provider 的 `content_review_provider_key` 可填逗号分隔违禁词做运营试用。
- 阿里/腾讯适配器无真实密钥与账号，请求构造/响应解析逻辑经类型检查与人工
  评审验证；CI 不跑真实云调用。
- `audit_logs` action CHECK 增加三个 `review.*` 动作（`system.ts` +
  `schema-ddl.ts` + `types/audit-log.ts` 三处同步）。
- `scripts/check-domains.ts` 的 `DOMAINS` 加入 `content-review`；
  messaging 经 content-review barrel 引用送审入口（符合域边界）。
- 扩展方向（不在本次范围）：图片/附件审核、申诉流程、处置结果通知作者/双方。
