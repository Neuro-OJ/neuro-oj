# Agent Note: 按职责拆分提交结果格式化与题目内容补丁

Status: implemented

## Problem

主分支集成新增提交模式后，提交和题目 CRUD 文件均超过 1200
行。结果格式化与草稿内容合并已有独立职责，继续放在 CRUD 文件内增加阅读成本。

## Decision

- 提交的四个结果解析及展示状态函数原样移到同目录
  `submission-result-format.ts`，CRUD 使用静态导入。
- 题目的 `mergeProblemContentPatch` 原样移到同目录
  `problem-content-patch.ts`，原 CRUD
  文件保留公开重导出，既有调用与异步返回约定不变。
- 保留全部校验、权限、查询与事务行为；不修改文件大小基线，不压缩空行。

## Alternatives considered

- 提高文件大小基线会掩盖继续增长，未采用。
- 进一步拆分 CRUD 查询或写入流程会扩大行为审查范围，本次仅迁移已有独立函数。

## Consequences

题目与提交 CRUD 文件分别为 1155 和 1161 行；新增 helper
均为静态导入，不增加运行时动态模块解析。

使用标准 `deno task test:domain` 在隔离 PostgreSQL Schema 运行：提交核心回归 17
项通过，版本读取与域本人读取 5 项通过，题目 CRUD 回归 31 项通过，均无失败。
三次入口各自的迁移和种子前置 8 项通过。完整模块测试发现仍会加载被过滤的文件，
过滤数量分别为 405、417、364；本记录不将过滤项算作通过。

受影响四个源文件的格式、lint 和两个 CRUD 入口的类型检查通过；仓库文件大小门禁、
编译导入安全门禁与 Agent Note 格式校验通过。未重跑全量或重建已运行验收镜像，
本次只移动函数，不修改数据库 Schema、权限、查询或事务。
