# Agent Note: 配置死键批次清理与读取点静态校验

Status: implemented

## Problem

管理后台的 `homepage_banner` 填了没有任何效果。顺着这条线索按「有没有**读路径**」的口径
对注册表全量排查，暴露出的不是个别疏忽，而是**缺少持续校验**：`scripts/check-env.ts`
只校验「键的声明是否对得上」（注册表 ↔ `.env.example`），从不校验「声明的键是否真的有人读」。
于是任何人新增一个注册表条目、只在后台展示而不接线，就能长期无人察觉——
`homepage_banner` 自 issue #99 起就这样存在至今。

排查结论（`dev-docs/config-dead-switch-audit-2026-09-11.md`）：

1. **真死键 3 个**：`homepage_banner`（首页横幅实际由公告轮播驱动）、
   `rate_limit_login_enabled`（真实开关是全局 `rate_limit_enabled`）、
   `smtp_from`（发件人走分 Provider 键 `alibaba_from_email`/`tencent_from_email`，
   且它是 bootstrap 项，`.env` 设了没人读、后台也被拒绝写入——读写双死）。
2. **登记错位 9 个**：`NOJ_LLM_DEFAULT_{GLOBAL,USER,PROBLEM}_DAY_{CALLS,TOKENS,COST}`
   登记在 core 注册表，但 core 内部零读取点——真正的消费者是 noj-llm-gateway，
   且是靠模板字符串**动态拼接** env 名读取（普通字面量搜索查不到，这也是它们长期隐身的原因）。
   同时 gateway 实际支持的 month 窗口变体（9 个）从未登记。
3. **危险开关 1 个**：`register_email_verify` 描述称「实现未完成，开启会 fail-closed 拒绝注册」，
   但该前提早已过期——验证链路（注册发信、`/auth/email/verify`、`/auth/email/resend`、
   `authMiddleware.requiresVerifiedEmail` 强制写操作校验）早已完整，
   它唯一的效果是把站点注册彻底关死，与名字表达的语义相反。
4. **反向盲区 4 个**：代码真实读取但未登记的 env——`JUDGE_ENABLED`、`JUDGE_QUEUE`
   （core 与 judge 必须一致，配错表现为评测任务**静默积压**）、
   `NOJ_LLM_BYOK_ALLOWED_HOSTS`（安全相关的 BYOK 出网白名单）、
   `OAUTH_GITHUB_SECRET`（未登记的旧别名）。

## Decision

**1. 先建校验，再清理（issue #500）。** 新增 `noj-core/scripts/check-config-usage.ts`
（`deno task check:config-usage`），补上两条方向相反的检查：

- **正向（死键）**：注册表可见键与网关声明键都必须有真实读取点；
- **反向（盲区）**：代码读取的 env 必须已登记，或在**显式**豁免清单中。

判定采用「键名作为字符串字面量出现在消费文件中」，而不是枚举访问器名。这是实测得出的：
按访问器名匹配会漏掉三类真实读取——映射表（`problem-field-guard.ts` 把题目字段映射到
注册表键）、本地封装（`num("content_review_risk_threshold", 80)`）、
本地 env 封装（`readPositiveIntEnv("NOJ_LLM_MAX_CALLS", …)`），
第一版脚本因此误报 43 个活键、又漏报 `smtp_from`（被它自己的校验分支掩盖）。
同时按审计口径排除「非消费」路径：注册表与网关声明自身、`check-env.ts`、
`production-config.ts`、`env-snapshot.ts`、`test-parallel.ts`、测试文件、
以及通用 KV 编辑器（`system-settings.ts` 与后台设置页）。
豁免必须写明理由：键级 `// config-usage: exempt <理由>`、文件级 `// config-usage: exempt-file <理由>`；
动态构造的键用 `dynamicPrefix` 声明前缀，集合一致性交给枚举测试。

**2. 删除三个死键与危险开关（#495 / #496 / #498）。**
- `homepage_banner`：从注册表移除，清理 `.env.example`、`admin-guide.md`、相关测试；
  文档改为说明「首页横幅由公告驱动」。
- `rate_limit_login_enabled`：删除（全局总开关 + 阈值 + 锁定阈值已足够表达策略，
  多一个不生效的开关只增加误配面）；在注册表原位留注释说明为何没有独立开关。
- `smtp_from`：删除，并移除 `system-settings.ts` 中专用的 email 格式校验分支
  （该分支正是让死键「看起来被使用」的原因）与随之无用的 `EMAIL_RE`。
- `register_email_verify`：删除。连带移除 `auth.ts` 的 fail-closed 分支与
  `RegisterInput.email_code` 字段，并删掉 `auth-dead-switches.test.ts` 中对应用例。

