# Agent Note: OI 做题界面接入提交语言白名单

Status: implemented

## Problem

OI 后端接受 C/C++，但共享做题工作区仍写死 Python
3。独立做题页的视图映射丢弃评测类型和语言配置，Monaco 也未映射后端 cc
标识。仅验证 HTTP 提交不足以发现浏览器菜单无法选择 C++。

## Decision

题库与竞赛接口公开 supported_languages，并保持
runtime_config、测试数据和存储地址的可见性规则。共用工作区根据白名单生成语言菜单，OI
优先 C++11，限制为 C 的题目仅显示 C99；缺失 OI
白名单时不猜测可提交语言。异步加载后同步选中项，cc 映射到 Monaco 的 cpp。

## Alternatives considered

不把完整 runtime_config 公开给普通选手，避免暴露测试点和
checker；不在所有题目上无条件放开 C/C++，避免与后端校验不一致。

## Consequences

标准题库与竞赛共用同一语言选择逻辑，已有 Python 题维持原行为。匿名 API
回归验证公开语言且隐藏评测配置；UI 回归覆盖 C-only、缺少配置和 cc 高亮。真实
Chromium 验证 P3 的 C++ 菜单、点击提交的 language=cc 以及 AC、100
分。域测试使用独立 Redis 数据库，避免本地服务器消费者抢走测试事件。
