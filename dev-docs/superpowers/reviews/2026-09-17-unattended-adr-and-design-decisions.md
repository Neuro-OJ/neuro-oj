# 无人值守交付报告：ADR 与产品设计决策

本报告汇总本轮无人值守（8 小时）期间为完成 7 个 issue 所做的**架构与产品设计决策**，
以及每个决策的证据与代价。所有决策均已在对应 issue/PR 中发评论说明。

---

## 一、最重要的发现：两个 CI 门禁缺陷（阻断所有 PR）

### ADR-1：E2E/UI Components 红灯的根因是 **Deno 2.9.7 发布**，不是代码问题

**症状**：多个 PR 的门禁间歇性/确定性红灯，但**测试全部通过**。

**排查过程**（关键：不采信「偶发抖动」这一最初假设）：

1. 锁定 `BrokenPipe` 与 `lockfile origin` 两类错误；
2. 下载 Deno 2.9.5 / 2.9.6 / 2.9.7 三个真实二进制做 A/B 实测：

| Deno | `vitest run` 失败次数 |
| --- | --- |
| 2.9.5 | 0 / 6 |
| 2.9.6 | 0 / 6 |
| 2.9.7 | **4 / 6**（另一次采样 7/8） |

3. 核对发布时间：**v2.9.7 于 2026-09-17 09:04 UTC 发布**，恰好落在「绿灯的旧运行」
   与「红灯的新运行」之间。

**结论**：CI 用浮动的 `deno-version: v2.x`，新版本自动生效即引入回归。

**决策**：引入 **`.dvmrc` 作为 Deno 版本的唯一事实源**，28 处声明全部改为
`deno-version-file: .dvmrc`，并新增 `scripts/check-deno-version.ts` 门禁
（接入 Root Gates，禁止再写死 `deno-version:`，并强制 Dockerfile 镜像版本一致）。

**为什么不是「只把 v2.x 改成 v2.9.5」**：那会留下 28 份重复字面量，
下次升级仍需改 28 处且可能再次漂移。门禁在实现过程中**实际抓出**
`noj-core/Dockerfile.e2e` 停留在 `2.8.0` 的真实漂移。

**代价**：精确 pin 后不再自动跟进 Deno 补丁发布。**缓解属人工流程**——
`.github/dependabot.yml` 没有 deno ecosystem，且 `github-actions` ecosystem
不修改 action 的 `with:` 入参，因此 Dependabot **不会**提 Deno 升级 PR。
这一点已在 Agent Note 中如实写明（初版曾错误声称 Dependabot 可缓解，经评审指出后修正）。

### ADR-2：`noj-tests/deno.lock` 的镜像 tarball —— 重新生成而非手工编辑

**根因**：锁文件由配置了 npmmirror 镜像的机器生成，6 个 npm 包的 `tarball`
字段写死镜像地址；Deno 新版收紧 origin 校验后直接拒绝读取。

**初版做法（错误）**：手工删除 `tarball` 字段。这能修好 CI，但**违反 AGENTS.md §8.1
与 CONTRIBUTING.md 明文红线**（禁止手动修改 `deno.lock`），且留下手工格式痕迹
（`os` 数组被展开成多行，`deno fmt` 与新生成都不会这样排）。评审以确定性证据指出后改正。

**最终决策**：用 `NPM_CONFIG_REGISTRY=https://registry.npmjs.org` **重新生成**锁文件。
代价是两个依赖被提升到 semver 允许的新版本：

| 包 | 变更 |
| --- | --- |
| `otpauth` | 9.5.1 → 9.5.2（patch） |
| `@noble/hashes` | 2.2.0 → 2.4.0（minor，传递依赖） |

两者都满足既有 `npm:otpauth@9` 范围，E2E 全量通过。**不提升只能靠手工编辑，代价更大。**

---

## 二、#511 题目页信息架构重构的设计决策

### ADR-3：统一视图模型而非两套内联逻辑

独立题目接口返回 `Problem`，竞赛接口返回 `ContestProblem`，形状不同
（`id` vs `problem_id`；竞赛题无 `type`/`runtime_config`/`tags`/`owner_username`）。

