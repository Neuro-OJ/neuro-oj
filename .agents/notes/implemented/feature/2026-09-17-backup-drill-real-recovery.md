# Agent Note: backup drill 重定义为真实恢复演练

Status: implemented

## Problem

`backup drill` 的名字**承诺了"恢复演练"，实际只做文件完整性校验**。
脚本自己就在报告里承认这一点（`backup.sh:399`）：

> file verification proves payload integrity, not recoverability;
> real recovery acceptance requires restore-drill.sh

这造成两层问题：

1. **名字骗人**：用户看到"校验通过"会合理地以为"灾难时能恢复"，
   而这只证明文件没坏——不能证明 PostgreSQL 能起、业务能跑。
   这是备份系统里最危险的认知错位。
2. **真演练难以触达**：`scripts/deploy/restore-drill.sh`（已完整实现隔离
   项目、独立子网、不映射端口、业务验收、RPO/RTO 校验）**没有 CLI 入口**，
   用户必须记住脚本路径并手写参数。

## Decision

**把 `drill` 变成真实恢复演练的入口，做薄包装而非重写。**

隔离/恢复/验收的难逻辑已经正确实现，重写只会引入新缺陷。
本改动只补：参数 CLI 化、资源前置检查、退出码语义、报告归一。

三档能力**在名字上即可区分**（这正是 issue 的核心价值）：

| 命令 | 保证 | 成本 | 现有实现 |
| --- | --- | --- | --- |
| `backup verify` | 文件完整（sha256 + 解密） | 秒级 | `backup.sh` 的 verify |
| `backup verify --deep` | 结构可解析 | 十秒级 | 原 `drill` 的能力 |
| `backup drill` | **真的能恢复** | 分钟级，需 Docker | `restore-drill.sh` |

### 三个关键取舍

1. **项目名拒绝包含 `prod`**（硬校验，非警告）：演练末尾执行
   `docker compose down -v`。若与生产同名，会**删除生产数据卷**——
   不可逆。这类校验必须发生在开跑前，且不能只靠文档提醒。
2. **RPO/RTO 超限 = 演练失败（退出码 1），而非警告**：警告会被忽略；
   如果"太旧/太慢"不算失败，"演练"就失去了意义。
3. **资源前置检查后置为退出码 2**：Docker 不可用、磁盘 <2GiB 时在开始前报错，
   避免跑到一半失败并留下半清理的容器（清理失败比不演练更糟）。

另外，`--keep` 在两个子命令下语义不同，按**子命令**区分而非猜参数：
`prune --keep N`（保留最近 N 份）vs `drill --keep`（保留演练环境）。

## Alternatives considered

- **只改文档，不改命令**：issue 已明确"名字骗人"是核心问题；
  改文档无法消除认知错位，用户仍然只会敲 `drill`。
- **删掉 `drill`，只保留 `restore-drill.sh`**：破坏既有脚本与文档，
  且把"记住脚本路径"的负担永久留给用户。
- **在 CLI 内重写恢复逻辑**：隔离项目/子网/验收逻辑已正确实现且经过测试，
  重写会引入新的破坏性缺陷（这是删生产卷级别的操作）。
- **把 `drill` 默认加入 `install`/`update`**：分钟级且耗 Docker 资源，
  会拖慢部署并可能因资源不足失败。明确不做（与 issue 一致）。
- **做定时演练调度**：issue 明确不做——在生产上自动起隔离环境风险过高，
  是否 cron 由运维决定。

## Consequences

- `drill` 变成**分钟级、消耗 Docker 资源**的操作，不再是随手可跑的检查；
  秒级需求由 `backup verify` 承接。
- **破坏性变更**：`drill` 语义变化影响既有脚本与文档，
  需在 changelog 说明并给出 `verify` / `verify --deep` 作为替代路径。
- 演练**无法证明**"备份能恢复到新主机"——它验证的是本机隔离恢复。
  异地恢复能力仍需人工演练；这一点必须在文档写明，
  避免又一次制造"误以为已覆盖"的错觉。
- 参数校验（项目名、CIDR）与参数构造已单测覆盖，但**真实演练本身**
  需要 Docker 环境，不在单测范围内（沿用 `restore-drill.sh` 的既有测试）。
