# Agent Note: 生产 logs 迁移着色契约并接线实时跟随

Status: implemented

## Problem

bash `scripts/deploy/deploy.sh:1117-1158` 的 `logs()` 有一套**明确**的着色优先级，且有
评审修复历史：首版**无条件透传**，导致 `noj-cli logs core > out.txt` 把 docker
compose 的 ANSI 转义码写进重定向文件。该契约有三个容易各自踩坑的细节：

1. **取值优先级**：`LOG_COLOR` / `NO_COLOR` 都是**进程环境优先**（非空即胜出），
   否则回退 `.env.prod`（`env_value`）；
2. **分支顺序**：`NO_COLOR` 非空 **或** `LOG_COLOR=never` → `--no-color`；
   `LOG_COLOR=always` → 强制；否则 `!isatty(1)` → `--no-color`。`NO_COLOR` 分支
   **在前**，故 `NO_COLOR=1 LOG_COLOR=always` 仍关色；
3. **强制着色的落点**：`docker compose logs` 只有 `--no-color`，**没有**单命令的
   「强制开」开关——省略 `--no-color` 只是把决定权交回 compose 自己的 TTY 探测，
   并不等于「开」。要真正强制必须用**子命令之前**的全局 `--ansi always`。

同时 T10 的 `composeLogs` 经 `CommandRunner.run()` 是**缓冲**的（T10/T13 报告的
carry-forward）：`--follow` 走它永不返回、也看不到输出。

## Decision

1. **取值合并在上层，开/关判定仍只由 `resolveColor` 拍板**。新增两个纯函数于
   `prod/lifecycle/steps.ts`：
   - `mergeColorSource(processValue, fileValue)` = `processValue !== undefined &&
     processValue !== "" ? processValue : (fileValue ?? "")`——逐字对应 bash 的
     `${LOG_COLOR-}` 加空串回退（判定用未 trim 值，与 bash 的 `-z` 时机一致）；
   - `decideLogsColor({ logColor, noColor, stream })` 把两个**已合并**的原始值翻译成
     `resolveColor` 接受的 `ColorMode`（`NO_COLOR` 非空 → `never`；
     `LOG_COLOR=never` → `never`；`always` → `always`；其余 → `auto`），再调用
     `resolveColor` 得到唯一布尔判定，最后把「开」细分为 `force`（`mode=always`，
     即全局 `--ansi always`）与 `inherit`（`auto` + TTY，交回 compose 探测）。
   - 无第二套 `NO_COLOR`/`LOG_COLOR` 解析；`NO_COLOR`/`LOG_COLOR` 的**开/关**语义
     全部来自 `util/color.ts`。T14 未新增任何 `isTerminal` / `Deno.env` 直读
     （进程环境经 `LogsCommandOptions.env` 注入点进入，缺省 `Deno.env.toObject()`，
     与 T12 `InstallOptions.processEnv` 同形）。
   - **刻意不让 `--color` 参与**：bash `logs()` 的色旗只由 `LOG_COLOR`/`NO_COLOR`/
     TTY 决定；`--color` 只作用于本进程的人类输出主题。若混入，`--color=never` 会
     压过 `LOG_COLOR=always`，与 bash 不一致。
2. **`applyLogsColor(args, decision)`** 把决策落回 T10 的参数数组：`force` 在
   `logs` **之前**插入 `--ansi always`；`no-color` 插在 `--tail=200`/`--follow`
   之后、位置参数（服务名）之前（与 bash `args` 追加顺序一致）。参数形状本身仍由
   T10 `composeLogs` 唯一保证——用 `dryRun: true` 取数组，不重排任何既有元素。
3. **`--follow` 走 `CommandRunner.stream`**：参数数组复用上面同一条路径，逐行
   `emitHuman` 到人类通道。runner 未实现 `stream` 时**显式报错**，绝不静默降级为
   缓冲调用（那会让 `--follow` 永不返回）。非 follow 走既有缓冲路径，**自行**写
   stdout（T10：runner 不替调用方打印），compose 的 stderr 告警走真正的 stderr
   （`emitFailure`，对照 bash 的 `>&2` 继承）。
4. **`--json` 纯净**：stdout 只含一个结果 JSON 文档；日志本体与诊断都改道 stderr
   （T6 `emitHuman`/`emitFailure` 先例）。失败路径同样写 JSON（T13 `status` 先例）。
5. **命令命名**：`logs` 的命令选项类型命名为 `LogsCommandOptions`（不是
   `LogsOptions`）——后者已被 `maintain/logs.ts` 的 JSON 编排日志命令占用，包入口
   `mod.ts` 再导出会撞名。

## Alternatives considered

- **在 `lifecycle.ts` 内联整套判定**：会与 `util/color.ts` 形成第二份 `NO_COLOR` 解析，
  且 `--follow`/`--no-color` 的插入逻辑无法独立测试。改为两个纯函数后，测试可先断言
  参数数组形状，再断言实跑输出。
- **给 `resolveColor` 加「进程 env > .env.prod」参数**：会把 `.env.prod` 的文件语义
  塞进一个通用着色工具，且影响 T8 的既有契约（T14 brief 禁止改 T10 契约，同理不动
  `resolveColor` 签名）。取值合并在上层即可，判定仍单一来源。
- **`--follow` 用 `composeUp` 式的 poll 循环**：缓冲 `run()` 下 `--follow` 不返回，
  poll 无从谈起；`stream` 已是现成原语，T10 报告也点名它。
- **`--follow` 时额外转发 stderr**：`CommandRunner.stream`（P2 既有契约）只回调
  stdout 行，stderr 未暴露；记录为已知限制，不扩 T10 的 runner 契约。

## Consequences

- `noj-cli logs core > out.txt` 在非 TTY 下传 `--no-color`，输出无 ANSI；`LOG_COLOR=always`
  在终端里通过**全局** `--ansi always`（位于 `logs` 之前）真正强制着色。
- 变异测试（5/6 处转红）：分支顺序反转、`.env.prod` 优先、`--ansi` 追加到子命令之后、
  `--no-color` 位置错误、`--no-color` 完全不插、放弃 TTY 探测——均被现有测试捕获。
  **唯一存活变异**：`decideLogsColor` 内把 `NO_COLOR` 分支改成 no-op 仍全绿——因为
  `resolveColor` 自身也读进程 `NO_COLOR` 兜底（双保险，且有 `color_test.ts` 覆盖）。
  这是有意的纵深防御，不是测试缺口薄弱到不可接受；`.env.prod` 的 `NO_COLOR` 路径由
  「分支顺序」用例的第二个断言覆盖。
- **CLI 入口未接线**（与 T12/T13 同一状态）：`cli.ts` 仍把 `logs` 路由到 `runProduction`
  → bash；本次交付的是可注入的纯 TS 命令实现，接线按任务书归 T24。删 bash 前必须接线。
- **未迁移 `--dry-run`**：bash `run_compose` 有 DRY_RUN 早退；T14 只用 T10 的 `dryRun`
  作为「取参数数组」的内部手段，不对用户暴露该旗标（与 T13 一致）。
- **`--follow` 的 stderr 不转发**：见「Alternatives considered」。
