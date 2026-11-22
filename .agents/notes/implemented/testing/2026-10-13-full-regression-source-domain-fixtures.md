# Agent Note: 源域收缩全量回归的共享夹具与分片修复

Status: implemented

## Problem

0135 源 Domain 非空收缩后的全 core 并行回归发现 15 个失败：共享版本约束夹具仍
缺少域或使用旧 P/U 字段；0109 历史迁移回放种子仍使用当前 Schema 已移除的列；
三个搜索夹具缺少真实 owned binding；初始化管理员测试直接物理删除审计作者； 新增
Gateway HTTP 测试未登记并行分片。

## Decision

- 共享版本约束夹具明确 main 归属，并在模块开始执行一次标准 reset，使 PGlite
  独立测试 worker 建立实际默认域。保留版本、判定、复合外键及不可变守卫断言。
- 0109 回放在当前 Schema 执行历史迁移语句，因此种子移除旧分类并保存 main；
  迁移语义断言保留。此前将其误认为独立历史 Schema，已更正上一份夹具记录。
- 搜索夹具发布版本后通过 catalog 公开门面补齐真实本域绑定，不放宽搜索过滤或
  撤销授权规则。匿名公开搜索的原断言保留。
- 初始化管理员用例注册真实继任成员、交接默认域，再通过现有注销业务删除自己。
  保留账号和审计历史，继续证明初始化封闭标记不因管理员消失而重开。
- 并行分片登记 gateway/tests/routes，新增 HTTP 版本契约回归进入标准全量执行。
- 不修改业务权限、数据约束、生产服务或 0135 Schema。

## Alternatives considered

- 放宽搜索以允许没有绑定的题目：把不合法资源误当公开题，拒绝。
- 删除 audit_logs 再物理清除管理员：丢失治理依据且不符合账号注销规则，拒绝。
- 让 PGlite 默认 FK 不检查：不能证明真实约束，拒绝。
- 忽略新增未分片测试：会导致标准全量永远不执行版本回归，不采用。

## Consequences

所有 15 个失败原因在夹具与执行登记层修复，没有放宽产品约束。 标准 shared
本轮也验证测试分片完整覆盖。

最终标准验证通过：shared PGlite 293 passed / 0 failed / 16 ignored，真实
PostgreSQL 303 passed / 0 failed / 6 ignored；identity PGlite 313 passed / 0
failed / 26 ignored，PostgreSQL 339 passed / 0 failed；search 两库均 35 passed /
0 failed / 1 ignored（性能场景需显式启用）。 6 个修改源文件类型、fmt/lint 与
diff 检查通过。完整 core 全量二次验收由 root
统一运行，不以这些局部回归替代完整产品验收。
