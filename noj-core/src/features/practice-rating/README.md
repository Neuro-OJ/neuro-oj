# practice-rating — 练习能力值（Best-N Practice Rating）

面向平时刷题与赛后补题的音游式 Best-30 能力值体系（issue
#810）。纯派生实时计算，不侵入提交主链路、不新增数据库迁移。

| 文件                    | 职责                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `index.ts`              | 唯一对外出口：`feature` 声明 + 公式与查询服务导出                         |
| `formula.ts`            | 纯函数公式（难度潜能、得分率权重、Best-30 聚合、段位判定）                |
| `service.ts`            | 主域公开题库有效成绩聚合查询与全站练习能力值榜                            |
| `routes.ts`             | `GET /api/v1/practice-rating/me`、`GET /api/v1/practice-rating/users/:id` |
| `tests/formula.test.ts` | 纯逻辑单元测试                                                            |
| `tests/service.test.ts` | 真实 PostgreSQL 集成测试（防刷、保密隔离、客观题、排行榜）                |
| `tests/routes.test.ts`  | HTTP 路由鉴权与参数解析测试                                               |

## 计算口径（`b30-v1`）

- 单题满分潜能：$B(d) = 50 + 2d + 0.025d^2$（$d \in [0, 100]$ 优先取
  `problem_difficulty.calibrated`，无校准行回退出题人三档
  `easy=25 / medium=50 / hard=75`）。
- 单题能力分：$P = \lfloor B(d) \cdot r^{1.5} + 0.5 \rfloor$（$r = \text{clamp}(\text{best\_score} / \text{full\_score}, 0, 1)$；0
  分不入榜）。
- 总练习能力值：官方主域（`main`）公开题库中单题能力分最高的 Best 30
  题目之和（`0..15000`）。

## 关键约束

- 仅统计主域（`DEFAULT_DOMAIN_ID`）已发布且绑定可用的公开题；私有域、教学域、团队域自建题彻底隔离。
- 进行中比赛提交与未结束公开赛保密保护期内的题目一律不计入；赛后自动纳入。
- 与竞赛 Rating、每日签到、社区互动（评论/点赞/举报）、LLM Gateway
  配额完全解耦。
- 排行榜入口挂载在 `read-models/queries/routes/rankings.ts` 的
  `GET /api/v1/rankings/practice-rating`。
