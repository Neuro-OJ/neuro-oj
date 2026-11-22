# Agent Note: MinIO 备份使用完整 Compose 项目上下文

Status: implemented

## Problem

正式备份的 PostgreSQL 和 Redis 采集使用 `prodComposeArgs`，MinIO
镜像却另行拼接命令，遗漏自定义 `projectName`、profile、ANSI 选项和 Docker
可执行路径。使用独立 Compose
项目时，对象镜像可能连接另一个项目，而数据库来自指定项目，导致备份组件不属于同一部署。

## Decision

MinIO 采集复用 `prodComposeArgs(compose, ...)`，并使用同一
`compose.dockerBin`。保留原有只读
`mc mirror --preserve`、桶名和挂载方式，不增加配置引擎或执行器回退。

针对性测试检查自定义项目名、Docker 路径、profile 和 ANSI
参数都传递给镜像命令，同时核对目标桶与暂存目录。标准 `deno task test` 实际结果为
756 passed、0 failed、4
ignored；这证明命令装配回归通过，完整栈恢复验收另行记录。

## Alternatives considered

- 强制所有部署使用固定项目名：会限制隔离恢复和同机多套部署，且不能修复其它遗漏参数。
- 在 MinIO 分支单独补 `--project-name`：保留重复命令装配，Docker
  路径和其它选项仍可能漂移。

## Consequences

对象、PostgreSQL 和 Redis 采集使用一致的 Compose
定位规则。备份格式及恢复流程保持现有 `prod-raw` 契约；本变更不为开发环境的 local
文件卷增加生产备份支持。
