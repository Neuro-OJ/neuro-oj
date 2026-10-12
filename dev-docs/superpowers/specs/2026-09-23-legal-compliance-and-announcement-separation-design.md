# 法律合规功能集与公告/轮播分离设计

Status: draft（待项目所有者审阅）
日期：2026-09-23
范围：noj-core（新增 legal 域、announcement/submission/identity/system 域改动）、noj-ui、noj-docs
基线：main @ `95315c5c`

---

## 1. 背景与目标

面向 AI 认证与竞赛的 NOJ 计划公开运营，用户以中学生为主（可能包含不满 14 周岁者）。
依据《个人信息保护法》（PIPL）及相关法规，平台需具备**告知—同意—行权**的闭环能力。
同时，当前首页轮播图由公告驱动（issue #231），公告与运营展示位耦合，通知语义不清。

本设计交付两件事，可独立验收：

| 编号 | 工作流 | 一句话 |
| --- | --- | --- |
| **L** | 法律合规功能集 | 同意机制、政策版本化、行权通道、合规运营页、部署指导 |
| **A** | 公告/轮播分离 | 轮播配置化；公告双通道（常驻区块 + 可关闭横幅） |

### 1.1 非目标（明确不做）

- 平台侧真实年龄验证、监护人邮箱回执、独立儿童政策文档（由部署者按适用法规决定是否在隐私政策中补充）
- Cookie 同意横幅（NOJ 仅用必要 Cookie，无追踪型）
- DPO / DPIA / ROPA / 跨境传输评估（规模不适用）
- 数据可携带权的结构化迁移（JSON 导出已足够）
- 独立的"撤回同意"按钮（LLM 共享已并入政策告知，撤回退化为注销）
- 公告横幅的后端关闭记录（改为纯前端 localStorage，见 §5）

### 1.2 关键判断

**告知渠道 ≠ 合规本体**。公告/轮播是渠道，真正决定合规水位的是**同意机制 + 政策页 + 告知完整性**。
因此本设计以 L 为主线，A 作为"合规通知的载体"一并交付。

---

## 2. 现状证据（均为实测）

| 事实 | 证据 |
| --- | --- |
| 首页轮播由公告驱动 | `noj-ui/pages/index.vue`（拉 `/api/v1/announcements?per_page=5`，issue #231） |
| 公告表无横幅字段 | `noj-core/src/shared/db/schema/system.ts` `announcements` 仅 title/content/is_pinned/is_active |
| 注册无同意勾选、无同意记录 | `noj-core/src/domains/identity/routes/auth.ts` register 无 legal 字段；全库无 `user_consents` |
| 无隐私政策/服务条款页 | `noj-ui/pages/` 只有 `data-policy.vue`（数据使用与注销说明） |
| 数据政策页有可编辑配置雏形 | `data_policy_contact` / `data_policy_deployment`（`settings-registry.ts`） |
| 内容审查（腾讯云 TMS）已接入 | `content_review_*` 配置已注册；`content-review` 域有 runner/队列/留痕 |
| 页脚无备案展示位 | `noj-ui/components/layout/FooterBar.vue` 仅版权 + License |
| 无数据导出/删除请求通道 | 全仓无相关端点 |
| `llm_usage` 完整保留 prompt 且无留存期限 | `noj-llm-gateway/src/db/schema.ts`：注释"完整保留 request_messages，不自动清理" |
| 账户注销已有软删除 + 匿名化 | `identity/services/account-deletion.ts` |
| 审计/IP 留存可配 | `audit_log_retention_days`（默认 90）/ `anti_cheat_ip_retention_days`（默认 180） |

---

## 3. 数据模型

### 3.1 新表

**`legal_documents`** — 政策文档身份

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | |
| `kind` | text NOT NULL | `privacy` / `terms`（CHECK） |
| `current_version` | integer NOT NULL DEFAULT 0 | 0 = 尚未发布 |
| `created_at` / `updated_at` | text NOT NULL | ISO 8601 |

UNIQUE(kind)。

