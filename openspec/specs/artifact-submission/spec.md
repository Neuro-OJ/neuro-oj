## Purpose

定义 Neuro OJ 类 Kaggle 产物提交（artifact submission）规范，覆盖题目模式、zip 上传、评测注入与清理。

## Requirements

### Requirement: 题目支持 artifact 提交模式

系统 SHALL 在 `problems` 表提供 `submission_mode` 字段，取值 `code`（默认）或 `artifact`。`artifact` 题目要求选手上传 zip 产物，而不是提交单文件代码。

题目 manifest `problem.json` SHALL 支持可选 `submission_mode: "artifact"` 字段。

#### Scenario: 创建 artifact 题目

- **WHEN** 管理员创建题目时设置 `submission_mode: "artifact"` 且提供 `runtime_config`
- **THEN** 系统创建成功，题目详情返回 `submission_mode: "artifact"`

#### Scenario: 默认 submission_mode 为 code

- **WHEN** 用户创建题目且未传 `submission_mode`
- **THEN** 系统默认 `submission_mode: "code"`

#### Scenario: 非法 submission_mode 被拒

- **WHEN** 用户创建题目时传入 `submission_mode: "prediction"`
- **THEN** 系统返回 HTTP 400，提示仅允许 `code` / `artifact`

### Requirement: 选手上传 zip 产物提交

系统 SHALL 允许 artifact 题目通过 `POST /api/v1/submissions` 以 multipart/form-data 上传 zip 文件。请求包含 `problem_id`、`language`、`file`（zip）。

上传 SHALL 采用**流式写入存储**，内存占用 O(1)：
- local 模式：先写临时文件，再移入存储目录
- S3 模式：使用 S3 multipart upload 分片上传

服务端 SHALL 校验：
- 题目必须是 `submission_mode=artifact`
- 必须上传 zip 文件
- zip 大小不得超过题目级限制（`problems.artifact_max_size_mb`，可空）与 NOJ 硬上限（默认 2GB）中的较小值
- zip 安全校验（路径穿越、条目数、单文件/总大小限制）复用现有支持包校验

提交记录 SHALL 存储 `artifact_storage_url`（`noj-storage://`），`file_name` 存上传的 zip 文件名，`code` 为空字符串。

#### Scenario: 成功上传 artifact 提交

- **WHEN** 已登录用户向 artifact 题目上传合法 zip
- **THEN** 系统创建提交记录，返回 201，`file_name` 为 zip 文件名，`artifact_storage_url` 非空

#### Scenario: 向 code 题目上传 zip 被拒

- **WHEN** 用户向 `submission_mode=code` 的题目上传 zip
- **THEN** 系统返回 HTTP 400，提示该题目不支持 artifact 提交

#### Scenario: artifact 题目缺少 zip 被拒

- **WHEN** 用户向 artifact 题目提交 JSON body（无 file）
- **THEN** 系统返回 HTTP 400，提示必须上传 zip 文件

#### Scenario: zip 超过题目级大小限制被拒

- **WHEN** 用户上传的 zip 超过该题 `artifact_max_size_mb` 配置
- **THEN** 系统返回 HTTP 400，提示文件超过该题大小限制

#### Scenario: zip 超过 NOJ 硬上限被拒

- **WHEN** 用户上传的 zip 超过 NOJ 硬上限（默认 2GB）
- **THEN** 系统返回 HTTP 400，提示文件过大

### Requirement: artifact 固定 Python 语言

系统 SHALL 将 artifact 提交的语言固定为 `python3`，不接受其他语言。

#### Scenario: artifact 提交语言固定 python3

- **WHEN** 用户向 artifact 题目上传 zip 并指定 `language`
- **THEN** 系统忽略或强制为 `python3`

### Requirement: artifact 评测完成后立即删除

系统 SHALL 在 artifact 提交评测完成（`finished` 或 `error`）后，立即删除该提交对应的 artifact 存储对象。

#### Scenario: 评测完成后删除 artifact

- **WHEN** artifact 提交评测结束，状态为 `finished` 或 `error`
- **THEN** 系统删除 `artifact_storage_url` 指向的存储对象

### Requirement: artifact 提交不支持重测

系统 SHALL 拒绝针对 artifact 提交的 rejudge 请求，返回错误提示“artifact 提交不支持重测”。

#### Scenario: 对 artifact 提交发起 rejudge 被拒

- **WHEN** 管理员对 artifact 提交调用 rejudge 接口
- **THEN** 系统返回 HTTP 400，提示 artifact 提交不支持重测

### Requirement: 孤儿 artifact 兜底清理

系统 SHALL 定期扫描长时间停留在 `pending` 状态的 artifact 提交，删除其 artifact 存储对象并标记为 `error`，避免因 MQ 故障产生孤儿文件。

#### Scenario: 超时未评测的 artifact 被清理

- **WHEN** artifact 提交超过 N 分钟仍处于 `pending`
- **THEN** 系统删除该提交的 artifact 存储对象，并将提交状态置为 `error`

### Requirement: JudgeTask 携带 artifact 下载地址

系统 SHALL 在 `JudgeTask` 中新增 `artifact_download_url` 字段（`noj-download://`）。noj-core 构建评测任务时，若提交为 artifact 模式，SHALL 将 `artifact_storage_url` 转换为 judge 可下载的 URL 并放入该字段。

#### Scenario: artifact 提交生成带 artifact 的任务

- **WHEN** noj-core 为 artifact 提交构建 JudgeTask
- **THEN** 任务包含 `artifact_download_url`，指向该提交的 zip 内容

#### Scenario: code 提交不携带 artifact 字段

- **WHEN** noj-core 为 code 提交构建 JudgeTask
- **THEN** 任务不包含 `artifact_download_url`

### Requirement: Judge 将 artifact 注入 Solution 容器

系统 SHALL 在双容器评测流程中，若 JudgeTask 存在 `artifact_download_url`，下载 zip 并解压注入 **Solution 容器** `/workspace/` 目录。Solution 入口固定为 `/workspace/submission.py`。

Evaluator SHALL 继续通过 `SolutionRunner` 调用 `submission.py` 中注册的函数进行评分。

#### Scenario: artifact 注入 Solution 容器

- **WHEN** JudgeTask 包含 `artifact_download_url`，且 zip 内含 `submission.py`
- **THEN** judge 将 zip 解压注入 Solution 容器，Solution host 以 `/workspace/submission.py` 为入口启动

#### Scenario: zip 缺少 submission.py 导致评测失败

- **WHEN** 上传的 zip 内没有 `submission.py`
- **THEN** Solution host 启动失败，评测返回 error

### Requirement: Solution AI 镜像

系统 SHALL 提供 `noj-solution-ai` 镜像，基于 `python:3.12-slim`，预装 CPU 版 `torch` / `torchvision`、`noj_solution_sdk`、`opencv-python-headless`、`numpy` / `scipy` / `pandas` / `scikit-learn`、`Pillow` / `matplotlib`、`safetensors`。

该镜像 SHALL 被加入 `judge_images` 白名单，kind 为 `solution`。

#### Scenario: 构建并使用 Solution AI 镜像

- **WHEN** 管理员创建 artifact 题目时指定 `runtime_config.solution.image: "noj-solution-ai"`
- **THEN** 系统通过白名单校验，允许使用该镜像

#### Scenario: Solution AI 镜像可导入 SDK

- **WHEN** 构建 `noj-solution-ai` 镜像
- **THEN** 构建期验证 `noj_solution_sdk` 可导入
