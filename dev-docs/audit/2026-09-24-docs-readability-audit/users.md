# 做题人（users） 文档审计报告

> 审计日期：2026-09-24。范围：`noj-docs/docs/users/` 全量页面。
> 事实源：`noj-core/src/`、`noj-judge/`（含 Python SDK）、`noj-ui/`、`noj-lmcc-extension/`。
> 规范依据：`dev-docs/audit/2026-09-24-docs-readability-audit/RUBRIC.md`。

## 范围

| 文件 | 审计前 | 审计后 |
|------|--------|--------|
| `noj-docs/docs/users/index.md` | 16 行 | 24 行 |
| `noj-docs/docs/users/submit.md` | 64 行 | 93 行 |
| `noj-docs/docs/users/lmcc-extension.md` | 46 行 | 59 行 |
| `noj-docs/docs/users/capability.md` | 69 行 | 79 行 |
| `noj-docs/docs/users/results.md` | 47 行 | 54 行 |
| `noj-docs/docs/users/account.md` | 65 行 | 86 行 |
| `noj-docs/docs/users/ranking.md` | 3 行 | 3 行（重定向存根，未改） |
| `noj-docs/docs/users/search-messages.md` | 3 行 | 3 行（重定向存根，未改） |

未改动：`ranking.md`、`search-messages.md` 均为「已迁移至功能主题」重定向存根，无内容可审计（见「遗留问题」）。

## 正确性发现

### 已修正

| 位置 | 问题 | 证据（路径+符号） | 处置 |
|------|------|-------------------|------|
| `results.md`、`account.md` | `::: note` **不是 VitePress 内置容器**，页面把整段 `::: note ... :::` 原样渲染成字面文本（截图 `before-account.png` / `before-results.png` 可见） | VitePress 仅内置 `tip/info/warning/danger/details`；`before-results.png` 底部与 `before-account.png` 首次改密段 | 已修正：`results.md` 改为 `::: warning`；`account.md` 改为 `::: warning` |
| `submit.md` | 「编辑器侧栏实时显示**排队位置**与状态」与实际不符：编辑器侧栏 `EditorSidebar.vue` 只显示**状态徽章 + 已等待时长**，排队位置（`#n/N`）仅在**提交详情页**出现 | `noj-ui/components/editor/EditorSidebar.vue:168-207`；`noj-ui/pages/submissions/[id].vue:228`（`#{{ queue_position }}/{{ queue_length }}`） | 已修正：改为「显示状态徽章与已等待时长」，排队位置改述为提交详情页展示 |
| `submit.md` | 「提交记录页可按题目、语言、状态、**时间段**筛选」：界面筛选栏无时间范围控件，仅题目/提交编号/语言/状态 | `noj-ui/pages/submissions/index.vue:46-61`（filters 无时间字段）；API 侧 `routes/submissions.ts:78-79` 支持 `from`/`to` | 已修正：注明日期范围筛选仅 API 支持、界面以四项筛选为主 |
| `submit.md` | 代码限制只列 100KB，遗漏 API 响应层 **8KB 输出截断** | `noj-core/src/domains/submission/services/submissions/submissions-crud.ts:96`（`MAX_OUTPUT_LENGTH = 8*1024`）、`:604-608` | 已修正：限制项改为表格并补 8KB |
| `submit.md` | artifact 段未给出「题目配置上限 ∩ 系统硬上限」与默认硬上限 | `noj-core/src/domains/submission/services/submissions/artifact-submissions.ts:45`（`DEFAULT_ARTIFACT_MAX_SIZE_BYTES = 2GB`）、`:178-182` | 已修正：补充默认 2GB 与取小值规则 |
| `submit.md` | 自测状态描述含糊；应明确与正式提交同构 | `noj-core/src/domains/submission/types/self-tests.ts:12-19`（`pending/judging/finished/error`） | 已修正：补状态列表 |
| `account.md` | 头像「支持常见图片格式」无具体格式与体积上限 | `noj-core/src/shared/security/image-validation.ts:14`（`image/png|jpeg|webp`）；`users-avatar.ts:16`（`MAX_AVATAR_SIZE = 2MB`） | 已修正：写明 PNG/JPEG/WebP + 2MB |
| `account.md` | TFA 恢复码数量未说明 | `noj-core/src/domains/identity/services/security/tfa.ts:31`（`RECOVERY_CODE_COUNT = 10`） | 已修正：补充「共 10 个」 |
| `account.md` | 「二步验证」与标题「两步验证（TFA）」用词不一致；注销段用「二步验证」 | 同页内不一致；`noj-core/src/domains/identity/services/tfa.ts` 术语为 TFA/两步验证 | 已修正：统一为「两步验证」 |
| `account.md` | 邮箱验证重发限流未说明具体表现 | `noj-core/src/domains/identity/services/email-verification.ts:66`（`RateLimitedError(..., 60)`） | 已修正：以 `::: warning` 说明约 1 分钟间隔与提示语 |
| `account.md` | 封禁未区分 `platform` / `social` 范围 | `noj-core/src/domains/identity/middleware/auth.ts:81-98`（scope 判定）；`auth-login.ts:119-137` | 已修正：补 `::: info` 说明封禁范围 |
| `results.md` | mermaid 状态图缺少「入队失败 → error」路径 | `noj-core/src/domains/submission/services/submissions/submissions-crud.ts:511-521`（永久队列错误直接置 `error`） | 已修正：补虚线边 + `::: info` 说明 |
| `index.md` | 页面清单用不完整散点列表，且未指向本组新增的 capability 页 | 侧边栏 `config.ts:100-108` 列出 6 页，`index.md` 未列 capability | 已修正：改为表格，补 capability 页 |