**`legal_document_versions`** — 不可变版本（历史痕迹）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | |
| `document_id` | FK → legal_documents | |
| `version` | integer NOT NULL | 单调递增 |
| `content` | text NOT NULL | Markdown 正文 |
| `content_hash` | text NOT NULL | 规范化后 SHA-256 |
| `change_summary` | text NULL | 变更摘要（弹窗展示，可选） |
| `is_material` | boolean NOT NULL DEFAULT false | 重大变更标记；决定是否要求重新同意 |
| `published_at` / `created_by` | text / FK → users | |
| `tsa_provider` / `tsa_token` / `tsa_chain` | text NULL | 可选时间戳（含证书链） |

UNIQUE(document_id, version)。**版本行只追加、不可改**；改政策 = 发新版本。

**`user_consents`** — 同意记录（PIPL 履责证据核心）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | |
| `user_id` | FK → users ON DELETE CASCADE | |
| `document_kind` | text NOT NULL | `privacy` / `terms` |
| `version` | integer NOT NULL | |
| `content_hash` | text NOT NULL | 同意时该版本哈希 |
| `agreed_at` | text NOT NULL | |
| `ip` / `user_agent` | text NULL | |

UNIQUE(user_id, document_kind, version)。**保留历史多行**：查询"当前已同意版本" = `MAX(version)`，
可证明"何时同意过哪一版"。

**`data_requests`** — 删除/更正请求（M3）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | |
| `user_id` | FK → users ON DELETE CASCADE | |
| `kind` | text NOT NULL | `delete` / `correct`（CHECK） |
| `target_type` | text NOT NULL | `post` / `comment` / `submission` / `profile` / `other` |
| `target_id` | text NULL | |
| `detail` | text NOT NULL | 申请人说明 |
| `status` | text NOT NULL DEFAULT 'pending' | `pending` / `processing` / `resolved` / `rejected`（CHECK） |
| `handled_by` / `handled_at` / `resolution` | text NULL / text NULL / text NULL | |
| `created_at` / `updated_at` | text NOT NULL | |

**`carousel_slides`** — 首页轮播（与公告解耦）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | |
| `kind` | text NOT NULL | `image` / `text`（CHECK） |
| `image_storage_url` | text NULL | `kind=image` 必填（复用 StorageProvider） |
| `title` / `subtitle` | text NULL | `kind=text` 用 |
| `gradient_key` | text NULL | 渐变预设键（`kind=text` 用） |
| `link_url` | text NULL | 为空则整卡不可点 |
| `sort_order` | integer NOT NULL DEFAULT 0 | |
| `is_enabled` | boolean NOT NULL DEFAULT true | |
| `created_at` / `updated_at` | text NOT NULL | |

### 3.2 既有表改动

**`announcements`** 增加 `banner_text`（text NULL）：横幅内容；为空则不出横幅。
与 `content`（详情页）独立。迁移三步式（可空列，无需回填）。

### 3.3 配置项（category `legal`）

| key | 类型 | 用途 |
| --- | --- | --- |
| `legal_operator_name` | string | 个人信息处理者名称（M6） |
| `legal_contact` | string | 联系方式（M6） |
| `legal_icp_number` / `legal_icp_url` | string | 页脚 ICP 备案（M1） |
| `legal_police_number` / `legal_police_url` | string | 页脚公安备案（M1） |
| `legal_third_parties` | text(JSON) | 第三方服务清单（M5） |
| `tsa_provider` | string | `disabled`/`freetsa`/`digicert`/`custom` |
| `tsa_url` / `tsa_root_cert` | string | `custom` 时填 |

现有 `data_policy_contact` / `data_policy_deployment` **迁移为**
`legal_contact` / `legal_operator_name`；`/data-policy` 页并入新政策体系。

留存期限复用既有：`audit_log_retention_days`、`anti_cheat_ip_retention_days`、`sse_event_retention_days`
（D9 仅在合规页聚合展示，不新建）。

---

## 4. 后端 API 与同意判定

### 4.1 新域 `legal`

新增 `domains/legal/`，拥有 §3.1 的三张法律表。门面导出：

```ts
getCurrentDocument(kind): { version, content, content_hash, is_material } | null
getRequiredConsentVersion(kind): number   // 最近一个 is_material 版本
getUserConsent(userId, kind): { version, agreed_at } | null
recordConsent(userId, kind, version, hash, ip, ua): void
publishVersion(kind, content, summary, isMaterial, userId): version  // 算 hash、可选打 TSA
```

