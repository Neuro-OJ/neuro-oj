# Agent Note: backup create/schedule 读取 .env.prod 中的备份口令路径

Status: implemented

## Problem

生产实测：`noj-cli update` 首次备份会生成 GPG 口令文件，并把路径写入 `.env.prod`
的 `NOJ_BACKUP_PASSPHRASE_FILE`。之后在安装目录手动执行 `noj-cli backup create`
却报“缺少 GPG 口令文件”，必须显式加 `--passphrase-file`。

原因是 `verify`/`restore`/`drill` 已统一经 `resolveBackupPassphrase` 按“旗标 >
进程环境 > `.env.prod`”解析口令，而 `runBackupCreate` 只认旗标，
`backup schedule` 只认旗标与进程环境，漏了 `.env.prod`。

## Decision

`runBackupCreate` 在显式选项缺省时复用 `resolveBackupPassphrase`，以已读取的
`.env.prod` 作为最后一级来源；`update` 内部备份仍显式传入口令，行为不变。
`backup schedule` 同样改用 `resolveBackupPassphrase` 并读取 `.env.prod`，避免
`schedule install` 在口令已配置时仍要求旗标。

回归覆盖：未传旗标时使用 `.env.prod` 路径；优先级“旗标 > 进程环境 >
`.env.prod`”；`schedule install` 未传旗标时写入 crontab 的口令路径来自
`.env.prod`。测试共用的伪 ops 抽为 `fakePayloadOps`，并把 `tar -I zstd` 改为 GNU
tar 与 bsdtar 都支持的 `--zstd`（bsdtar 的 `-I` 含义不同，原用例在 macOS
上必然失败）。

## Alternatives considered

- 只在文档中要求手动加 `--passphrase-file`：不采用，安装与升级已写入配置，
  命令之间口令来源不一致属于缺陷。
- 让 `install` 把口令写入进程环境：不采用，手动执行与 cron
  都不继承安装时的环境。

## Consequences

四个备份入口的口令来源一致。显式旗标仍最高优先，已有脚本与 cron 行为不变；
`.env.prod` 未配置且无旗标时仍按原逻辑报缺少口令。
