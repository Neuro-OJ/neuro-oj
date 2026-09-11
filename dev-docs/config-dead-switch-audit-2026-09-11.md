# 配置死键审计（2026-09-11）

> 触发问题：管理后台的 `homepage_banner` 填了没效果。
> 结论：它是**死键**（写入正常但零读取点）。本报告按同一方法对注册表全量 122 项做了一次排查，
> 并给出反向盲区（代码在读、注册表没登记）清单。

## 1. 判定方法与口径

单一事实源：`noj-core/src/shared/config/settings-registry.ts` 的 `CONFIG_DEFINITIONS`
（共 **122** 项：runtime 52 / bootstrap 70；其中 `visible: false` 4 项为测试/开发专用）。

判定一个键是否"活"，看它有没有**读路径**，而不是有没有"写入/校验/展示"路径：

| 路径 | 是否算消费 | 说明 |
|---|---|---|
| `getSetting("<key>")` / `settingInt` / `settingBool` | ✅ 算 | runtime 走 `DB → env 兜底 → default`；bootstrap 走 env 快照 |
| `Deno.env.get("<env>")`（含 `envInt` / `envBool` / `inject`） | ✅ 算 | bootstrap 项的实际读点 |
| 动态键构造（模板字符串拼 env 名） | ✅ 算 | 需人工识别，见 §4 |
| 注册表自身声明 | ❌ 不算 | 只是元数据 |
| `scripts/check-env.ts` / `production-config.ts` / `test-parallel.ts` / `env-snapshot.ts` / 初始化模板 | ❌ 不算 | 仅"校验/快照/模板"，不代表行为被配置驱动 |
| 管理后台通用设置页（`noj-ui/pages/admin/settings.vue`）与 `GET/PUT /api/v1/admin/system/settings[/:key]` | ❌ 不算 | 通用 KV 编辑器，对任何键都一视同仁 |
| 测试文件 | ❌ 不算 | 只测"能存/能校验" |

排除后仍有零读取点的键 = 死键。

## 2. 结论速览

| 类别 | 数量 | 键 |
|---|---|---|
| A. 真死键（注册了、任何模块都不读） | 3 | `homepage_banner`、`rate_limit_login_enabled`、`smtp_from` |
| B. 登记错位（core 注册表登记，core 不读，别的服务读） | 9 | `NOJ_LLM_DEFAULT_{GLOBAL,USER,PROBLEM}_DAY_{CALLS,TOKENS,COST}` |
| B′. 同一机制漏登记（gateway 会读、注册表没有） | 3 | `NOJ_LLM_DEFAULT_*_MONTH_*`（3 个 scope 的 month window） |
| C. 半死/危险开关（能改、改了只产生拒绝） | 1 | `register_email_verify` |
| D. 反向盲区（代码在读、注册表未登记 → 后台不可见、check-env 不校验） | 4+ | `JUDGE_ENABLED`、`JUDGE_QUEUE`、`NOJ_LLM_BYOK_ALLOWED_HOSTS`、`OAUTH_GITHUB_SECRET` |

除上述 12 项（A 3 + B 9）外，其余 110 项都有真实读点（含 community_* 19 项、
content_review_* 8 项、rate_limit_* 14 项、storage 8 项等）；其中 `register_email_verify`
有读点但语义已失效，单列于 §5。

## 3. A 类：真死键

### A1 `homepage_banner`（runtime / maintenance）

- 声明：`settings-registry.ts:141`，type=text，default=`""`，env 兜底 `HOMEPAGE_BANNER`。
- 写入路径通畅：后台可改（runtime），`updateSetting` 会写 DB 并记审计；≤1000 字符校验见
  `system-settings.ts`（测试 `system-settings.test.ts:288`）。
- **零读取点**：全仓库不存在 `getSetting("homepage_banner")`；`noj-ui` 全域 0 匹配。
- 公开面也没暴露：system 域公开路由是显式白名单，只有 `/api/v1/data-policy`
  （`noj-core/src/domains/system/routes/index.ts:12-19`），前端拿不到该值。
- 首页顶部横幅实际由**公告轮播**驱动：`noj-ui/pages/index.vue:142-176` 读
  `GET /api/v1/announcements?per_page=5`（issue #231），与本键无关。
- 溯源：`git show 160bf6367`（issue #99 系统设置面板）中该键自引入起就只出现在
  "设置页可编辑列表"里，从未接线。
- 文档失实：`noj-docs/docs/operators/admin-guide.md:63` 写"`homepage_banner` 首页横幅内容"。

### A2 `rate_limit_login_enabled`（runtime / rate_limit）

- 声明：`settings-registry.ts:257`，default=false，env 兜底 `RATE_LIMIT_LOGIN_ENABLED`；
  `.env.example:151` 也做了注释声明。
