# Agent Note: 编辑器保存草稿清空界面题模板

Status: implemented

## Problem

2026-10-16 模拟赛中 P23（界面题）全部 20 条提交评测出错，评测器报
`function 'get_config' not registered`。题包内有 `template.py`，导入时也正确写入
了草稿，但出题人随后在网页编辑器里保存并发布：`CodingProblemEditor` 的
`buildContent()` 固定回传 `template_content: ""`，`PUT /problems/:id/draft`
原样落库，发布出的 V1 模板为空。界面题评测脚本 = 参数 + 模板，模板为空时
Solution 容器没有注册任何函数。

## Decision

`template_content` 是服务端从题包派生的字段（`updateProblem` 已有同口径守卫），
客户端草稿保存不应能改写它。`saveProblemDraft` 新增 `fromClient` 选项，仅草稿
路由传入：在持锁事务内以当前草稿（无草稿行时为派生草稿）的模板覆盖客户端值。
导入、支持包上传等服务端流程不受影响。

## Alternatives considered

只改前端（不回传模板或回传读取到的模板）：旧前端与其他客户端仍可清空，且客户端
能写入任意模板，绕过"仅题包导入写模板"的约束。把空串视为"未提供"：语义含糊，
非空伪造值仍能写入。

## Consequences

无迁移、无 Judge 协议变化，只需重新部署 core。客户端无法再通过草稿接口修改模板，
修改模板只能重新导入题包。已发布的空模板版本不可变，需重新导入题包并发布新版本，
再把出错提交重测到新版本。