**决策**：新增 `utils/problemView.ts` 归一为 `ProblemView`，组件只面对一种形状。
放 `utils/` 而非组件内，遵循仓库「纯逻辑放 utils、可被 `deno task test` 断言」的既有约定。

### ADR-4：竞赛题时限/内存用 `null` 表达「该来源不提供」，不用 `0` 顶替

竞赛接口根本不返回 `runtime_config`。若沿用独立页写法会渲染 `0ms`/`0MB`，
**被误读为真实限制为 0**。改为 `null`，由头部隐藏该项；单测固定此契约。

### ADR-5：工具条按形态门控，而非组件内判断角色

`ProblemStatement` 需同时服务「独立页可进编辑器」与「竞赛页受门控、无入口」。
**决策**：`editor-to`/`edit-to` 传 `null` 即不渲染，门控语义留在页面，组件保持纯展示可测。
用接口复杂度换长期一致性。

### ADR-6（评审修正）：难度徽章必须在共用头部渲染

**发现**：初版把难度只留在独立页右栏的 `ProblemMetaCard`，而竞赛页不挂载该卡片，
导致**竞赛页难度彻底消失**——相对重构前是回归，且与 PR 自述「难度统一走 `DifficultyBadge`」矛盾。

**修正**：把 `DifficultyBadge` 放进 `ProblemHeader`，两种来源都可见，难度色仍只有一处。

### ADR-7（评审修正）：竞赛页题面不折叠

**发现**：重构前竞赛页渲染完整 `MarkdownRenderer`；改用共用组件后默认
`collapsible=true && expanded=false` 会把题面**截断到 384px**，属未记录的回归。

**修正**：竞赛页显式传 `:collapsible="false"`（竞赛场景需要一眼看全题面）。

---

## 三、#512 全局面包屑的设计决策

### ADR-8：不引入全局中间件（与 issue 初稿的技术方案不同）

issue 建议用中间件预置 `useState`，理由是「布局渲染早于页面 setup，靠页面写 state 会让 SSR 首帧为空」。

该论证针对的是**「页面在 setup 里写整条层级」**。而层级本身是 `route.path` 与 `locale` 的
**纯函数**——布局组件在 SSR 首帧就能直接算出，**既不需要 state 也不需要中间件**。

**收益**：少一处 SSR/客户端双跑的分歧点。

### ADR-9：动态文案「注册表先占位、页面再精化」

async 数据必然晚于布局渲染。注册表先给出路由参数（如 `1001`），页面用
`useBreadcrumbLabel` 回填。覆盖值按「路径 + 参数名」分键，随页面卸载清理。

### ADR-10（评审修正）：动态求值必须延迟到 setup 之后 —— 否则 SSR 500

**这是本轮最严重的缺陷**。页面里 `useBreadcrumbLabel(() => detail.value?.title)`
很可能写在 `const detail = ref(...)` **之前**（评审实测两页如此）。
初版 composable 用**立即执行**的 `watchEffect`，同步求值时抛
`ReferenceError: Cannot access 'detail' before initialization`；
这两页无 `ssr:false`，**服务端渲染直接 HTTP 500**。

**修正**：只在 `import.meta.client` 下、且 `onMounted` / post-flush 后求值。
理由是延迟求值**没有任何功能损失**：布局渲染早于页面 setup，覆盖值本就无法影响 SSR 首帧。
并补了一个覆盖「ref 声明前调用」的集成测试（此前测试全绿却漏掉，
因为只测纯函数、且组件测试 stub 掉了 `useBreadcrumbItems`）。

### ADR-11（评审修正）：单层页面不能只有面包屑

`/settings` 在注册表中是**单层**，而 `BreadcrumbNav` 对单层不渲染（避免占用首屏）。
初版删掉了该页唯一的「返回个人主页」链接，导致**完全没有返回导航**。
**修正**：恢复该链接——单层页面的返回入口与面包屑不构成重复。

### ADR-12：宽度跟随页面容器

