/**
 * 生产生命周期命令入口（T12 起）：install / start / stop / restart / status。
 *
 * 结构（T13 拆分）：**命令入口与结果形状留在本文件**。两个内聚单元已外移：
 * - `./lifecycle/steps.ts`：被多个动作共享的 compose 编排（`waitForStack`）与
 *   前置校验（`prepareAndCheck`，即 bash `check_configuration` 六步），
 *   T14–T16 的编排增量进该模块；
 * - `./lifecycle/path.ts`：仅服务 install 第 9 步的 PATH 注册
 *   （`registerCommand`/`PATH_LINE`，production.sh `register_command`）。
 *
 * 两者都是「命令无关」的单元，因此本文件只留命令入口、结果形状与上下文装配。
 *
 * ## T13：T4 状态机的落点（T12 的 carry-forward 在本任务闭合）
 *
 * T12 的 `install` **有意不查** `docker compose ps`（与 bash `install()` 一致），
 * 状态落盘延后到本任务，已登记在 task-12 报告的「有意非迁移清单」与
 * `install()` 第 8 步前的注释。本任务把 T4 状态机真正接上，四个命令的消费方式：
 *
 * | 命令 | 如何消费 T4 |
 * | --- | --- |
 * | `status` | `prodState(compose ps 的输出)` 推断 running / partial / stopped |
 * | `start` | 先 `prodState` 推断当前态；`upIsNoOp(当前态)` 为真即 **no-op**（不跑 `up`），否则 `waitForStack` |
 * | `stop` | 先 `prodState` 推断当前态；`downIsNoOp(当前态)` 为真即 **no-op**（不跑 `stop`），否则 `compose stop` |
 * | `restart` | T4 `transition(当前态, "restart")` 表达目标态 running；实际执行为 stop → start，顺序对齐 bash `deploy.sh:1034-1044` 与 `production.sh:437-441` |
 *
 * **no-op 文案逐字取自 T4**（`upIsNoOp`/`downIsNoOp` 背后的
 * `transition(...).message`：`已处于 running，无需重复启动` /
 * `已处于 stopped，无需重复关闭`），本模块不另写第二份提示语。
 *
 * ## 退出码（#517 E9 的 0/1/2 项目契约）
 *
 * 四个命令都返回 `exitCode`：0 成功（含 no-op）；1 运行失败（前置校验不过、
 * compose 失败、wait_for_stack 失败）。**用法错误（未知旗标等）= 2 由 CLI 解析层
 * 产出**（`cli.ts` + `util/args.ts:UsageError`），命令层不吞不掉、也不自行判 2。
 *
 * ## 与 bash 的有意差异（R3 逐项核对后保留）
 *
 * 1. **`--dry-run` 未迁移**：bash `run_compose` 有 DRY_RUN 早退；本模块的 dryRun
 *    只存在于 T10 封装（`ComposeOptions.dryRun`），四个命令不暴露该旗标
 *    （brief 未要求，且 T16 才需要脚本化干跑）。
 * 2. **`check_dependencies` 的 docker / daemon / buildx 三条未接线**：
 *    `prepareAndCheck` 已迁移 `check_configuration` 六步 + `check_dependencies`
 *    的 compose 文件判定；只有「docker 可执行 / daemon 可连 / buildx 可用」
 *    这三条环境探测仍属环境面（T12 报告 §6.4 已登记），compose 调用失败会自然
 *    报错。**步骤 5 的 `lsof` 占用探测**经 `LifecycleOptions.probePort` 可注入，
 *    未注入即等同 bash 的 `command -v lsof` 不命中（只 warn，不 fail）。
 * 3. **`stop` 失败仍报成功**：bash `stop()` 不看 `compose stop` 的退出码就
 *    `ok "服务已停止，数据卷已保留"`。本实现如实读退出码（!=0 → 退出码 1），
 *    因为"静默假装成功"是真实可用性缺口；文案差异已在测试中显式断言。
 * 4. **人类输出走注入的 RenderIO**：bash 直写终端；本模块经 T8 `renderTable` /
 *    T6 `emitHuman`，`--json` 时人类文字自动改道 stderr（R5）。
 *
 * 以下 `install` 的章节保留 T12 原文（为可追溯，未随本次拆分改写）。
 *
 * ---
 *
 * 生产生命周期动作（T12 起）：`install` 是**唯一**生产安装路径。
 *
 * 背景（spec R4 + §3.3 洞 2）：删除 `setup.sh` / `install.sh` 后，用户手动
 * 下载 `noj-cli` 二进制，在空目录执行 `noj-cli install --dir <dir>` 即应完成
 * 安装。这要求 install 自己补齐 compose 文件（T9 bootstrap）、自己完成配置
 * 校验与向导（T11），再驱动 compose（T10）。
 *
 * 装配顺序（对照 deploy.sh 的 `install()` :999-1026 与 `initialize_env` :597-656）：
 * 1. **bootstrap**：T9 {@link downloadReleaseFiles} 拉取并 SHA-256 校验
 *    `docker-compose.prod.yml` + `.env.prod.example`；
 * 2. **seed-env**（仅当 `.env.prod` **不存在**）：由模板生成 `.env.prod`（600）
 *    并写入自动生成的强随机密钥（deploy.sh :622-644）；既有文件逐字节保留；
 * 3. **configure**（仅在仍有缺失时执行并记录）：T11 {@link runConfigWizard}
 *    交互向导（仅 TTY；非交互缺配置直接报错且**零写入**）；
 * 4. **passphrase**：T11 {@link ensureBackupPassphrase}（deploy.sh :920-953）；
 * 5. **validate**：与四个生命周期命令**共用** `lifecycle/steps.ts:prepareAndCheck`
 *    ——bash `check_configuration` 六步（env 文件 / 权限 / 必填值 / judge socket /
 *    端口 / `compose config`，deploy.sh :893-914 + :684-789）；
 * 6. **verify-images**：T11 {@link verifyImageSignatures}（deploy.sh :837-874）；
 * 7. **compose-pull / compose-up**：T10 {@link composeUp} 等（deploy.sh
 *    `run_compose pull` + `wait_for_stack` :981-992）；
 * 8. **record-metadata**：T11 {@link recordDeploymentMetadata}（deploy.sh :875-891）；
 * 9. **register**：PATH 注册（production.sh:97-131 的 `register_command`）。
 *
 * ## 上游 CARRY-FORWARD（全部落实）
 *
 * 1. **T9**：`downloadReleaseFiles` 的 `overwrite` 默认 false（拒绝覆盖）→
 *    目录里**已有任一 Release 资产**（`docker-compose.prod.yml` 或
 *    `.env.prod.example`）时显式传 `overwrite:true`，真正的空目录首装才保持
 *    false。**注意**：`overwrite` **不是**由 `.env.prod` 是否存在决定的，它只
 *    看 T9 自己的 `RELEASE_FILES` 资产清单（{@link hasReleaseAssets}）。
 *    **是否 seed `.env.prod`** 是另一条**独立**判定：只看该文件自身是否存在，
 *    {@link seedEnvFile} 绝不覆盖已存在的 `.env.prod`（对照 bash
 *    `initialize_env` :600-615 的 `[[ -e "$ENV_FILE" ]]` 早退）。T5 的
 *    `PRODUCTION_MARKERS`（compose + env 两件套）不再是 install 的判定依据，
 *    它只由 `production.ts` 的 profile 探测消费。资产名沿用 T9 的
 *    `RELEASE_FILES`（各带 `.sha256`）。
 * 2. **T11**：调用顺序 **先 `judgeEnabledError` → 再 `checkRequiredValues`
 *    （内部即 `validateEnv`）**；judge 未设置/空串 = 启用。口令回填**仅由进程
 *    环境变量抑制**（`configuredFromEnv`），`--passphrase-file` 不抑制；口令
 *    路径经 `targetFile` 注入。`.env.prod` 权限经 `checkEnvFileMode(mode, file)`
 *    校验 600/400。`cosignAvailable` 在 T11 缺省 true，本模块在生产路径上注入
 *    真实探测（见 {@link InstallOptions.cosignAvailable}），**不静默**。
 * 3. **T10**：`ComposeResult = CmdResult | string[]`，读结果前一律
 *    `Array.isArray` 收窄；runner 不替调用方打印，本模块自己写 stdout/stderr。
 *
 * ## 与 bash 的有意差异（R3 逐项核对后保留，已在 task-12 报告登记）
 *
 * - **非交互 + 缺配置 → 零写入**：bash `initialize_env`（:646-655）会先由模板
 */

