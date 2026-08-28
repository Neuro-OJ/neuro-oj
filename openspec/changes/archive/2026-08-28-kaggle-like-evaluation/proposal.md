## Why

Neuro OJ 需要支持 IOAI / NOAI / LMCC 等 AI 领域认证与竞赛，其中大量题目是“选手自训自提、云端判分”的类 Kaggle 形态。当前系统只支持单文件代码提交和 AC/WA 二分状态，无法承载多文件产物提交、连续分数评测和分数制竞赛排名。

## What Changes

- **新增 artifact 提交模式**：题目可配置 `submission_mode=artifact`，选手上传 zip（含 `submission.py` 及多文件实现），平台解压后注入 Solution 容器，Evaluator 通过 `SolutionRunner` 调用 `submission.py` 中的函数评分。
- **流式上传与双层大小限制**：artifact 采用流式写入存储（local 临时文件 / S3 multipart），大小限制为“题目 `artifact_max_size_mb` + NOJ 硬上限（默认 2GB）”。
- **评测后立即删除**：artifact 评测完成后立即删除存储对象，且 artifact 提交不支持 rejudge。
- **新增 Solution AI 镜像**：`noj-solution-ai`，基于 `python:3.12-slim` + CPU 版 torch/torchvision，预装 CV/ML 常用库，供 artifact 题推理使用。
- **评测结果改为分数制**：全局移除 AC/WA 状态，提交状态只保留 `pending / judging / finished / error`，分数是唯一结果；evaluate.py 输出 `score` 而非 `status`。
- **统一“类 Kaggle 赛制”**：移除 OI/IOI/ACM 赛制，竞赛排名改为“每题取历史最高分，总分求和，平局按最后一次刷新最高分的提交时间早者优先”。
- **比赛配置支持每道题独立提交次数限制**：提交次数限制放在比赛配置中，而非题目 manifest。
- **API/UI 同步调整**：提交接口支持 zip 上传，提交列表/详情返回分数而非 AC/WA，前端状态展示改为“已评测 + 分数”。

## Capabilities

### New Capabilities
- `artifact-submission`: 支持 zip 产物提交、Solution 容器注入、Evaluator 调用 `submission.py` 函数评分。
- `kaggle-contest-ranking`: 类 Kaggle 分数制竞赛排名，每题取最高分、总分求和、时间平局，以及比赛级每道题提交次数限制。

### Modified Capabilities
- `submission-status-tracking`: 移除 AC/WA 状态，提交状态只保留生命周期状态，结果以分数表达。
- `contest-management`: 移除 OI/IOI/ACM 赛制，新增类 Kaggle 赛制配置与每道题提交次数限制。
- `problem-management`: 题目新增 `submission_mode` 字段（code/artifact）。
- `judge-image-whitelist`: 新增 `noj-solution-ai` 镜像白名单。
- `submission-list-api`: 提交创建支持 zip 上传，提交列表/详情返回分数而非 AC/WA。

## Impact

- **noj-core**：`problems`、`submissions`、`contests`、`contest_problems` 表结构变更；提交创建/列表/详情 API 变更；JudgeTask 新增 artifact 下载字段；竞赛排名逻辑重写。
- **noj-judge**：双容器流程支持 artifact zip 注入 Solution 容器；新增 `noj-solution-ai` 镜像构建；evaluate.py 协议改为输出 `score`。
- **noj-ui**：题目详情页支持 zip 上传；提交状态展示改为“已评测 + 分数”；竞赛排名页适配类 Kaggle 赛制。
- **noj-llm-gateway**：不受影响（提示词工程题仍走外部 LLM API）。
- **数据库**：需要新增迁移；旧 AC/WA 数据不保留。
