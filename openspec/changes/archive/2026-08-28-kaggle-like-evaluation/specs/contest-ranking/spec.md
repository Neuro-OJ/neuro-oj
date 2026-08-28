## REMOVED Requirements

### Requirement: ICPC 罚时排名

**Reason**: 全局移除 AC/WA 和 ICPC 赛制，统一为类 Kaggle 分数制排名。
**Migration**: 使用 `kaggle-contest-ranking` 能力中的类 Kaggle 排名规则。

### Requirement: IOI/OI 总分排名

**Reason**: 移除 OI/IOI 赛制，统一为类 Kaggle 分数制排名。
**Migration**: 使用 `kaggle-contest-ranking` 能力中的类 Kaggle 排名规则。

### Requirement: 客观题提交计入竞赛排名

**Reason**: 旧规则依赖 AC/WA 映射，且仅适用于 ICPC/IOI/OI 赛制；类 Kaggle 赛制下客观题按分数参与排名。
**Migration**: 客观题提交在类 Kaggle 赛制中按 `objective_submissions.score` 作为该题分数参与最高分统计。

## MODIFIED Requirements

### Requirement: 竞赛排名公开规则

`GET /api/v1/contests/:id/ranking` SHALL 为类 Kaggle 竞赛提供实时榜和最终榜：

- 竞赛 running 期间：返回实时排名，参赛者可见自己的分数，主办方/管理员可见完整排名。
- 竞赛 ended 后：返回最终排名，所有访问者可见。
- 不提供封榜功能。

#### Scenario: 类 Kaggle 竞赛期间查看实时榜
- **WHEN** 类 Kaggle 竞赛 running 期间参赛者 A GET `/api/v1/contests/<id>/ranking`
- **THEN** 系统返回实时排名，包含 A 的分数

#### Scenario: 类 Kaggle 竞赛结束后查看最终榜
- **WHEN** 类 Kaggle 竞赛 ended 后任意访问者 GET `/api/v1/contests/<id>/ranking`
- **THEN** 系统返回最终排名，所有访问者可见
