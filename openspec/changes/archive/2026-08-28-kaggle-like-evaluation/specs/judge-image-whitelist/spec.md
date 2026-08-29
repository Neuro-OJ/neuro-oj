## ADDED Requirements

### Requirement: 支持 Solution AI 镜像

系统 SHALL 将 `noj-solution-ai` 作为合法的 Solution 镜像纳入 `judge_images` 白名单，kind 为 `solution`。

`noj-solution-ai` 镜像 SHALL 基于 `python:3.12-slim`，预装 CPU 版 `torch` / `torchvision`、`noj_solution_sdk`、`opencv-python-headless`、`numpy` / `scipy` / `pandas` / `scikit-learn`、`Pillow` / `matplotlib`、`safetensors`。

#### Scenario: 管理员添加 Solution AI 镜像

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `{ "image": "noj-solution-ai", "mode": "exact", "kind": "solution", "description": "Solution AI 推理环境" }`
- **THEN** 系统创建白名单记录，返回 HTTP 201

#### Scenario: artifact 题目使用 Solution AI 镜像

- **WHEN** 管理员创建 artifact 题目时指定 `runtime_config.solution.image: "noj-solution-ai"`
- **THEN** 系统通过白名单 + kind 校验，允许使用该镜像
