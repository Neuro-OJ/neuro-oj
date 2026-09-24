# Agent Note: 生产生命周期命令接线 T4 状态机并拆分 steps 模块

Status: implemented

## Problem

T12 交付 `install()` 时，`noj-cli/src/prod/lifecycle.ts` 已是 715 行且只承载一个命令；
brief 的「落状态（T4）」被**有意**延后（bash `install()` 不查 `compose ps`，状态落盘
没有落点）。于是出现两个欠账：

1. **T4 状态机没有调用方**：`core/state.ts` 导出的 `prodState`/`transition`/
   `upIsNoOp`/`downIsNoOp` 自 T4 起无人消费，prod 路径的「已运行 → 重复 up」
   与「已停止 → 重复 stop」无法按状态机短路。
2. **`wait_for_stack` 未完整迁移**：T12 只跑 `up -d --wait`，缺 bash 的
   `--wait-timeout 180 --remove-orphans` 与第二段 `up -d --force-recreate
   --no-deps nginx`（task-12 报告 §6.2 登记）。
3. **文件规模失控**：`install` 单命令已占 715 行，共享的 compose 编排与前置校验
   没有可复用的落点。

## Decision

新增 `noj-cli/src/prod/lifecycle/steps.ts`，承载被多个动作共享的**步骤**：
`prepareAndCheck`（bash `check_configuration` 的**全六步**，见下）、
`waitForStack`（bash `wait_for_stack` 的两段 compose 逐字迁移）、
`runComposeSub`/`composeOutputText`（T10 未提供命名封装的 `stop`/`pull` 等
裸子命令与输出回传），以及 `statMode`/`readEnvValues`/`assertConfiguration`/
`judgeEnabledFrom` 这些 T11/T12 判定。仅服务 install 第 9 步的 PATH 注册
（`registerCommand`/`PATH_LINE`，production.sh `register_command`）另抽
`noj-cli/src/prod/lifecycle/path.ts`。**命令入口仍在 `lifecycle.ts`**，
`install` 与 `start` 共用 `waitForStack`（bash 的 `install()` 同样调用
`wait_for_stack`），因此 T12 的缺口在同一处闭合。

`prepareAndCheck` 与 install 的 validate 步骤**同源**：bash `check_configuration`
六步——1 env 文件存在 → 2 权限 600/400 → 3 `check_required_values` →
4 `check_judge_socket`（judge 关闭走「已跳过」分支）→ 5 `check_port_value` →
6 `compose config --quiet`，外加 `check_dependencies` 的 compose 文件判定。
先前 install 单独实现第 4/6 步、四个生命周期命令只跑 1/2/3 的分叉已消除。
第 4 步的 socket 存在性与第 5 步的 `lsof` 占用探测是**环境探测**，经
`PrepareOptions.socketExists`/`probePort` 注入（命令侧对应
`LifecycleOptions` 的同名字段）；未注入即为 bash 的「已跳过」/`command -v lsof`
不命中分支。步骤 1–5 不调用 docker，步骤 6 的 `compose config` 是只读解析，
因此任何失败都发生在 `up`/`stop`/`down` 之前。

四个命令按 T4 接线：

- `status`：`prodState(compose ps 输出)` → running / partial / stopped；
- `start`：先 `prodState`，`upIsNoOp` 为真即 no-op（不跑 `up`），否则
  `waitForStack`；
- `stop`：先 `prodState`，`downIsNoOp` 为真即 no-op，否则 `compose stop`
  （**绝不** `down`/`-v`/`--volumes`）；
- `restart`：`transition(最终态, "restart")`；编排为 stop → start。

no-op 文案**逐字取自 T4**（`transition(...).message`），不另写第二份提示语。
四个命令返回统一的 `{ dir, state, noOp, exitCode, error }`：0 成功（含 no-op）、
1 运行失败；用法错误 2 仍由 CLI 解析层（`UsageError`）产出，命令层不自行判 2。
人类输出经 T8 `renderStatus` + T6 `emitHuman`/`emitJson`；失败诊断显式走
stderr（对照 bash `fail` 的 `>&2`），`--json` 的 stdout 只含一个 JSON 文档。

## Alternatives considered

- **保留单文件、继续追加四个命令**：被 T12 评审否定（lifecycle.ts 已达 715 行）。
  拆 `steps.ts` 而非按命令拆 `start.ts`/`stop.ts`：四个命令共享前置校验与
  编排，按命令拆会复制 `prepare_and_check`。
- **让 `start` 保持 bash 的"无条件重跑 up"**：被 brief 明确否定——已 running 时
  必须 no-op，否则失去 T4 的意义。
- **把 T4 状态写回磁盘**（`writeState` 风格）：prod 路径的状态是**现场推断**的
  （`compose ps` 是唯一事实源），落盘会引入与实际容器不一致的第二份真相；
  bash 也不落盘。
- **`stop` 不看退出码、照 bash 报成功**：不采纳。静默假装成功是真实可用性缺口，
  本实现如实读退出码并在测试中显式断言文案差异。

## Consequences

- T4 状态机不再是死代码：四条命令各自消费，且有变异测试证明接线是 load-bearing
  （`upIsNoOp`/`downIsNoOp` 改常量、`stop` 换 `down -v`、`status` 绕开
  `prodState`、删 `--wait-timeout` 都会让测试转红）。
- `wait_for_stack` 成为唯一实现，install 与 start 行为一致；`--wait-timeout 180`
  与 nginx 刷新两段参数由测试逐元素锁定。
- T10 公开契约未改：`up` 仍走 `composeUp`，裸子命令经 `composeArgs` 组参数数组，
  不拼 shell 字符串；`stop` 走裸 `stop`（T10 无命名封装）。
- **前置校验与 install 同源**：`install` 的 validate 步骤改调 `prepareAndCheck`，
  第 4/6 步不再各写一份；`check_configuration` 的报错文案（含 compose 无效提示）
  因此只有一份字面量。
- **仍延后（已登记）**：`check_dependencies` 的「docker 可执行 / daemon 可连 /
  buildx 可用」三条环境探测未接线（T12 报告 §6.4）；步骤 5 的 `lsof` 占用探测
  在未注入 `probePort` 时不执行（只影响 warn，不影响 fail 语义）。
- **行为差异（有意）**：`stop` 在 `compose stop` 非 0 时返回退出码 1（bash 报成功）；
  已 running 的 start 是 no-op（bash 会重跑 up）。
- 文件规模：`lifecycle.ts` 从 1173 行降至 1050 行（PATH 注册约 120 行外移到
  `lifecycle/path.ts`）；共享编排在 `steps.ts`，后续 logs/uninstall/update 的
  编排增量进该模块，命令入口仍留在 `lifecycle.ts`。
