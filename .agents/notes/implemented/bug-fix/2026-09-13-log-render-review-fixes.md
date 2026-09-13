# Agent Note: 修复日志渲染评审发现的脱敏失效、测试竞态与 CLI 着色盲区

Status: implemented

## Problem

PR #504 的评审（chenmou2012，2026-09-13）指出统一日志渲染迁移仍有 4 处缺陷，
其中两处会造成**静默失效**——表面全绿，实际防线不存在：

1. **`production` 参数不参与脱敏（P1，真缺陷）**
   `formatPretty(values, { production: true })` 接收了该参数，但其内部的
   `redactValueByKey` / `redactFields` / `renderableMessage` /
   `renderableFields` / `serializeValue` 全都只读全局 `isProduction()`（即
   `NOJ_ENV=production`）。 于是在非生产进程里显式要求生产渲染时，`api_key`
   等敏感字段**明文输出**。 实测（`NOJ_ENV` 未设置）：

   ```
   formatPretty(values, { color: false, production: true })
     → INFO submission 入队 submission=550e8400-...  api_key=sk-live-SECRET
   ```

   配套的 `scripts/check-log-parity.ts`「生产脱敏」fixture 只给 **core** 传了
   `production`，gateway 那侧根本没传，且两侧都靠全局 env → 该 fixture
   实际验证的是 「两边同样没脱敏」，属假通过。

2. **日志配置测试存在 env 竞态（P1，结构性风险真实存在）** `log-config.test.ts`
   / `log-format.test.ts` 用 `Deno.env.set` 改写进程级 env。
   `deno test --parallel` 下**所有测试文件共用同一进程**（实测两个文件
   `Deno.pid` 相同），env 是进程级全局，于是并发用例互相覆盖。实测复现：

   ```
   deno test --parallel tests/shared/log-config.test.ts tests/shared/logging_test.ts \
                         tests/shared/log-format.test.ts
   → FAILED | 43 passed | 1 failed   （log-config: LOG_COLOR=always 强制开色）
   ```

   注：仓库默认的 `bash scripts/test-shared.sh` 是**串行**的，10 次连跑均 233
   passed / 0 failed，因此该失败只在 `--parallel`（或未来改用并行）时显形——
   但它确实是"改一次运行方式就翻车"的隐患。

3. **`--color` 吞掉模块参数（P2）** `parseMaintainArgs` 对 `--color` 后任意「非
   `-` 开头」的参数都当作颜色值消费：

   ```
   parseMaintainArgs(["--color", "server"]) → modules: undefined
   ```

   即 `maintain logs --color server` 丢失目标服务。

4. **顶层 `noj-cli logs` 未被覆盖（P2）** 此前修的是 `maintain/logs.ts`，但
   README 记载的生产命令 `noj-cli logs core` 走的是另一条链：`noj-cli logs` →
   `production.ts::runProduction` → `scripts/deploy/production.sh` →
   `deploy.sh::logs()` → `docker compose logs`。 该函数**完全不感知** `NO_COLOR`
   / TTY，`noj-cli logs core > out.txt` 仍会把 ANSI 转义码写进重定向文件。

## Decision

1. **把 `production` 显式贯穿整个渲染与脱敏链**（core 与 gateway 两侧同步）：
   `serializeValue` / `redactValueByKey` / `redactNested` / `redactFields` /
   `renderableMessage` / `renderableFields` / `makeJsonFormatter` 均新增
   `production: boolean = isProduction()` 参数并逐层下传；`formatPretty` 与
   `makeGatewayPrettyFormatter` 把 `opts.production` 传给内部调用点。
   `setupLogging` 只解析一次 `isProduction()` 后显式注入，渲染层不再自行读全局
   env。 默认值仍为 `isProduction()`，因此既有调用点行为不变。

2. **测试改为「显式注入」，彻底不碰进程级 env**。 `log-format.test.ts` 的 11 处
   `withEnv({ NOJ_ENV: ... })` 改为块内 `const production = ...`
   注入。`log-config.test.ts` 的做法被**两轮评审 先后否决**，最终同样改为注入：

   - 第一版用 `Deno.env.set` + try/finally 恢复；
   - 第二版加了一把**模块级**互斥锁想串行化临界区——**这不成立**：
     `deno test --parallel` 下多个测试文件共用同一进程（实测同 pid、共享
     `Deno.env`），但**每个文件有独立的模块实例**（实测：同一共享模块里的
     随机标记在两个文件中不同）。因此模块级锁对象根本不共享，挡不住其它
     文件的并发写入；实测加锁后仍 12/60 次失败。
   - 真正的修复是给 `resolveColor` / `resolveFormat` / `describeColorPolicy` /
     `isProduction` / `resolveLevel` 加可注入的 `EnvReader` 参数，并让
     `setupLogging` / `setLogSink` / `toCompatRecord` 一并接受它。测试用查表
     函数构造环境；`logging_test.ts` 同样改造完毕。 结果：同一组用例 80 次连跑
     **0 次失败**（改造前 13/60）。

