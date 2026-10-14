# Agent Note: P/U 分类退役后的 core 测试夹具对齐

Status: implemented

## Problem

题目 Schema 收缩移除 P/U 分类后，已有大量测试继续向 `problems` 插入 type，
导致全 core 类型检查失败。部分夹具以客观题状态推导 P/U，或使用对象变量隐含携带
旧属性，不能只修改编译器报错的第一处。旧 U 数据阻止回填的测试也已不符合分类退役
后的运行时模型；存量旧 U 检查属于收缩迁移的前置保护。

## Decision

- 从直接或批量数据库题目插入夹具移除旧分类属性，保留 is_objective、judge_type、
  版本内容和比赛类型，题型及评测路径不由 P/U 决定。
- 清理动态分类 helper 和共享比赛夹具的旧属性，更新唯一题号注释为域内编号。
- 将旧 U 回填阻断用例改为分类退役后两题正常归入默认域，重复执行不重复建立绑定。
  原有回填保留 ID、版本、题号及 exact 策略、幂等不覆盖修改后策略的测试继续保留。
- 保留格式 1 P 题包转换与 U 题包拒绝测试，以及 HTTP 请求携带旧 type 的拒绝
  回归。客观题 question.type、contest.type 与社区帖子类型不属于此清理范围。
- core 开发文档删除 create_p 权限描述；普通用户权限测试改用现存的
  problem:write_any，继续验证未授权能力。
- 不修改共享 Schema、DDL、迁移或生产 backfill；root 独立处理这些文件与迁移。

## Alternatives considered

- 全仓文本替换所有 type：会破坏题包升级边界、客观题和比赛契约，拒绝。
- 继续在数据库夹具保留 type 并使用类型断言绕过编译：掩盖已退役模型，拒绝。
- 将旧 U fixture 强行写入新 Schema：会创建不可能存在的运行时状态，不采用。

## Consequences

分类退役后的测试输入与新 Schema 一致，兼容与拒绝契约仍有明确覆盖。
修改夹具仅删除已退役的身份分类，不改变题型、资源可见性或原评测断言。

全 core 标准 `deno task check:types` 通过；本批 93 个 TypeScript 夹具的格式与
lint 通过。完整标准域回归由 root 统一执行，本记录不将类型检查视为数据库、
浏览器或迁移验收。