各内容页容器宽度不一致（860px / 960px / 4xl / 7xl），面包屑若固定宽度会与标题错位。
**决策**：页面用**可序列化**的 `definePageMeta({ breadcrumbWidth })` 声明，
未声明时取 960px。`route.meta` 在 SSR 首帧即可读，无需额外全局状态。

### ADR-13：Phase 4 漂移门禁（issue 要求，且立即产生价值）

遍历 `pages/` 还原路由模式，断言每个内容页都有层级映射；白名单反向断言不渲染。
**门禁立即抓出 4 个 issue 层级表未列出的页面**（`/search`、`/settings`、`/about`、`/data-policy`）——
正是「没有门禁必然漂移」的证明。

---

## 四、#517 / #518 noj-cli 的设计决策

### ADR-14：退出码分层 0/1/2，作为可脚本化的稳定契约

`0` 成功 / `1` 运行失败 / `2` 用法错误。新增 `UsageError` 承载「用法错误」。
这解决了调用方无法区分「参数写错」与「命令跑了但失败」的实际痛点。

### ADR-15（评审修正）：`--help` 必须优先于一切副作用，且豁免 profile 门控

初版为让非 TTY 场景可用，加了一个 `--yes` 逃生阀。**评审实测**：它并非已实现的
非交互模式——向导仍逐个提问，读不到输入时**无限循环刷屏（10 秒 237 万行）**，
比修复前更糟，且与 `nonInteractiveAdvice` 推荐的命令自相矛盾。

**修正**：**移除逃生阀**，非 TTY 一律明确拒绝并给替代路径。
同时 `--help` 豁免 profile 门控——它不执行任何动作，用户在「模式不匹配」时也应能读到帮助。

### ADR-16：不迁移到 Cliffy（沿用 issue 结论）

`parseProductionArgs` 刻意的「只消费 `--dir`、其余原样转发」透传语义与 Cliffy 的
解析模型冲突（Cliffy 会尝试解析所有参数）。保留手写解析，只补 help/错误/退出码。

### ADR-17：profile 探测失败必须报错，不得静默取默认值

优先级：`--profile` 显式值 > prod 探测 > stack 探测 > **报错**。两者同时命中亦报错。
理由：猜错模式会把命令作用到**错误的目标**（例如对 JSON 编排目录执行生产备份），
代价远高于让用户显式传一次参数。

### ADR-18（评审修正）：`--profile` 必须**真正参与分发**

**发现**：初版只在显式给出时做值校验，自动探测那条链（含「歧义/未命中必须报错」）
在真实 CLI 中**完全不可达**——`resolveProfile` 零调用者。评审复现：混合目录下
`status` 静默按生产路径执行。

**修正**：无显式值时也执行探测并要求命令与判定结果相容；
纯工具命令（`version`/`problem`/`doctor`）与 `--help` 豁免。

### ADR-19（评审修正）：Tier 3 属 prod 侧，不在 stack 侧

初版把 `db`/`init`/`bootstrap`/`problems`/`search` 全归为「JSON 编排」，
**方向写反了**——这些命令需要生产安装目录（`docker-compose.prod.yml` + `.env.prod`）。
修正后 `--profile prod db migrate` 放行、`--profile stack db migrate` 被拒。

### ADR-20（评审修正）：CLI 自有安装目录选项改名 `--install-dir`

**发现**：`--dir` 存在**双语义冲突**——noj-cli 用它指安装目录，而容器内的 noj 用它指
子命令参数（如 `problems import --dir <包目录>`）。统一按 CLI 语义剥离会让用户
**永远无法把包目录透传进容器**。

**修正**：CLI 自身选项改名 `--install-dir`，容器侧 `--dir` 原样透传，
并让 Tier 3 的 help 与实际选项一致（初版 help 写 `--dir`、代码只认 `--install-dir`）。

---

## 五、#514 题目包 CLI 的设计决策

### ADR-21：校验逻辑复制两份 + 共享 fixture 契约（issue 已决策，但补偿必须交付）

**决策**（沿用 issue）：`noj-core` 与 `noj-cli` 各持一份，保持 `noj-cli` 零外部依赖。