3. **`--color` 仅在该值确属颜色模式时才消费下一个参数**：新增
   `COLOR_MODES`（`auto|always|never`）作为单一事实源，`cli.ts` 用它判定；裸
   `--color` 与非法值都视为强制开色且**不吞参**（非法值保留为位置参数）。

4. **`deploy.sh::logs()` 补着色判定**，与 core / gateway / judge / noj-cli
   同一契约：`NO_COLOR` 非空 → `--no-color`；`LOG_COLOR=never` → `--no-color`；
   `LOG_COLOR=always` → **全局 `--ansi always`**；其余按 `[[ -t 1 ]]` 探测。
   `LOG_COLOR` 做 trim + 小写，与 TS 侧一致；读取顺序为进程 env → `.env.prod`
   （生产以 `.env.prod` 为配置源，`.env.prod.example` 正是把 `LOG_COLOR`
   列为着色开关）。

   **复审修正**：初版在 `always` 分支只是"不加 `--no-color`"，并不等于开色——
   `docker compose logs` 只提供 `--no-color`，省略它只是把决定权交回 compose
   自身的 TTY 探测（与 TS 侧无 TTY 仍返回 true 的语义不一致）。现改为插入
   子命令**之前**的全局 `--ansi always`。

5. **给 parity 门禁补「有效性断言」并加固**（防假绿灯）：新增
   `assertProductionRedaction()`。初版被复审证明可绕过，已三重加固：

   - **两个运行时的输出都断言**（含 gateway）。初版只查 core，于是把 gateway 的
     production 接线还原成读全局 env 后两侧恰好一致、门禁照样报通过—— P1-B
     的确切失效形态漏检；
   - **哨兵值从 fixture 自身推导**（uuid / 邮箱字面量），不再硬编码副本。
     硬编码时改掉 fixture 里的明文就会让断言静默失效；
   - **必须至少有一个 `production: true` fixture**，否则直接失败。初版删掉该
     标记即可在"零断言"下报绿。

   同时 parity 现在跑**两条渲染路径**：直接调 `formatPretty`，以及走各模块
   真实的 formatter 构造器——只测前者测不到"构造器忘记下传 production"。

6. **补齐 gateway 的 production 接线与测试**：`setupGatewayLogging()` 此前调
   `makeGatewayJsonFormatter()` / `makeGatewayPrettyFormatter({ color })` 时
   **不传 `production`**，新增的 ctor 形参在生产路径上是死代码（且无测试
   覆盖）。现已传入，并新增以 `production:` 参数驱动的用例（此前该文件
   `production:` 出现 0 次，全部依赖 `withEnv` 改 `NOJ_ENV`）。

7. **对齐 `formatErrorDetail` 的跨运行时差异**：core 在无 `stack` 时补 `name`
   （`error: TypeError: boom`），gateway 不补（`error: boom`）。生产会剥掉
   stack，因此**生产环境每条非 `Error` 命名的错误都渲染不一致**。已对齐并
   新增专门 fixture（`name: "TypeError"` 且无 stack）锁住。

## Alternatives considered

- **只给 `formatPretty` 加参数、内部仍读全局 env**：这正是原缺陷的形态本身；
  参数形同虚设，评审指出的「静默失配」依旧存在。
- **把 `isProduction()` 改成可注入的模块级可变状态**：引入新的进程级全局，
  与「多副本约束」及本次要修的竞态同类；显式传参更干净。
- **测试统一改用 `--no-parallel` 或强制串行**：等于放弃并行能力来掩盖问题，
  且无法阻止未来有人在并行下运行；注入 + 锁才是消除根因。
- **`--color` 非法值直接报错退出**：会破坏「未知旗标不致命」的既有宽容行为，
  也让 `--color server`（本意是位置参数）变成硬错误；保留为位置参数更稳。
- **顶层 `logs` 改为走 TS 侧 `maintain/logs.ts`**：会改变生产命令的语义与
  实现路径（生产与 JSON 部署两套体系），超出本次缺陷修复范围；在 `deploy.sh`
  内补判定即可覆盖同一缺陷类。

## Consequences

- 脱敏不再依赖「进程恰好是生产」：显式 `production` 在 core 与 gateway
  都真正生效。 反向验证：把 `formatPretty`
  改回忽略该参数后，新增断言**确实失败** （parity 门禁报出明文 uuid 与
  `a@b.com`）。
- `--parallel` 下相关日志测试从 1 failed 变为 44 passed（3/3 次稳定）。
- `parseMaintainArgs(["--color", "server"]).modules === "server"`（原为
  `undefined`）。
- `noj-cli logs core > out.txt` 不再写入 ANSI 转义码；`LOG_COLOR=always`
  仍可强制着色。
- 回归防线均经反向验证（故意还原缺陷 → 测试确实变红），不是恒真断言。
- 新增测试：`parseMaintainArgs` 颜色解析用例、`test-deploy.sh` 的 5
  个着色契约用例、 parity 的 production 有效性断言。
