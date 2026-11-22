# 历史手工 SQL 归档

此目录保存未登记到正式迁移 journal 的历史手工
SQL，不作为安装、升级、测试或镜像的迁移输入。 运行迁移资产只包含
`noj-core/drizzle/meta/_journal.json` 登记的 SQL。

`0007_fk_cascade.sql` 原位于 `noj-core/drizzle/`，但未登记到
journal；该差集已记录在
[P0 基线](../../architecture-baseline-2026-10-20.md)。P2b
将原文件逐字节移至此处，保留 历史来源，不补写 journal、不执行这份旧
SQL，也不改变任何已登记迁移。

该文件提到的 `evaluation_results`
等表已在后续正式迁移中退役，不能作为当前数据库的修复脚本。
需要调整当前外键时，应通过正式 schema 和迁移生成工具追加迁移，并验证存量升级。