### 建议（未改，需人确认）

| 位置 | 问题 | 证据（路径+符号） | 处置 |
|------|------|-------------------|------|
| 跨页（非 users/） | `mechanisms/runtimes.md:18` 称「题目可选的编程语言由出题人在运行时配置中声明，做题人页面只会看到该题启用的语言」，但 `RuntimeConfig` 无语言字段，真实 UI 硬编码 `[{ value: 'python3' }]` | `noj-core/src/domains/catalog/types/runtime-config.ts:32-35`（仅 evaluator/solution）；`noj-ui/components/editor/EditorWorkspace.vue:157` | 建议（未改，需人确认）：`mechanisms/runtimes.md` 属他组范围，应改为「当前固定 Python 3」 |
| 跨页（非 users/） | `features/ranking.md:28` 同样使用非法容器 `::: note`，渲染为字面文本 | 截图 `before-account.png` 同类问题；`features/ranking.md:28-30` | 建议（未改，需人确认）：由 features 组统一替换为 `::: info` |
| 跨页（非 users/） | 任务书提到的 `noj-docs/docs/features/capability.md` 不存在，capability 语义实际在 `mechanisms/capability-networking.md` | `ls noj-docs/docs/features/` 无 capability.md | 建议（未改，需人确认）：确认是否需补 features 索引入口 |

## 可读性改进

审计前整组容器使用**几乎为零**（仅 `submit.md` 有 1 个 `warning`），且所有 `::: note` 均失效。改进后：

| 页面 | 改动 | 理由 |
|------|------|------|
| `index.md` | 开头加导语引用块；页面清单改**表格**；功能主题改无序列表 | 提升一屏内可扫读性，明确每个入口讲什么 |
| `submit.md` | 开头加「一句话」引用块；「代码限制」改 **3 列限制表**；「常见错误」改**表格**（现象/原因/处理）；新增 `tip`（函数调用机制）、`warning`（调试看不到）、`warning`（artifact 约定）、`danger`（不可重测）、`info`（可见性）；补自测要点列表 | 把「不看会踩坑」的信息升级为容器；并列信息表格化，降低扫读成本 |
| `results.md` | 开头加一句话引用块；状态表补 `<Badge type="tip/danger" text="终态" />`；状态图补边；`note`→`warning`；新增 `info`（状态自动流转） | 行内标记终态、修复失效容器、补全状态机 |
| `account.md` | 开头加一句话引用块；新增 `warning`（重发限流）、`danger`（改密会话失效）、`warning`（首次改密）、`danger`（不得轮换密钥）、`info`（封禁范围）、`danger`（注销不可恢复）；格式/数量具体化 | 把不可逆操作与前置条件显式化为 danger/warning |
| `capability.md` | 开头加一句话引用块；`warning`（调用位置）；`tip`（控制调用次数与返回大小）；参数段补单帧 1MiB 约束 | 突出无网前提与调用约束 |
| `lmcc-extension.md` | 开头加「本页讲什么」；登录段新增 `tip`（令牌保存/槽位/首次改密）；等待参数改 `info` 并列出设置项键名；「常见问题」改表格 | 让登录与排障信息可扫读，键名可复制 |
| 全组 | 统一中文全角引号「」；统一 1–5 个容器/页，未给每段套容器 | 遵循 RUBRIC 第三节，避免容器滥用 |

容器统计：`submit.md` 5 个、`account.md` 6 个（含 3 个 danger，均为不可逆/高破坏操作）、`capability.md` 2 个、`results.md` 2 个、`lmcc-extension.md` 2 个。

## 视觉评价

截图目录：`/tmp/opencode/audit-shots/users/`（before-* 与 after-* 各 5–6 张，1440px 宽，Chrome 无头 + `--virtual-time-budget=12000`）。