依赖方向 `identity → legal`（符合域依赖规则，经门面）。

### 4.2 公开读端点

| 端点 | 说明 |
| --- | --- |
| `GET /api/v1/legal/documents` | 隐私政策 + 服务条款的当前版本 |
| `GET /api/v1/legal/documents/:kind/versions` | 版本历史（公开） |

### 4.3 注册与同意（硬门槛）

`POST /api/v1/auth/register` 新增必填 `accepted_legal: boolean`；缺失/false → 400。
创建用户后**同一事务**写两条 `user_consents`（privacy + terms，当前版本），含 IP + UA。

注册页复选框文案（自我声明式同意）：

> ☐ 我已年满 14 周岁，或在监护人陪同下已阅读并同意《服务条款》与《隐私政策》

### 4.4 同意状态与重新同意

`GET /api/v1/auth/me` 新增：

```jsonc
"legal": {
  "privacy": { "required_version": 3, "agreed_version": 1, "needs_consent": true, "is_material": true },
  "terms":   { "required_version": 2, "agreed_version": 2, "needs_consent": false, "is_material": false }
}
```

**判定口径：只对重大版本判定**。`required_version` = 最近一个 `is_material=true` 的版本；
非重大编辑（错字/排版）不触发重新同意、不打扰。

**存量用户**：无同意记录时 `needs_consent=true`，下次登录补同意。

`POST /api/v1/legal/consent`：`{ kind }` → 记录当前版本同意。

### 4.5 公告横幅（纯前端关闭）

| 端点 | 说明 |
| --- | --- |
| `GET /api/v1/announcements/banner` | 返回最新带 `banner_text` 的公告（无用户态） |

关闭为**纯前端 localStorage**：记录"已关闭的公告 id 集合"（绑 id，非全局布尔）。
**不建表、不建端点、不做 per-user 过滤。**

### 4.6 个人信息导出（M2）

`GET /api/v1/me/data-export` → JSON（账户、提交、帖子/评论、同意记录）。需登录、限流、流式输出。

### 4.7 删除/更正请求（M3）

- `POST /api/v1/me/data-requests`：提交请求（类型/对象/说明），落库 + 通知运营者
- `GET /api/v1/me/data-requests`：查看自己请求与状态
- 管理端 `GET /api/v1/admin/legal/data-requests` + `PATCH` 更新状态

> 注销已覆盖"账户删除"；此通道覆盖**内容类**删除更正请求，轻量状态机，不做自动删除。

### 4.8 TSA（可选 Provider）

`publishVersion` 内**同步**打 RFC 3161 时间戳（政策发布是低频人工操作）。
失败**不阻塞发布**，标记 `tsa_token=null` 并告警。**保存证书链**（长期验证必需）。

Provider seam 与既有 Storage/LLM/Email/ContentReview 一致，默认 `disabled`。

### 4.9 横切约束

- **多副本**：不新增进程内可变状态；政策读取直查 DB（低频）
- **限流门禁**：新写端点（consent / data-requests）与重读端点（data-export）须登记或白名单
- **迁移安全**：`banner_text` 可空；新表 CHECK 约束；经 `check-migration-safety`

---

## 5. 前端页面与交互

### 5.1 法律与合规 admin 页（新）

`/admin/legal`，`ssr: false`，权限 `legal:manage`。**参考 `admin/community.vue` 的草稿/未保存交互，不做 preset。**

Tab：隐私政策 / 服务条款（markdown editor + 版本历史 + 发布）· 备案与主体 · 第三方服务 ·
内容审查（聚合 `content_review_*`）· 留存期限（聚合既有）· 时间戳 TSA。

- 各 Tab 本地草稿；顶部**「有未保存的更改（N 项）」**+ 保存/放弃
- markdown editor 复用 `MarkdownRenderer` 预览
- **发布**独立动作：生成不可变版本，确认时勾选**「标记为重大变更」**
- 敏感项（TSA 根证书）未显式编辑不算 dirty

### 5.2 公开政策页

`/legal/privacy`、`/legal/terms` 渲染当前版本；`/data-policy` 保留（重定向）。

页脚新增条款链接 + 备案信息展示（`legal_icp_*` / `legal_police_*`，**未配置不渲染**）。

