# 术语表

## 支持包

支持包是出题人提供给 Judge Worker 的 zip 文件，根层级必须包含 `evaluate.py`，可以包含测试数据和辅助文件，不包含用户提交代码。

## Evaluator

Evaluator 是出题人的评测程序，运行在 Evaluator 容器中。它读取测试数据、调用用户函数、计算分数并输出结果。

## Solution

Solution 是用户提交的代码，运行在 Solution 容器中。

## Solution Host

Solution Host 是 Solution 容器中的协议进程，负责加载用户模块、接收函数调用请求、执行用户函数并返回结果或错误。

## 可见用例

可见用例是出题人愿意向做题人展示的样例或测试结果。内置样例题通常存放在 `visible.jsonl`，但 NOJ 不强制该文件名或数据格式。

## 隐藏用例

隐藏用例是出题人不希望直接暴露给做题人的评分材料。内置样例题通常存放在 `hidden.jsonl`，但 NOJ 不强制该文件名或数据格式。出题人应避免向用户泄露隐藏输入和标准答案。

## Judge Worker

Judge Worker 是 `noj-judge` 进程，负责从 Redis 获取任务、运行 Docker 评测容器并回传结果。

## 镜像白名单

镜像白名单由 noj-core 管理，规定 Judge Worker 可以使用哪些 evaluator 和 solution 镜像。

## `noj-storage://`

数据库存储层 URL，用于表示支持包在本地存储或对象存储中的位置。

## `noj-download://`

Judge 交付层 URL，用于表示本次评测任务如何下载支持包。