**3. 网关侧声明，落实「谁读谁声明」（#497）。** 新增
`noj-llm-gateway/src/config-registry.ts`：把 18 个配额 env
（`SCOPE{GLOBAL,USER,PROBLEM} × WINDOW{DAY,MONTH} × FIELD{CALLS,TOKENS,COST}`）
与 BYOK 白名单、服务密钥等一并声明；9 个 `NOJ_LLM_DEFAULT_*` 从 core 注册表迁出，
core 后台不再出现这些键（避免「在 core 改了、却要重启 gateway」的误导）。
`limits.ts` 导出 `QUOTA_ENV_KEYS` 作为实际读取集合的单一事实源，
`tests/config_registry_test.ts` 用 4 条断言钉死「声明集合 == 读取集合」，
使「新增窗口忘登记」变成一次可发现的失败。README 补充配额小节（含生效条件与重启对象），
两份 env 模板补齐 month 变体。

**4. 补登记盲区（#499）。** `JUDGE_ENABLED`、`JUDGE_QUEUE` 登记入 core 注册表
（bootstrap / visible，含默认值与「必须与 noj-judge 一致」的说明）；
`OAUTH_GITHUB_SECRET` **保留**并登记为「已废弃别名」（而非删除——
全仓无部署默认设置过它，但删除会让误用过该别名的部署在升级后**静默**失去 GitHub 登录）；
工具链/测试专用 env 归入 `REVERSE_EXEMPT` 显式清单。

**5. 接入 CI。** `deno.json` 增加 `check:config-usage`；CI 新增独立的
`config-usage-check` 作业（5 分钟超时）。没有并进 `core-check`：该脚本同时扫描
core / ui / gateway 三个模块，路径过滤与 core-check 不同，因此 `changes` 作业增设
`config` 输出专门覆盖这三处。

## Alternatives considered

- **只清理死键、不加校验（不做 #500）。** 治标不治本：`homepage_banner` 存在数月无人发现的
  根本原因就是没有持续校验，清理完同一模式会立刻再生。故先建护栏再清理。
- **正向检查沿用「访问器名 + 参数」匹配。** 实测误报 43 个活键、漏报 `smtp_from`。
  改为字面量判定 + 非消费路径排除。取舍：字面量判定理论上可能把「注释里提到某键」当消费，
  已用剥离注释缓解；宁可漏报也不误报（漏报由反向检查与人工评审兜底）。
- **把 `NOJ_LLM_DEFAULT_*` 留在 core 注册表、只在 description 里标注消费方。**
  改动更小，但 core 后台仍会展示 18 个「改了不影响 core」的键，误导性只是被文字稀释而非消除。
  选择迁出（评审确认）。
- **在 core 后台额外渲染只读的「由 llm-gateway 消费」区以满足 #499 的「后台可见」。**
  评审选择严格「谁读谁声明」：网关键只在网关侧声明，可发现性由网关 README +
  跨服务校验保证。
- **删除 `OAUTH_GITHUB_SECRET` 别名（issue 给的另一选项）。** 更干净，但会让曾使用该别名的
  部署静默失去 GitHub 登录（登录按钮消失、无报错）。保留 + 显式标注为「已废弃」是更安全的默认，
  并在 `.env.example` 写明迁移方向。
- **把 `check:config-usage` 并进现有 `check-env.ts`。** 两者的触发条件与扫描范围不同
  （前者纯静态、跨三模块；后者需要 `.env`、只看 core），合并会让路径过滤失准。
- **#496 选择「真正接入登录限流独立开关」。** 需额外维护两条测试路径，而现有
  总开关 + 阈值 + 锁定阈值已能表达全部策略；删除更符合「少一个误配面」。

## Consequences

- `deno task check:config-usage` 通过：**112 个 core 注册表键 + 9 个网关声明键均有读取点，
  未发现未登记 env**。修复前它精确报出 12 个死键 + 3 个盲区且零误报，
  可作为 issue #500「能复现审计结论」验收项的实测证据。
- 注册表从 122 项收敛到 112 项（删除 13：3 死键 + 1 危险开关 + 9 错位；新增 3：2 judge + 1 别名）；
  runtime 52→49、bootstrap 70→63。
- `check-env` 一致性无孤儿/缺失 finding；后台设置页不再出现已删除的键。
- CI 新增必过项 `Config Usage Check`；任何人再提交「只登记不接线」的键都会当场失败。
- 网关的 18 个配额键完整可查（含此前漏登记的 month 变体），且声明与 `limits.ts`
  的实际读取集合由测试钉死。
- 测试结果：`test:domain system` 113 passed、`test:domain identity` 288 passed、
  `test:domain observability` 19 passed；网关 50 passed。
- 未做 / 已知问题（记录备查）：
  - `test:domain system|identity` 各有 1–2 个 `search event: … upsert` 用例失败，
    **与本次改动无关**：本地 noj-core dev 进程的 BRPOP 消费者会抢在测试 2 秒断言窗口前
    取走 `noj:search:index` 事件（已实测：手动 LPUSH 后队列长度立即归零）。
    该问题在改动前的 HEAD 上同样存在。CI 环境无此消费者，故不受影响。
  - 反向检查的 `REVERSE_EXEMPT` 目前内联在脚本中；若后续豁免项增多，可考虑抽为独立清单文件
    （当前 30 项左右，内联仍可读）。
  - `register_email_verify` 删除后，若未来要提供「禁止未验证邮箱用户注册」的能力，
    需要按正向语义重新设计开关（返回可解释错误码），
    而不是恢复旧的 fail-closed 行为。