### 5.3 注册页

复选框 + 提交按钮禁用（前端）；后端双重校验。

### 5.4 政策变更弹窗

全局 `LegalConsentModal.vue`。触发：`legal.needs_consent && is_material`（登录用户）。
展示变更文档、版本区间、`change_summary`；「我已知悉并同意」→ `POST /legal/consent`。
**不可叉掉**。

### 5.5 首页与导航（公告/轮播分离）

```
首页
├─ 轮播图（carousel_slides 驱动；无 slide 时默认欢迎占位）
├─ 公告区块（常驻，不可叉）→ 全部 active 公告列表（title + excerpt + 「点击查看详情」）
└─ 原 RandomProblems / LatestSubmissions / FollowingFeed

导航栏下方
└─ 公告横幅（可叉）→ 最新一条带 banner_text 的公告；末尾固定「点击查看详情」
     关闭 → localStorage 记公告 id
```

### 5.6 管理端

- 轮播管理 `/admin/carousel`（CRUD + 排序 + 启停 + 图片上传，复用 StorageProvider）
- 公告表单加 `banner_text` 输入（留空 = 不出横幅）

---

## 6. 部署文档（noj-docs）

新增 `noj-docs/docs/operators/legal-compliance.md`：

- 政策配置与发布（含重大变更标记）
- 备案信息填写与页脚展示（未备案时留空说明）
- 内容审查 Provider（腾讯云 TMS 等）接入
- 留存期限配置与含义
- 第三方服务登记（如实）
- 数据导出 / 删除请求的运营者处置流程
- 时间戳 TSA：**FreeTSA=技术验证、联合信任=中国法律场景**；证书链存档要求
- **可能收集的信息清单**（从代码实据推导）+ 免责声明：

> Neuro OJ 正处于开发迭代阶段，本清单可能未穷尽所有数据收集点，且随版本变化；
> 请以实际部署与最新政策为准。

### 6.1 `llm_usage` 保留完整 prompt —— 如实披露并声明必要性

文档须写明：NOJ 的 LLM 网关**保留完整 prompt**，因为

> LLM Prompt 本身是选手代码实现的一部分，且不包含个人隐私内容。保留其是为了便于在竞赛中
> 对选手代码进行审查以及检测作弊者，还有防止用户利用 NOJ LLM Gateway 的功能向人工智能
> 提供非法内容（例如色情、政治、CBRN 等）导致部署者 API 被封禁（留作申诉证据使用）。

**本期不修改 `llm_usage` 的留存行为**（仅披露）。

---

## 7. 测试

| 层 | 覆盖 |
| --- | --- |
| core 单元/集成 | 同意写入（注册事务）、重大版本判定、导出内容、data-request 状态机、配置注册 |
| core 迁移 | `legal_*` 表、`banner_text`、`carousel_slides` 迁移安全 |
| 门禁 | `check-write-rate-limits`、`check-migration-safety`、导出 JSDoc |
| UI | 注册复选框门槛、变更弹窗触发、横幅 localStorage、轮播渲染 |
| E2E | 注册→同意记录存在；发重大新版→登录用户被要求同意；横幅关闭后不再显示 |

## 8. 验收口径

- 新用户不勾选无法注册，且库里能查到同意记录
- 发**重大**新版 → 登录用户被弹窗；发**非重大**编辑 → 不打扰
- 横幅关掉后不再出现，但发新公告会再出现
- 轮播与公告互不影响
- 未配置备案时页脚不显示备案位

---

## 9. 交付批次

| 批次 | 内容 |
| --- | --- |
| **P0（合规本体）** | D1 注册同意 + D2 政策页/版本化 + D3 合规 admin 页 + D4 页脚备案 |
| **P1（权利保障）** | D5 变更弹窗 + D6 数据导出 + D7 删除/更正请求通道 + D8 处理者信息 |
| **P2（增强）** | D9 留存期限聚合 + D10 第三方清单 + D11 TSA Provider + D12 未成年人条款由部署者补充 |
| **A（公告分离）** | D13 轮播配置化 + 公告双通道 + 横幅为公告字段 |
| **文档** | noj-docs `legal-compliance.md`（含信息清单与免责声明） |
