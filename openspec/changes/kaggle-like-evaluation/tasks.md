## 1. 数据库 Schema 与迁移

- [x] 1.1 `problems` 表新增 `submission_mode` 字段（默认 `code`），生成 Drizzle 迁移
- [x] 1.2 `problems` 表新增 `artifact_max_size_mb` 字段（可空），生成迁移
- [x] 1.3 `submissions` 表新增 `artifact_storage_url` 字段，生成迁移
- [x] 1.4 `contests.type` 约束改为仅 `kaggle`，`contest_problems.score` 改为 NOT NULL，生成迁移
- [x] 1.5 清理/废弃旧赛制竞赛数据（icpc/ioi/oi）
- [x] 1.6 更新 `schema-ddl.ts` 与 `schema.ts` 保持同步

## 2. noj-core：题目与提交 API

- [x] 2.1 题目创建/更新/响应 DTO 支持 `submission_mode` 与 `artifact_max_size_mb` 字段
- [x] 2.2 题目 manifest 校验支持 `submission_mode: "artifact"` 与 `artifact_max_size_mb`
- [x] 2.3 提交创建接口支持 multipart/form-data 上传 zip（artifact 模式）
- [x] 2.4 实现 artifact zip **流式上传**到存储（local 临时文件 / S3 multipart）
- [x] 2.5 实现双层大小限制（题目 `artifact_max_size_mb` + NOJ 硬上限）
- [x] 2.6 实现 artifact 评测完成后立即删除存储对象
- [x] 2.7 rejudge 接口对 artifact 提交返回“不支持重测”
- [x] 2.8 artifact 提交语言固定为 `python3`
- [x] 2.9 实现孤儿 artifact 兜底清理（超时 pending → 删除 + error）
- [x] 2.10 提交列表/详情接口返回 `result.score`，`result.status` 仅 `finished`/`error`
- [x] 2.11 移除 AC/WA 相关状态映射，evaluate.py 结果 JSON 移除 `status` 字段，按 `score` 解析

## 3. noj-core：JudgeTask 与竞赛

- [x] 3.1 `JudgeTask` 类型新增 `artifact_download_url`
- [x] 3.2 构建 JudgeTask 时把 artifact 存储 URL 转为 `noj-download://`
- [x] 3.3 竞赛创建/更新 API 仅允许 `type='kaggle'`，支持 `config.submission_limits`
- [x] 3.4 提交创建时校验比赛内每道题提交次数上限
- [x] 3.5 实现类 Kaggle 排名计算（最高分求和 + 时间平局）
- [x] 3.6 竞赛排名 API 返回实时榜/最终榜，移除 ICPC/IOI/OI 分支

## 4. noj-judge：artifact 注入与镜像

- [x] 4.1 `JudgeTask` Rust 类型新增 `artifact_download_url`
- [x] 4.2 双容器流程支持下载并解压 artifact zip 注入 Solution 容器 `/workspace/`
- [x] 4.3 Solution 入口在 artifact 模式下使用 `/workspace/submission.py`
- [x] 4.4 新增 `noj-solution-ai` Dockerfile（python:3.12-slim + CPU torch + CV/ML 库 + SDK）
- [x] 4.5 更新 `build-sdk-images.sh` 构建 `noj-solution-ai`
- [x] 4.6 更新 `judge_images` 种子数据，注册 `noj-solution-ai`
- [x] 4.7 更新 judge 结果解析：evaluate.py 结果无 `status` 字段，统一映射 `finished`/`error`

## 5. noj-ui：上传与展示

- [x] 5.1 题目详情页根据 `submission_mode` 显示 zip 上传控件或代码编辑器
- [x] 5.2 提交创建表单支持 multipart 上传 zip
- [x] 5.3 提交列表/详情状态展示改为“已评测 + 分数”，移除 AC/WA 文案
- [x] 5.4 竞赛排名页适配类 Kaggle 赛制（分数榜）
- [x] 5.5 管理后台题目编辑器支持设置 `submission_mode`

## 6. 测试

- [x] 6.1 noj-core 单元/集成测试：artifact 提交创建、流式存储、JudgeTask 构造
- [x] 6.2 noj-core 测试：双层大小限制、评测后立即删除、rejudge 拒绝、孤儿清理
- [x] 6.3 noj-core 测试：类 Kaggle 排名（严格刷新）、提交次数限制（含 error 计数）
- [x] 6.4 noj-judge E2E：小 zip（含 submission.py）注入与调用
- [x] 6.5 noj-judge E2E：`noj-solution-ai` 镜像可导入 SDK 并跑通推理
- [x] 6.6 noj-judge 测试：evaluate.py 无 `status` 字段的结果解析
- [x] 6.7 noj-tests 跨模块 E2E：上传 zip → 评测 → 分数展示 → artifact 删除
- [x] 6.8 更新相关 OpenSpec 归档与文档
