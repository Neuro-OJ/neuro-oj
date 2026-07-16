## 1. 文档站骨架

- [x] 1.1 创建顶层 `noj-docs/` 目录，加入 `mkdocs.yml`、依赖声明和基础 `docs/` 目录结构
- [x] 1.2 配置 MkDocs Material 主题、站点名称、中文导航、内置搜索、代码高亮和常用 Markdown 扩展
- [x] 1.3 编写 `noj-docs/README.md`，说明本地预览、严格构建和维护约定
- [x] 1.4 在仓库主 README 或合适入口补充 `noj-docs` 文档站链接和本地预览说明

## 2. 信息架构与通用页面

- [x] 2.1 创建文档首页，说明 NOJ 的定位、三类读者入口和推荐阅读路径
- [x] 2.2 创建做题人、运营者、出题人、参考四个导航分区的首页
- [x] 2.3 创建术语参考页，定义支持包、Evaluator、Solution、Solution Host、可见用例、隐藏用例、Judge Worker 和镜像白名单
- [x] 2.4 创建评测结果状态参考页，解释 Accepted、WrongAnswer、TimeLimitExceeded、RuntimeError 和 SystemError 的使用者语义

## 3. 做题人文档

- [x] 3.1 编写做题人快速开始，覆盖注册登录、查找题目、阅读题面和进入提交页
- [x] 3.2 编写提交代码文档，说明语言选择、文件名、代码提交和常见提交限制
- [x] 3.3 编写结果解读文档，说明队列状态、评测中状态、最终状态和常见错误信息

## 4. 运营者文档

- [x] 4.1 编写本地启动文档，覆盖 PostgreSQL、Redis、noj-core、noj-ui 和 noj-judge 的启动顺序
- [x] 4.2 编写初始化与 seed 文档，说明管理员初始化、题目 seed、支持包构建和重复执行语义
- [x] 4.3 编写存储与支持包交付文档，说明 `noj-storage://` 与 `noj-download://` 的职责分离
- [x] 4.4 编写 Judge Worker 运维文档，说明 Docker 镜像、镜像白名单、Redis MQ、容器池和常见故障排查入口

## 5. 出题人文档

- [x] 5.1 编写出题人总览，说明 NOJ 与传统 stdin/stdout OJ 的核心差异
- [x] 5.2 编写评测模型文档，说明 Evaluator 容器、Solution 容器、Solution Host、Evaluator SDK 和 Solution SDK 的调用关系
- [x] 5.3 编写题目支持包文档，说明 `problems-src/<id>/` 推荐结构、`evaluate.py`、`visible.jsonl`、`hidden.jsonl` 和生成 zip 包
- [x] 5.4 编写测试数据文档，说明可见用例、隐藏用例、JSONL 格式、分值字段和避免泄露隐藏数据的约定
- [x] 5.5 编写 Evaluator SDK 语义文档，说明如何调用用户函数、记录 case、给分、返回结构化详情和处理异常
- [x] 5.6 编写 Solution SDK 语义文档，说明用户函数暴露方式、函数缺失、顶层代码、stdout/stderr 和调试输出语义
- [x] 5.7 编写 A+B 示例题完整教程，覆盖题目源文件、evaluator 示例、用户正确提交、错误提交和打包验证

## 6. 校对与验证

- [x] 6.1 对照 `noj-core/data/problems-src`、seed 脚本和支持包构建脚本，校对文档中的路径、命令和字段名
- [x] 6.2 对照 `noj-judge` 双容器运行时、Python host 和 SDK 实现，校对出题人评测模型与 SDK 语义
- [x] 6.3 运行 `mkdocs build --strict`，确保导航、内部链接和 Markdown 构建通过
- [x] 6.4 检查文档中文表达，确保正文面向读者、避免混入内部 OpenSpec 或 Agent 工作流说明
