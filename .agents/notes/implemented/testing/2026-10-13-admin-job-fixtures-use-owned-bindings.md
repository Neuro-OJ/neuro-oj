# Agent Note: 管理任务 HTTP 夹具使用真实题库绑定

Status: implemented

## Problem

默认域执行解析器要求源题存在有效 owned 绑定。 管理任务 HTTP
测试手工插入题目与版本，却没有建立题库绑定，导致受理路径返回 404，
无法验证重测、重试及权限的原有行为。

## Decision

管理任务夹具在手工版本与最新版指针就绪后调用已有
`bindPublishedProblemForTest`，提交保存对应 main 与绑定 ID。
身份管理的两个活动提交重测夹具采用相同显式绑定，并在清理时先删除任务、提交，
再调用已有题库夹具清理工具释放绑定与源题。

身份管理的历史未知版本样本保持原来的无提交版本状态，不为通过测试人为发布版本。
HTTP 202、活动提交保持 judging、幂等受理及本人／他人／管理员权限断言不作放宽。

## Alternatives considered

- 执行解析器缺绑定时自动创建：会把缺失归属变成隐式授权，不修改生产服务。
- 将 202 断言改为 404 或忽略失败：不再覆盖管理任务真实受理流程。
- 为未知版本提交填入新版本：改变测试需要检验的历史状态，不采用。

## Consequences

只调整两个测试文件，复用已有测试工具；不修改生产服务、Schema、迁移或共享夹具。
标准 admin 和 identity 模块分别在 PostgreSQL、PGlite 执行回归， identity
使用实际 token 撤销检查，不启用 JWT 撤销 bypass。 admin 两库各通过 17
项；identity PostgreSQL 通过 339 项，PGlite 通过 332 项、 忽略 7
个数据库专用场景。完整 core 类型检查及受影响文件格式、lint 检查通过。
