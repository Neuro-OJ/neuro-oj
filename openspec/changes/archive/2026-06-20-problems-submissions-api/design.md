## Design

### Architecture

```
noj-ui (Vue) ──REST API── noj-core (Deno+Hono)
                              │
                              ├── PostgreSQL (题目元信息)
                              ├── Redis MQ (评测任务)
                              └── 文件系统 (评测数据)
```

### API Design

#### 题目 API

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| GET | /api/v1/problems | No | 题目列表，支持 ?page=1&limit=20 |
| GET | /api/v1/problems/:id | No | 题目详情 |

#### 提交 API

| Method | Path | Auth | 说明 |
|--------|------|------|------|
| POST | /api/v1/submissions | JWT | 创建提交 |
| GET | /api/v1/submissions/:id | JWT | 提交详情 |

### Data Model

#### problems 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | text | 主键，如 "1001" |
| title | text | 标题 |
| description | text | 描述 |
| difficulty | text | 难度 |
| judge_image | text | Docker 镜像 |
| judge_command | text | 评测命令 |
| time_limit_ms | integer | 时间限制 |
| memory_limit_mb | integer | 内存限制 |

#### submissions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | text | 主键 (UUID) |
| user_id | text | 外键 → users.id |
| problem_id | text | 外键 → problems.id |
| language | text | 编程语言 |
| code | text | 用户代码 |
| status | text | pending/judging/finished |

### 评测流程

1. 用户 POST /submissions → 创建记录 + 状态 pending
2. noj-core 调用 pushJudgeTask() → 推送任务到 Redis MQ
3. noj-judge BRPOP 任务 → 执行评测
4. noj-judge 回调 → 更新 evaluation_results
5. 用户 GET /submissions/:id → 返回状态 + 结果

### 示例题设计 (1001 T0-LMCC)

- **类型**: 字段级评分
- **总分**: 10 分 (内容 8 + 格式 2)
- **数据**: visible.jsonl (8条) + hidden.jsonl (4条)
- **评测**: 执行 evaluate.py 比对字段