- **改前**：整体是「一堵墙文字」，几乎没有视觉断点。`submit.md` / `account.md` 全靠 H2 分段，段内大量项目符号，重点靠加粗勉强区分；`results.md` 的 `::: note` 与 `account.md` 的「首次改密」直接渲染为 `::: note ... :::` 字面文本，明显是坏块（`before-results.png` 底部最刺眼）。
- **改后**：信息密度被容器与表格重新分层，扫读路径清晰。
  - `after-submit.png`：语言对照表 → 黄底运行时警示 → 绿底函数调用提示 → 黄底调试警示 → 三列限制表 → 双层 artifact（黄 warning + 粉 danger）→ 自测要点 → 蓝色可见性，层次与色彩语义一致，长页不再发闷。
  - `after-account.png`：不可逆操作（改密、密钥轮换、注销）统一粉色 danger，前置条件用黄 warning，视觉上能一眼区分「会踩坑」和「会毁数据」。
  - `after-results.png`：`finished` / `error` 行内补了绿/红「终态」Badge，mermaid 图补了入队失败边后状态机完整。
  - `after-capability.png`：代码块之间用容器分隔，参数类型用行内代码列表，读起来不累。
  - `after-lmcc-extension.png`：登录/令牌信息用绿色 tip，等待参数用蓝色 info，常见问题表格化后一屏可查。
  - `after-index.png`：从 5 条散点变成 5 行表格 + 分类列表，作为组首页更像目录。
- 未发现新引入的语法坏块：`:::` 均顶格成对，`<Badge>` 均闭合，表格列宽适中。
- 一处小瑕疵已自纠：`submit.md` 中 `**题目配置上限**与**系统硬上限**` 两个加粗紧邻 CJK 时渲染出现 `**` 残留，已改为「」表述（`after-submit.png` 复查通过）。

## 遗留问题 / 建议

1. **`users/ranking.md` 与 `users/search-messages.md` 是 3 行重定向存根**，侧边栏（`config.ts:100-108`）并不列出它们。保留是否必要需人拍板；若保留，建议后续直接删除（受本次「不新增/删除页面」约束，未处理）。
2. **日期范围筛选能力与 UI 不一致**：API `GET /api/v1/submissions` 支持 `from`/`to`（`routes/submissions.ts:78-79`），但提交记录页未暴露。已在 `submit.md` 如实注明；是补 UI 还是收敛文档由产品决定。
3. **语言标识的跨页不一致**（`mechanisms/runtimes.md:18` 称出题人可声明语言，实际 `RuntimeConfig` 无该字段、UI 硬编码 python3）。属他组页面，未越界修改，已在上表登记。
4. **`::: note` 在其他组页面仍会出现**（如 `features/ranking.md:28`），本次仅修复 users 组两处；建议编排者统一全仓库替换。
5. **用户名规则 3–30 位字母/数字/下划线**已核对 `routes/auth.ts:139`（`/^[a-zA-Z0-9_]{3,30}$/`），文档一致；但「角色 `user` / `admin` 等」较粗——RBAC 下还可能有自定义角色，是否展开取决于面向读者的需要。
6. **`capability.md` 的 capability 单次无超时**为源码语义（`capability.py:70-124` 无 per-call timeout，靠评测总超时兜底），已在「注意事项」明确；若未来 SDK 增加 `call_capability(timeout_ms=...)`，需同步更新。
7. **`submit.md` 自测入口文案**取编辑器工具栏「自测」（`EditorToolbar.vue:192`）；若 UI 改版需同步。

## 附：核对过的关键事实（未改动的确认项）

- 提交状态机四态与终态定义：`noj-core/src/domains/submission/types/index.ts:143-176`。
- 代码上限 100KB（字符）：`routes/submissions.ts:56,218`。
- 输出截断 8KB：`submissions-crud.ts:96`；artifact 硬上限默认 2GB：`artifact-submissions.ts:45`。
- artifact 入口 `submission.py`：`noj-judge/src/dual/mod.rs:385`；代码题入口 `main.py`：同文件 `:44,387`。
- artifact 不可重测：`submissions-rejudge.ts:78-79`。
- 邮箱验证 TTL 30 分钟、单次有效、重发限流：`email-verification.ts:18,61-67,110-133`。
- 密码重置 TTL 15 分钟、弱密码不消耗令牌：`passwordReset.ts:17-18,181-201`。
- 用户名 `^[a-zA-Z0-9_]{3,30}$`：`routes/auth.ts:139`。
- 密码强度 ≥8 位含大小写与数字：`auth-register.ts:28,43-69`（用户页未展开细则，无误）。
- 未验证邮箱仅阻止提交/自测/社区/私信：`middleware/auth.ts:53-63`。
- 改密使旧会话失效：`auth-password.ts:98-107`（`session_version + 1`）。
- 注销匿名化保留内容：`account-deletion.ts:38-67`。
- 头像 2MB / PNG-JPEG-WebP：`users-avatar.ts:16`、`image-validation.ts:14`。
- TFA 恢复码 10 个、重生成作废旧码：`security/tfa.ts:31`、`services/tfa.ts:244-290`。
- OAuth 邮箱匹配、唯一登录方式保护：`oauth.ts:643-660,719-741`。
- 插件默认等待 180s、设置项键名：`noj-lmcc-extension/package.json:147-167`。
- 插件只列公开代码题：`noj-lmcc-extension/src/api.ts:178-180`。
- capability 异常映射与 1MiB 帧上限：`noj-judge/sdk/solution/noj_solution_sdk/capability.py:30-48,102-107,127-148`；`noj_sdk_common/serialization.py:17`。
- Solution Host 自动注册顶层函数：`noj_solution_sdk/host.py:235-243`。
