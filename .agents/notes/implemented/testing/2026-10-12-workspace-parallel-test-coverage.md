# Agent Note: 工作空间并行测试覆盖与拆分 DDL 校验

Status: implemented

## Problem

共享测试发现 workspace 已登记标准模块入口和 CI，却遗漏并行分片列表，导致 9
个测试文件不进入 `test:parallel`。Schema 覆盖测试只扫描主 DDL 文件的文本，
拆分后遗漏导入模块，并且原正则不识别带双引号的表名，误报新表不存在。

## Decision

workspace 的 types 加入 unit 分片，routes / services 加入 db 分片，保持两者
目录不重叠；显式域覆盖断言包含 workspace，原文件系统全覆盖守卫继续保留。 Schema
校验读取真正执行的 SCHEMA_DDL，包括模块展开结果，识别带引号及无引号
表名，并继续双向核对 ALL_TABLES 和 Drizzle 导出的全部表。

## Alternatives considered

- 将 workspace 测试列为豁免：会使标准并行检查漏测，拒绝采用。
- 放宽 Schema 反向检查：会掩盖表名漂移，改为读取完整事实源。
- 在测试中硬编码新模块表名：后续拆分仍会漂移，使用运行时 DDL。

## Consequences

标准共享入口 291 项通过、16 项跳过，原两个失败均修复；跳过项不计为通过。
并行分片会执行新增 workspace 测试，扩展 education 时仍须同步登记，并由
现有文件覆盖守卫验证。真实 PostgreSQL 的全量并行回归另行记录，不以本项
共享测试结果宣称全量通过。