- 登录限流的实际开关是**全局** `rate_limit_enabled`：`isRateLimitEnabled()`
  （`system/services/rate-limit-env.ts:60-66`）只读 `rate_limit_enabled`
  （`NOJ_ENV=test` 时例外），被 `identity/middleware/login-rate-limit.ts:60,88` 与
  `system/middleware/rate-limit.ts:85` 使用。
- 搜索限流另有 `rate_limit_search_enabled`（`search-rate-limit.ts`），登录却**没有**独立开关。
- 结果：后台把 `rate_limit_login_enabled` 打开/关闭都不影响任何行为 —— 想让登录不限流只能关总开关或调大阈值。
- 全仓库命中仅：注册表、`.env.example`、两个测试文件。

### A3 `smtp_from`（bootstrap / email）

- 声明：`settings-registry.ts:163`，env 键 `SMTP_FROM`，`.env.example:150` 有注释。
- 邮件 Provider 的发件人用的是**分 Provider 键**：`aliyun.ts:30`
  `getSettingOrThrow("alibaba_from_email", …)`、`tencent.ts:26`
  `getSettingOrThrow("tencent_from_email", …)`。`smtp_from` 从未被任何 Provider 读取。
- `system-settings.ts:175` 只对它做 email 格式校验（存量遗留校验分支）。
- 死锁更彻底：它是 bootstrap 项，`updateSetting` 直接拒绝后台写入
  （`system-settings.ts:493-498`：`由环境变量管理（bootstrap），请修改 .env 后重启`），
  而 `.env` 里设了也没人读 —— 写入侧和读取侧都是死的。
- 溯源：issue #99 时代邮件只有单一 Provider，后续拆分为 aliyun/tencent 后该键未清理。

## 4. B 类：登记错位与漏登记（`NOJ_LLM_DEFAULT_*`）

- noj-core 注册表登记了 9 个 `NOJ_LLM_DEFAULT_{GLOBAL,USER,PROBLEM}_DAY_{CALLS,TOKENS,COST}`
  （`settings-registry.ts:1166` 起，scope=bootstrap、visible=true），**noj-core 内部零读取点**。
- 真正的消费者在 **noj-llm-gateway**：`noj-llm-gateway/src/limits.ts:47-92`
  的 `fallbackQuota()` 用 `Deno.env.toObject()` + 模板字符串动态拼接
  `NOJ_LLM_DEFAULT_${scopeType}_${windowType}_CALLS|TOKENS|COST`。
  `docker-compose.prod.yml:207-215` 把这些 env 注入的是 `llm-gateway` 服务。
- 因此它们**不是全局死键**，但存在两个问题：
  1. 登记在 core 注册表 → 出现在 **noj-core** 管理后台「环境配置」只读面板，暗示它影响 core，实际不影响；改它只影响 gateway（且需重启 gateway，core 不重启）。
  2. registry **漏登记** gateway 实际支持的 month 窗口：`limits.ts:61-80` 的默认表包含
     `global/month`（71 行）、`user/month`、`problem/month`，
     即 `NOJ_LLM_DEFAULT_{GLOBAL,USER,PROBLEM}_MONTH_*` 共 9 个 env 无登记、后台不可见、
     `check-env` 不校验。
- 另注：`llm_quotas` 表有种子（`noj-llm-gateway/src/db/seed.ts:53-70` 的 `seedDefaultQuotas`），
  fallback 仅在缺行时生效，因此这些 env 是"兜底值"而非主路径。

## 5. C 类：半死/危险开关

### `register_email_verify`（runtime / auth，default=false）

- 注册表描述称："当前实现未完成，开启会 fail-closed 拒绝注册"。
- 实现：`identity/routes/auth.ts:155-161`，值为 true 时直接抛 `ValidationError` 拒绝注册。
- 但**验证链路其实早已落地**：注册即发验证邮件（`auth.ts:164`）、一次性令牌端点
  `/auth/email/verify`、重发端点、以及写操作强制校验 `emailVerified`
  （`identity/middleware/auth.ts:222` 的 `requiresVerifiedEmail(c)`）。
- 也就是说：这条"实现未完成"的前提已过期，该开关现在唯一的效果是**把注册彻底关死**，
  与它的名字（"开启注册邮箱验证"）语义完全不符。属于"看起来是配置、实际是地雷"。

## 6. D 类：反向盲区（代码读、注册表未登记）

这些 env 有真实读点，但不在 `CONFIG_DEFINITIONS` 中 → 管理后台「环境配置」面板看不到、
`check-env` 的注册表 ↔ `.env.example` 一致性校验覆盖不到（`check-env.ts:140-175`
只对 `.env.example` 里出现但未登记的键给"孤儿"警告，且对编排键有白名单豁免
`EXAMPLE_ORCHESTRATION_KEYS`）。

