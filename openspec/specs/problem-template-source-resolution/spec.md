## Purpose

确保题目编辑器只展示与当前数据库题目一致的启动代码，避免题号分配或源码目录调整后发生模板串题。

## Requirements

### Requirement: 模板源码目录与题目一致性校验

系统 SHALL 在返回题目初始代码模板前，验证候选源码目录 `problem.json` 的 `number`
与 `title` 均与已解析的数据库题目一致；源码目录名不得被视为题目身份的唯一依据。

#### Scenario: 自动分配题号后的非同名源码目录

- **WHEN** 数据库题目的题号为 `1001`，其题目源码目录名为 `imported-ab`，且
  manifest 的 `number` 与 `title` 均一致
- **THEN** 模板接口返回 `imported-ab` 目录中声明的模板文件

#### Scenario: 同题号遗留目录

- **WHEN** 同时存在题号相同但标题不同的题目源码目录
- **THEN** 模板接口不得返回标题不一致目录中的模板文件

#### Scenario: 没有唯一匹配源码目录

- **WHEN** 没有或存在多个与数据库题目 `number` 和 `title` 均匹配的源码目录
- **THEN** 模板接口返回 HTTP 404，且不回退到仅按目录名匹配的模板