**补偿（issue 硬要求，本 PR 交付）**：
1. 7 个 vendored 文件文件头写明「刻意副本 + 原始路径 + 同步检查方式」；
2. `fixtures/problem-bundle-manifest.json` 放**仓库根**，两侧测试都对它断言
   （3 正例 + 9 反例），**任一实现漂移即红灯**；
3. 复制成本显式记录（2 处导入修正）。

### ADR-22（评审修正）：模板文件必须**排除**出包

**发现**：初版把 `template.py` 打进包，理由是「模板要进包供前端编辑器使用」。
但规范 `problem-bundle.md:26` 明确「模板文件与参考实现**不要**放入包中」，
旧 `noj.ts:resolveTemplateExclude()` 也执行排除；且编辑器模板实际由
`getProblemTemplate()` 从 `data/problems-src` 读取，**不从包里读**。

**修正**：模板与 `submission*`/`__pycache__`/`.git` 一并排除；测试同步改正
（初版把错误行为固化成了断言）。

### ADR-23（评审修正）：TUI 引导必须真正实现

**发现**：issue 与 PR 描述都声称交付了 TUI 引导，实测 `problem init` 无参数时
**只打印一行提示就退出 2**，`--no-interactive` 是 no-op，`problem/` 下零 TUI 引用。

**修正**：复用既有 `PromptIO` + `widgets`（这正是 issue 所指「TUI 能力闲置」的正解）
实现 `guideProblemInit`，与 `--no-interactive` 双模式并存。PTY 实测通过（生成 7 个文件）。

---

## 六、被拒绝的替代方案（汇总）

| 决策点 | 拒绝的方案 | 理由 |
| --- | --- | --- |
| Deno 版本 | 只把 `v2.x` 改成固定值 | 留下 28 份重复字面量，必然再次漂移 |
| Deno 版本 | 接受间歇失败靠重跑 | 会训练审查者忽略红灯，比没有门禁更糟 |
| 锁文件 | 手工删 `tarball` 字段 | 违反 AGENTS.md 明文红线 |
| 面包屑 | 全局中间件 | 层级是纯函数，中间件徒增 SSR/客户端分歧点 |
| 面包屑 | 面包屑 + 等价返回链接并存 | issue 明确要求收敛，避免两套导航 |
| 速度徽章 | 竞赛页挂 `ProblemMetaCard` | 会引入右栏布局，改变竞赛页信息架构 |
| noj-cli | 迁移 Cliffy | 与「只消费 --dir、其余透传」语义冲突 |
| noj-cli | 保留 `--yes` 逃生阀 | 实测导致无限循环刷屏，比修复前更糟 |
| noj-cli | profile 探测静默取默认 | 猜错模式会作用到错误目标 |
| noj-cli | 删除 `deploy`/`maintain` 旧名 | 破坏既有脚本；改为别名 + 废弃提示 |
| 题目包 | 跨目录直连 noj-core | 会绑定主仓库导入映射，无法脱离运行 |
| 题目包 | 抽共享 workspace 包 | issue 决策不引入，保持零外部依赖 |

---

## 七、遗留问题（明确未做，需后续跟进）

1. **锁文件根因未消除**：配置镜像的机器再次 `deno install` 仍可能写回镜像地址，
   需要「锁文件不得含非官方 registry」的 CI 守卫。
2. **#515/#516 范围**：#515 的纯逻辑层（索引识别、口令策略、list/prune）已实现并测试，
   但 `backup` 顶层命令接线、`restore --dry-run`、`schedule` 通用化、
   以及 #516 的 `drill` 真实恢复演练（依赖 #515）尚未完成。
3. **`.dvmrc` 门禁覆盖范围**：仅含 CI 与 `noj-core/Dockerfile*`；
   `noj-ui`/`noj-llm-gateway` 的 Dockerfile 已纳入，但其他版本来源（如文档示例）不强制。
4. **面包屑描述口径**：注册 32 条路径中实际渲染（≥2 层）的是 17 条，
   Agent Note 与 PR 描述中「26 个内容页获得多层导航」的表述不够精确，已在复盘记录。
