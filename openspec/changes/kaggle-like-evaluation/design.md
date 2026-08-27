## Context

Neuro OJ 当前支持单文件代码提交（Solution 容器入口固定 `main.py`）和 AC/WA 二分状态，竞赛支持 ICPC/IOI/OI 三种赛制。为承接 IOAI / NOAI / LMCC 等 AI 领域竞赛，需要支持“选手自训自提、云端判分”的类 Kaggle 形态：多文件 zip 产物提交、连续分数评测、分数制排名。

本设计不包含 LLM 推理/微调题；提示词工程题仍通过 noj-llm-gateway 调用外部 LLM API 评测。CV/ML 小模型题由选手在 Solution 容器内自行推理。

## Goals / Non-Goals

**Goals:**
- 支持 `submission_mode=artifact` 的题目：选手上传 zip，平台解压后注入 Solution 容器，Evaluator 通过 `SolutionRunner` 调用 `submission.py` 函数评分。
- 新增 `noj-solution-ai` CPU 镜像，预装 torch/torchvision 及 CV/ML 常用库。
- 全局移除 AC/WA 状态，提交状态只保留 `pending / judging / finished / error`，分数是唯一结果。
- 统一“类 Kaggle 赛制”：每题取历史最高分，总分求和，平局按最后一次刷新最高分的提交时间早者优先。
- 比赛配置支持每道题独立提交次数限制。
- 提交 API 支持 zip 上传，列表/详情返回分数。
- artifact 上传采用流式写入存储，支持题目级大小限制 + NOJ 硬上限。
- artifact 评测完成后立即删除，不支持重测。

**Non-Goals:**
- 不做 LLM 推理/微调题。
- 不做 AB 榜（公开/私有榜）。
- 不做代码相似度检测、赛后答辩、可复现性抽查等额外反作弊措施。
- 不做 GPU 版 Solution 镜像（当前 CPU 推理即可）。
- 不保留旧 AC/WA 数据。
- 不支持 artifact 提交的重测（rejudge）。

## Decisions

### 1. 题目模型：`submission_mode`
- `problems` 新增 `submission_mode` 字段，取值 `code`（默认）或 `artifact`。
- `artifact` 题目仍使用双容器 + 支持包（evaluate.py 照旧）。
- 题目 manifest `problem.json` 增加可选 `submission_mode: "artifact"`。
- 理由：复用现有题目/评测体系，最小侵入。

### 2. 提交模型与 API
- `submissions` 新增 `artifact_storage_url`（`noj-storage://`）；`code` 在 artifact 模式下为空字符串。
- `file_name` 沿用，存上传的 zip 文件名（如 `submission.zip`）。
- `POST /api/v1/submissions` 支持两种：
  - 现有 JSON body（code 模式）
  - multipart/form-data（artifact 模式）：`problem_id` + `language` + `file`（zip）
- 上传方式：**流式上传**到存储，内存占用 O(1)：
  - local 模式：先写临时文件，再移入存储目录
  - S3 模式：使用 S3 multipart upload 分片上传
- 大小限制：**双层限制**
  - NOJ 硬上限：2GB（可配置环境变量）
  - 题目级限制：`problems.artifact_max_size_mb`（可空，空 = 用 NOJ 上限）；manifest 支持 `artifact_max_size_mb`
- 清理：**评测完成后立即删除** artifact 存储对象（无论 finished 还是 error）。
- 重测：**artifact 提交不支持 rejudge**；rejudge 接口对 artifact 提交返回错误。
- 理由：zip 统一覆盖预测文件、模型、多文件代码；流式上传支持大文件；立即删除避免存储膨胀。

### 3. JudgeTask 与 Judge 流程
- `JudgeTask` 新增 `artifact_download_url`（`noj-download://`）。
- noj-core 构建任务时，把 artifact 存储 URL 转成 judge 可下载 URL。
- noj-judge 双容器流程：
  - 支持包照旧注入 Evaluator。
  - 若存在 `artifact_download_url`：下载 zip → 解压 → 注入 **Solution 容器** `/workspace/`。
  - Solution 入口固定 `/workspace/submission.py`。
  - Evaluator 通过 `SolutionRunner` 调用 `submission.py` 中的函数。
- 理由：与现有双容器调用管线一致，选手只需按官方题习惯写 `submission.py`。

### 4. Solution AI 镜像
- 新增 `noj-solution-ai`，基于 `python:3.12-slim`。
- 安装：
  - `torch` / `torchvision`（CPU 版，PyTorch CPU index）
  - `noj_solution_sdk`
  - `opencv-python-headless`
  - `numpy` / `scipy` / `pandas` / `scikit-learn`
  - `Pillow` / `matplotlib`
  - `safetensors`
  - 可选：`timm`