// ---- 2026-11-08 按命令族拆分：install / 服务操作（status/logs）/ start-stop /
// update / uninstall 的实现移入 ./lifecycle/ 同名子模块；本文件只保留门面 ----
export {
  install,
  type InstallOptions,
  type InstallResult,
  type InstallStep,
  type InstallStepName,
  missingConfigError,
  probeCosign,
} from "./lifecycle/install.ts";
export {
  type LifecycleBaseResult,
  type LifecycleOptions,
  logs,
  type LogsCommandOptions,
  type LogsResult,
  status,
  type StatusResult,
} from "./lifecycle/services.ts";
export { restart, start, stop } from "./lifecycle/start-stop.ts";
export {
  update,
  UPDATE_BACKUP_UNAVAILABLE_HINT,
  UPDATE_UP_TO_DATE_HINT,
  type UpdateBackupContext,
  type UpdateBackupResult,
  type UpdateMigrationContext,
  type UpdateOptions,
  type UpdateResult,
  updateSuccessHint,
  type UpdateSyncContext,
  upgrade,
} from "./lifecycle/update.ts";
export {
  uninstall,
  UNINSTALL_ALL_CANCELLED_HINT,
  UNINSTALL_ALL_PROMPT,
  UNINSTALL_ALL_WARNING,
  UNINSTALL_CANCELLED_HINT,
  UNINSTALL_PROMPT,
  UNINSTALL_TTY_HINT,
  UNINSTALL_WARNING,
  type UninstallOptions,
  type UninstallResult,
} from "./lifecycle/uninstall.ts";
