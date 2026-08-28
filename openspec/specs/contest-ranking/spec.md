## Purpose

定义竞赛排名公开规则规范。类 Kaggle 分数制排名的详细计算规则见 `kaggle-contest-ranking` 能力。

## Requirements

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