- 构建脚本并入 `build-sdk-images.sh`，并在 `judge_images` 白名单注册。
- 理由：当前无 GPU 需求，CPU 版镜像更小、构建简单；未来可再出 CUDA 版。

### 5. 评测结果分数制
- 提交状态只保留 `pending / judging / finished / error`。
- `evaluationResults.status` 不再使用 `Accepted/WrongAnswer`。
- evaluate.py 结果 JSON **移除 `status` 字段**，只输出 `score`（0~10000 的 ×100 整数）与 `details`；judge 端统一映射为 `finished`，异常/超时映射为 `error`。
- evaluate.py 中的 AC/WA 仅作为 `details` 里的参考信息。
- 前端状态展示为“已评测 + 分数”，不使用“满分”字样。
- 理由：AI/LLM 题没有明确 AC/WA，分数制更符合连续评分。

### 6. 类 Kaggle 赛制
- 移除 OI/IOI/ACM 赛制，`contests.type` 只保留 `kaggle`；旧赛制竞赛数据直接废弃，不迁移。
- 排名规则：
  - 每题取历史最高分提交（同分取最早）。
  - 总分 = Σ(每题最高分)。
  - 平局按“最后一次**严格刷新**最高分的提交时间”早者优先；同分提交不算刷新。
- `contest_problems` 保留 `score`（每题满分 ×100）。
- 比赛配置 `contests.config` 支持：
  ```json
  {
    "submission_limits": { "<problem_id>": 15 }
  }
  ```
  每道题可单独配置提交次数上限；未配置则不限。提交次数**所有提交都计入**（含 error）。
- 理由：统一赛制降低复杂度，符合 AI 竞赛连续分数特点。

### 7. 超时与资源默认值
- Evaluator 总时限默认 **10 分钟**（`600000 ms`），作为官方默认上限。
- Solution 单次函数调用超时默认 **5 分钟**（`300000 ms`）。
- 第三方自部署可通过题目 `runtime_config` 调大。
- 理由：评测机资源有限，10 分钟是官方推荐默认值。

### 8. 反作弊
- 不做额外反作弊措施；云端判分本身就是约束——提交必须能跑起来并拿到分数。
- 理由：长周期比赛以“可运行、可评分”为准，降低运营成本。

### 9. artifact 语言与兜底清理
- artifact 模式固定 `language=python3`（入口是 `submission.py`，仅支持 Python）。
- 评测完成后立即删除 artifact；对于因 MQ 故障等一直未进入评测的提交，增加**兜底清理**：定期扫描超过 N 分钟仍处于 `pending` 的 artifact 提交，删除其存储对象并标记为 `error`。
- 理由：避免孤儿 artifact 占用存储。

## Risks / Trade-offs

- [zip 内可能包含恶意文件] → 复用现有 zip 安全校验（路径穿越、条目数、单文件/总大小限制），并在 Docker 沙箱内运行。
- [CPU 推理慢] → 默认 10 分钟总时限，CV/ML 小模型通常足够；若不够由第三方调大配置。
- [2GB 上传体积大] → 采用流式上传避免内存峰值；上传中断/超时需清理临时文件。
- [立即删除 artifact 后无法重测] → 设计上明确 artifact 不支持 rejudge，避免依赖已删除产物。
- [移除 AC/WA 影响现有算法题] → 需要同步修改 evaluate.py 协议和前端展示；旧数据不保留，避免迁移成本。
- [统一赛制丢失传统 ACM 玩法] → 符合新定位，若未来需要可再引入独立“ACM 模式”。

## Migration Plan

1. 数据库迁移：
   - `problems` 新增 `submission_mode`，默认 `code`。
   - `problems` 新增 `artifact_max_size_mb`（可空）。
   - `submissions` 新增 `artifact_storage_url`。
   - `contests.type` 约束改为仅 `kaggle`；`contests.config` 支持 `submission_limits`。
   - 旧 AC/WA 数据不保留（清空或忽略）。
   - 旧赛制竞赛数据直接废弃/删除，不迁移。
2. 代码变更顺序：
   - noj-core：schema → 提交 API → JudgeTask → 竞赛排名。
   - noj-judge：artifact 注入 → `noj-solution-ai` 镜像 → evaluate.py 协议。
   - noj-ui：上传页 → 状态展示 → 排名页。
3. 回滚策略：由于是 breaking change，回滚需恢复旧 schema 和旧 API；建议在功能分支完成后再合入。

## Open Questions

- 暂无阻塞性问题；`noj-solution-ai` 的具体包版本在实现时锁定。