| env | 读点 | 影响 |
|---|---|---|
| `JUDGE_ENABLED` | `observability/services/judge-heartbeat.ts:37` | 关闭 judge 告警的开关；后台不可见 |
| `JUDGE_QUEUE` | `shared/mq/judge-queues.ts:13`、`noj-judge/src/config.rs:131` | 队列前缀，core/judge 必须一致，配错静默不通；后台不可见 |
| `NOJ_LLM_BYOK_ALLOWED_HOSTS` | `noj-llm-gateway/src/providers.ts:52` | BYOK 出网白名单（安全相关），完全未登记 |
| `OAUTH_GITHUB_SECRET` | `identity/services/oauth.ts:117` | 未登记的**旧别名**（`OAUTH_GITHUB_CLIENT_SECRET` 的 fallback）；注册表只登记了新名，别名在文档中无痕 |
| `NOJ_PROJECT_ROOT`、`NOJ_BACKUP_PASSPHRASE_FILE`、`E2E_*`、`NOJ_RUN_BROWSER_E2E`、`DEEPSEEK_*`（gateway 脚本/测试） | 各脚本 | 工具链/测试专用，可不登记，但建议显式标注 |

## 7. 处置建议

优先级从高到低（每条都可独立执行）：

1. **`homepage_banner`**：二选一。
   - 删除：从注册表移除 + 清理 `.env.example:153` 与 `admin-guide.md:63`，并更新
     `system-settings.test.ts` / `admin-settings.test.ts` 中的键清单；
   - 或接线：新增公开只读端点白名单（如 `/api/v1/site-config` 只放 banner）+ 首页渲染。
     注意会与现有公告轮播（issue #231）功能重叠，需先定优先级/展示位置。
2. **`rate_limit_login_enabled`**：要么在 `login-rate-limit.ts` 真正接入（与 `rate_limit_search_enabled` 对齐，
   独立于总开关），要么删除（推荐后者：总开关 + 阈值已足够）。
3. **`smtp_from`**：删除（Provider 分键已覆盖需求），同步清 `.env.example:150`、
   `system-settings.ts:175` 的专用校验分支与相关测试。
4. **`register_email_verify`**：明确语义。若确认验证链路已完整，直接删除该键；
   若要保留"强制验证"语义，应改名并改为"是否允许未验证用户注册"的正向开关，同时修正描述。
5. **`NOJ_LLM_DEFAULT_*`**：把 9 项从 core 注册表迁到 gateway 侧的配置说明（或标注
   "由 llm-gateway 消费"），并补齐 9 个 month 变体，避免"后台改了没用"的误导。
6. **D 类盲区**：把 `JUDGE_ENABLED`、`JUDGE_QUEUE`、`NOJ_LLM_BYOK_ALLOWED_HOSTS` 登记入注册表
   （bootstrap/visible），`OAUTH_GITHUB_SECRET` 别名要么删除、要么在注册表与 `.env.example` 中显式标注为已废弃别名。
7. **防复发**：`check-env` 目前是**单向**校验（bootstrap envKey 必须在 `.env.example`；
   `.env.example` 的键必须登记）。建议增加"注册表 runtime 键必须有读取点"的静态检查
   （可用本报告的排查脚本思路，纳入 CI），否则同类死键还会再生。

## 8. 复现方法（可自行复核）

```bash
# 注册表全量键清单
cd noj-core && deno eval -A 'import {CONFIG_DEFINITIONS as C} from "./src/shared/config/settings-registry.ts";
for (const d of C) console.log(d.scope, d.key, d.envKey ?? d.envFallback ?? "-")'

# 单键读路径检查（示例：homepage_banner / rate_limit_login_enabled / smtp_from）
rg -n 'getSetting\("homepage_banner"\)|HOMEPAGE_BANNER' --glob '!**/tests/**' --glob '!**/*.md'
rg -n 'rate_limit_login_enabled|RATE_LIMIT_LOGIN_ENABLED' --glob '!**/tests/**'
rg -n 'smtp_from|SMTP_FROM' --glob '!**/tests/**' --glob '!**/*.md'

# 登录限流真正读的开关
rg -n 'isRateLimitEnabled|rate_limit_enabled' noj-core/src

# 动态键构造（普通字面量搜索查不到，需单独看）
rg -n 'NOJ_LLM_DEFAULT' noj-llm-gateway/src noj-core/src

# 反向：代码读但注册表没有的 env
rg -no 'Deno\.env\.get\(\s*"[A-Z0-9_]+"' noj-core/src noj-llm-gateway/src noj-judge/src | sort -u

# 注册表 ↔ .env.example 一致性（需要 .env 存在）
cd noj-core && cp .env.example /tmp/.env && cp .env.example /tmp/.env.example
deno run -A scripts/check-env.ts --file /tmp/.env
```
