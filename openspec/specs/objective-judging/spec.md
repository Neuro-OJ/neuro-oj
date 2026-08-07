# objective-judging Specification

## Purpose
定义客观题提交与即时判定行为：服务端比对答案、练习/竞赛两种模式、提交历史与最高分。
## Requirements
### Requirement: 客观题提交与即时判定

系统 SHALL 提供 `POST /api/v1/objective/papers/:id/submit`（需登录）接受用户答案（`{question_id: [选项...]}`），在 noj-core 服务端即时比对判定，同步写入 `objective_submissions` 并返回判定结果。判定 SHALL 不走评测队列（noj-judge 无参与）。

判定规则 SHALL 为：每道小题给定答案与标准答案集合精确相等才算正确（单选/判断单元素、多选全选对），正确数占比换算卷面分（×100 整数存储）。

#### Scenario: 全部答对提交
- **WHEN** 用户提交的答案与该卷全部小题标准答案一致
- **THEN** 系统即时返回判定：逐题正确、卷面分 100，写入 objective_submissions（status='finished'）

#### Scenario: 部分答对提交
- **WHEN** 用户提交 5 道小题中答对 3 道
- **THEN** 卷面分为 60（×100 存储为 6000），details 记录逐题对错

#### Scenario: 多选不完全匹配不得分
- **WHEN** 多选小题标准答案为 ['A','C']，用户提交 ['A']
- **THEN** 该小题判为错误，不得分

#### Scenario: 提交无效套卷
- **WHEN** 用户对不存在的套卷 ID 提交
- **THEN** 系统返回 HTTP 404

#### Scenario: 提交非 O 型题目被拒
- **WHEN** 用户对 type='U' 或 type='P' 的题目调用客观题提交端点
- **THEN** 系统返回 HTTP 400

### Requirement: 练习模式提交

系统 SHALL 在无竞赛上下文（contest_id 为空）时按练习模式处理：允许同一用户对同一套卷重复提交，每次提交均落库并即时返回判定；用户成绩 SHALL 取历史提交的最高分。

#### Scenario: 练习重复提交
- **WHEN** 用户对同一套卷先后提交两次（第二次分数更高）
- **THEN** 两次提交均记录，用户该卷最高分为第二次的成绩

#### Scenario: 查询练习最高分
- **WHEN** 用户请求该套卷的提交历史与最高分
- **THEN** 系统返回提交列表及 MAX(score) 最高分

#### Scenario: 练习模式提交后展示解析
- **WHEN** 练习模式下用户提交并查看判定详情
- **THEN** 响应包含逐题对错与解析（explanation）

### Requirement: 竞赛模式提交

系统 SHALL 在提交携带 `contest_id` 时按竞赛模式处理，提交前 SHALL 校验：
1. 竞赛存在且状态为 `running`
2. 用户已注册参赛
3. 套卷属于该竞赛的 contest_problems
4. 该用户对该套卷在该竞赛下无既有提交（只允许一次）

违规 SHALL 返回 4xx 且不落库。

#### Scenario: 竞赛期间提交套卷
- **WHEN** 已注册用户在 running 竞赛中提交该竞赛题单内的套卷答案（首次）
- **THEN** 系统返回判定结果，objective_submissions 记录 contest_id 与 submission_type='contest'

#### Scenario: 竞赛重复提交被拒
- **WHEN** 参赛者对该套卷在同一竞赛中第二次提交
- **THEN** 系统返回 HTTP 400（或 409），不产生新记录

#### Scenario: 竞赛未开始或已结束提交被拒
- **WHEN** 参赛者在 pending / ended 竞赛中提交套卷
- **THEN** 系统返回 HTTP 403

#### Scenario: 未注册用户竞赛提交被拒
- **WHEN** 未注册用户在 running 竞赛中提交套卷
- **THEN** 系统返回 HTTP 403

#### Scenario: 提交非本竞赛题单套卷被拒
- **WHEN** 参赛者提交的套卷不在该竞赛 contest_problems 中
- **THEN** 系统返回 HTTP 400

#### Scenario: 竞赛模式提交后不展示解析
- **WHEN** 竞赛模式下用户提交后请求判定详情
- **THEN** 响应不含解析（explanation），防止泄题

### Requirement: 客观题提交历史

系统 SHALL 提供客观题提交记录查询：按用户 / 套卷 / 竞赛筛选的提交列表，以及单次提交详情（答案、得分、逐题判定）。判定详情（details，含期望答案）SHALL 仅提交者本人或 admin 可读。

#### Scenario: 查询本人提交历史
- **WHEN** 用户请求 `GET /api/v1/objective/submissions?paper_id=...`
- **THEN** 系统返回该用户对该套卷的提交列表（练习模式含最高分汇总）

#### Scenario: 他人提交详情不可读
- **WHEN** 普通用户请求他人提交的详情
- **THEN** 系统返回 HTTP 403

