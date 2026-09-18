# Agent Note: 统一备份模型的列举与清理（#515 P6）

Status: implemented

## Problem

#515 要求把备份收敛为「统一模型：单文件加密、单一入口、list/prune/dry-run」，
其中列举与清理有两个硬约束：

1. **必须向后兼容存量 `snapshot-*` 目录格式**——否则旧备份既无法列举也无法恢复，
   而「迁移」的前提恰恰是先能读到旧格式；
2. **清理默认必须是安全的那一侧**——删除不可逆，误操作代价极高。

此外 review 发现两个真实缺陷：

- 删除失败被 `catch {}` **静默吞掉**，调用方只看到「已删除 0 个」却 exit 0，
  向用户传达了「已清理」的**假成功**；
- `list`/`prune` 未登记进 help（#517 E5 要求 help 是命令清单唯一事实源）。

## Decision

1. **识别格式而非只支持新格式**：`detectSnapshotFormat` 以「单文件后缀」与
   「目录内同时含 `sha256sums.txt` + `SUCCESS`」区分 single/legacy。
   后者是旧实现的成功标记，能可靠区分「备份目录」与「恰好同名的普通目录」。
2. **prune 默认 dry-run**，`--confirm` 才真删；`--keep N` / `--older-than N` 可组合；
   两者都未给出时**不删任何东西**。
3. **legacy 默认受保护**，需 `--include-legacy` 显式放行——旧格式无法由新代码
   重新生成，误删即永久丢失；新格式删错还能重做。
4. **`list`/`prune` 只读部署配置**（`loadDeployConfig`），不强制要求密钥文件存在：
   密钥丢失时恰恰最需要看到「有哪些备份」。
5. **删除失败必须上报并影响退出码**（`failed[]` + exit 1）——这是对
   「假成功」的直接修复。

## Alternatives considered

- **只支持新单文件格式**：会让存量备份「隐身」——用户看不到也删不掉，
  反而更容易在不知情时丢失数据。
- **prune 默认真删**：删除不可逆，默认必须安全；`--confirm` 提供显式意图。
- **prune 默认删除 legacy**：旧格式无法重新生成，且存量部署常只有旧格式；
  要求显式 `--include-legacy` 把风险决策交还用户。
- **删除失败只打日志、仍 exit 0**：这正是被发现并修复的假成功模式；
  退出码是脚本唯一可靠的信号，必须反映真实结果。
- **`list` 也要求密钥文件**：把「查看现状」与「解密内容」耦合，
  在密钥损坏时让用户彻底失去可见性。

## Consequences

- 存量 legacy 备份**可见、可列举、可选择保留**，为后续迁移铺路。
- `prune` 的默认行为是「什么都不做」，需要显式 `--confirm` 才生效；
  这与常见的「dangerous default」相反，属于有意的安全取舍。
- 删除失败现在返回 exit 1 并逐条打印失败原因，脚本可据此告警；
  代价是部分成功的场景需要调用方判断 `deleted` vs `failed`。
- **范围内未完成**（#515 其余验收项）：`backup create` 统一单文件与默认整体加密、
  `backup restore --dry-run`、`backup schedule` 双 profile、
  `backup` 作为唯一顶层入口（旧名保留别名 + 废弃提示）、`verify --deep` 承接原 drill。
  这些在 PR 描述与本记录中均明确标注为未完成，PR 不使用 `Closes` 关闭 #515。
