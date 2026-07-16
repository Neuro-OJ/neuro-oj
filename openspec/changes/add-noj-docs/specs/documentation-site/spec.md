## ADDED Requirements

### Requirement: 文档站模块

仓库 SHALL 提供顶层 `noj-docs` 模块，用于承载 NOJ 面向使用者的正式文档。

#### Scenario: 文档模块存在

- **WHEN** 维护者打开仓库根目录
- **THEN** 仓库中存在 `noj-docs` 目录，并包含 MkDocs 配置和 Markdown 文档源文件

#### Scenario: 文档可严格构建

- **WHEN** 维护者在 `noj-docs` 内运行文档中声明的静态构建命令
- **THEN** MkDocs 在启用严格链接和导航校验的情况下成功构建文档站

### Requirement: MkDocs Material 配置

文档站 SHALL 使用 MkDocs Material，并提供可搜索、可导航的静态文档体验。

#### Scenario: 本地预览

- **WHEN** 维护者在 `noj-docs` 内运行文档中声明的预览命令
- **THEN** MkDocs 为文档站启动本地开发服务器

#### Scenario: 读者导航

- **WHEN** 读者打开生成后的文档站
- **THEN** 导航中展示做题人、运营者、出题人和参考四个主要分区

### Requirement: 做题人文档

文档站 SHALL 包含面向做题人的文档，用于说明常见使用流程。

#### Scenario: 做题人阅读提交指引

- **WHEN** 做题人阅读用户文档
- **THEN** 文档说明如何查找题目、提交代码，以及如何理解常见提交状态

### Requirement: 运营者文档

文档站 SHALL 包含面向运营者的文档，用于说明如何运行和维护 NOJ 实例。

#### Scenario: 运营者阅读初始化指引

- **WHEN** 运营者阅读运营文档
- **THEN** 文档说明本地基础设施启动、seed 初始化、支持包构建、Judge Worker 启动和必要运行时服务

#### Scenario: 运营者阅读运行时配置指引

- **WHEN** 运营者阅读运营文档
- **THEN** 文档说明 Redis、PostgreSQL、存储后端配置、Docker 镜像和评测镜像白名单配置的作用

### Requirement: 出题人评测模型文档

文档站 SHALL 包含面向出题人的文档，并在实现细节之前说明 NOJ 的评测模型。

#### Scenario: 出题人阅读评测模型

- **WHEN** 出题人阅读评测模型文档
- **THEN** 文档说明 Evaluator 容器、Solution 容器、Solution Host、Evaluator SDK、Solution SDK，以及 evaluator 代码如何调用用户解答代码

#### Scenario: 出题人对比传统 OJ

- **WHEN** 出题人阅读评测模型文档
- **THEN** 文档说明用户提交的是可调用的解答代码，测试数据、评分逻辑和结果上报由 evaluator 控制

### Requirement: 题目支持包文档

文档站 SHALL 说明 NOJ 题目支持包的结构和生命周期。

#### Scenario: 出题人阅读支持包结构

- **WHEN** 出题人阅读支持包文档
- **THEN** 文档描述预期源码布局、`evaluate.py`、可见用例、隐藏用例、生成的 zip 包、校验和，以及用户提交代码不包含在支持包中的事实

#### Scenario: 出题人阅读打包流程

- **WHEN** 出题人阅读打包文档
- **THEN** 文档说明如何使用仓库中的支持包构建脚本，从 `noj-core/data/problems-src` 构建支持包

### Requirement: SDK 语义文档

文档站 SHALL 说明 Python 题目中 NOJ Evaluator SDK 和 Solution SDK 的初始语义。

#### Scenario: 出题人阅读 Evaluator SDK 语义

- **WHEN** 出题人阅读 Evaluator SDK 文档
- **THEN** 文档说明 evaluator 代码如何调用解答函数、记录通过或错误答案、处理可见和隐藏用例，并上报结构化详情

#### Scenario: 出题人阅读 Solution SDK 语义

- **WHEN** 出题人阅读 Solution SDK 文档
- **THEN** 文档说明解答代码如何暴露可调用函数、函数缺失时如何表现、stdout/stderr 如何处理，以及为什么不能把顶层输出作为答案通道

### Requirement: 参考文档

文档站 SHALL 包含用于解释稳定术语和评测结果的参考页。

#### Scenario: 读者查看术语

- **WHEN** 读者打开参考分区
- **THEN** 文档定义支持包、Evaluator、Solution、Solution Host、可见用例、隐藏用例、Judge Worker 和镜像白名单等关键术语

#### Scenario: 读者查看结果状态

- **WHEN** 读者打开结果状态参考页
- **THEN** 文档以面向使用者的方式解释 Accepted、WrongAnswer、TimeLimitExceeded、RuntimeError 和 SystemError 等常见状态
