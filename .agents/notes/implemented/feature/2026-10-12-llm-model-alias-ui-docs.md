# Agent Note: LLM 模型别名的管理页、出题编辑器与文档

Status: implemented

## Problem

模型别名设计（`dev-docs/superpowers/specs/2026-10-12-llm-model-aliases-design.md`）的 gateway（#630）与 core（#631）已就绪，运营者与出题人还没有界面，文档也未说明新字段。本 PR 是实施拆分第 3 步。

## Decision

- 「LLM → Provider 管理」页新增「模型别名」卡片：首行只读展示 `default`（取上方平台默认），其余行可新增 / 编辑 / 删除；显示引用题数，删除被引用的别名需二次确认并带 `force=true`。别名格式在前端预校验（与后端同一正则）。
- 出题编辑器 LLM 区域新增「允许调用的模型」多选，选项来自 `GET /api/v1/problems/llm-model-aliases`（只含别名与说明）；平台已删除但题目仍引用的别名保留显示并标注，便于出题人取消勾选；仅 `default` 时不写 `models`，保持与旧题 / 旧版本的草稿内容一致。
- 文档：出题（`llm-problem.md`）、题包标准、运营（`llm-call-capability.md`、`admin-guide.md`）补充别名用法与「先升级 gateway 再升级 core」的顺序。

## Alternatives considered

- 出题编辑器直接填真实模型名：会让题包重新绑定具体模型与 Provider，违背 2026-09-21 解耦。

## Consequences

- 前端仅做了类型检查与 lint，未做浏览器端点击验证（本地无管理员会话）。
- 跨服务 E2E（两个别名映射到 mock 上游不同模型）尚未补，需完整栈环境。
