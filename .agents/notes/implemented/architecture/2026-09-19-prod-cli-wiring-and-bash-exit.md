# Agent Note: 生产命令接线与 bash 退场（R1 / R2 / R4 收口）

Status: implemented

## Problem

T12–T21 交付了全部生产命令的**原生 TS 实现**，但它们**没有接线**：`cli.ts` 把
`PRODUCTION_COMMANDS` 整体转发给 `bash <dir>/scripts/deploy/production.sh`。
因此：

1. **R1 未达成**：`noj-cli/src` 内仍有一处 `Deno.Command("bash", …)`
   （旧 `production.ts:112`），"纯 TS 重写"最后一块拼图没放上。
2. **两处 carry-forward 悬空**：T16 的 `UpdateOptions.backup` 是**必填注入点**
   （未注入即明确失败），T15 的 `readConfirm` 缺省不读真实 stdin——它们都在等
   CLI 层接线，否则"升级前必须备份"与"卸载必须确认"两条门禁在真实路径上不生效。
3. **自举与内驱脚本仍在**：根 `noj`(447)、`setup.sh`、`install.sh`、
   `production.sh`、`backup-schedule.sh`、`judge-install.sh` 及 9 个 `test-*.sh`。

## Decision

1. **接线**（新 `prod/cli.ts` + `prod/install-defaults.ts`）：参数解析与依赖装配，
   命令语义一律留在 `prod/` 的原生实现里。两处 carry-forward 闭合：
   `update` 接上 `prod/backup` 的真实备份；`uninstall` **仅在有 TTY 时**接上
   `PromptIO`（无 TTY 时 `uninstall` 自己会硬错误，接上读取器反而掩盖那条提示）。

2. **接线过程中 R1 门禁抓出三处真实缺陷**（都不是注释，是真会出问题的代码）：

   | # | 缺陷 | 后果 |
   | --- | --- | --- |
   | 1 | T20 的 cron 条目指向 `scripts/deploy/backup.sh` | 该脚本随本任务删除 → **定时备份静默失败**（cron 的失败只落日志）。改为指向 `<dir>/bin/noj-cli backup create` |
   | 2 | `assertRemovableInstallDir` 的完整性判据含 `scripts/deploy/deploy.sh` | 该脚本删除后，`uninstall --all` 在**任何**真实安装目录上永久自锁（T15 的 Note 已预警）。重新定义为"CLI 二进制 + 两个生产特征文件" |
   | 3 | 两处错误文案写"请先用 backup.sh 迁移" | 指引用户执行一个已删除的脚本 |

3. **R1 门禁**（`prod/cli_test.ts`）：遍历 `src` 全部 `.ts`，**剥掉注释后**断言无
   `Deno.Command("bash"` 与六个脚本名。只查代码不查注释是有意的——注释里引用
   `deploy.sh:679` 这类出处是 R3 parity 对照表所依赖的可追溯信息。

4. **删除**：根 `noj`、`setup.sh`、`install.sh`、`production.sh`、
   `backup-schedule.sh`、`judge-install.sh`、全部 `test-*.sh`（9 个）。

5. **保留 + R2 闸门**（新 `deprecation-gate.sh`）：见下"Alternatives"中的冲突说明。

## Alternatives considered

- **删除 `deploy.sh`/`restore-drill.sh`/`backup.sh`（按 §3.3 + §10）vs 保留并加闸门
  （按 §7 P10 + §8 R2）**：**spec 自身在这一点上矛盾**——§3.3 的删除清单与 §10
  「❌ 保留任何 bash 实现路径（R1 是硬要求）」要求删除，而 §7 P10 与 §8 R2 验收
  要求保留 `deploy.sh`/`restore-drill.sh` 并加闸门。已与用户确认采用**保留+闸门**：
  删除不可逆，而闸门可以在下一个版本收紧为删除。附带的技术事实：这一支实际要留
  **3 个**脚本——两者都硬依赖 `backup.sh`（`deploy.sh:1167`、
  `restore-drill.sh:276`）与 `restore-drill-verify.ts`，少了它闸门形同虚设。
- **非 TTY 时自动放行**（而非报错）：会让 CI/定时任务在无人察觉的情况下继续使用
  废弃入口——那正是弃用闸门要阻止的事。改为**明确报错（退出码 2）**，把决定权交回
  调用方：要么设 `NOJ_ACCEPT_DEPRECATED=1` 表达知晓，要么改用 `noj-cli`。
- **闸门放在 `main` 内部**：`main` 会创建目录、调 docker、写配置，"拒绝即零副作用"
  要求闸门更早。两个调用点都在 `main` **之前**，测试用假 docker + 日志断言这一点。
- **取消时返回非 0**：用户主动取消不是错误。退出码 0，且不执行任何动作。
- **给内驱脚本也加闸门**：spec §10 明确不做（"给 e2e/staging/release/monitoring 的
  开发脚本加弃用闸门"是 YAGNI 项）；内驱脚本随删除处理。

## Consequences

- **R1 达成**：`noj-cli/src` 内零 bash 调用、零脚本依赖（`r1check` 零命中）；
  `deno compile` 产物不再需要仓库脚本即可完成全部命令。
- **R2 达成且有测试**：`scripts/deploy/test-deprecation-gate.sh` 覆盖四条验收
  （警告含替代命令 / `y` 才继续 / `NOJ_ACCEPT_DEPRECATED=1` 跳过 / 非 TTY 报错不挂起），
  含两条**真实 PTY** 用例（`y` 与 `n`）。已接入 `check-ci.ts`/`check-all.ts` 与
  `noj-cli/deno.json` 的 `test:production`。
- **R4 达成**：`setup.sh` 与 `install.sh` 已删除；`install` 在空目录仅凭二进制即可
  完成（T9 的 `downloadReleaseFiles` + T12 的装配）。
- **测试规模变化**：`deno task test` 678 passed（`test:production` 411 passed）。
  删掉的 9 个 `test-*.sh` 测的是已删实现，其行为覆盖由 `prod/*_test.ts` 承接。
- **仍保留 3 个 bash 脚本**（过渡期）：`deploy.sh`、`restore-drill.sh`、
  `backup.sh` + `restore-drill-verify.ts`。它们与 `noj-cli` 功能重叠，属于
  **有意保留的过渡态**，下一个版本应删除；闸门的存在就是让这个"仍在用"的事实
  每次都被看见。
- **注释中的历史出处标注为"原 bash"**：`test-deploy.sh`/`test-backup-schedule.sh`
  等已删除，直接引用会让读者去找不存在的文件。已在保留溯源价值的前提下标注为
  "原 …"，并指明继承该覆盖的 TS 测试。
