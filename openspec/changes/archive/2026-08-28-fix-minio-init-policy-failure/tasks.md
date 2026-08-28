## 1. 修复初始化失败闭环

- [x] 1.1 移除 `minio-init` 对不可用 `sed` 的依赖，使用镜像内置 shell 能力渲染 bucket-scoped policy
- [x] 1.2 启用严格错误处理，确保 policy、用户和绑定失败返回非零状态

## 2. 验证

- [x] 2.1 运行 Docker Compose 配置校验和 MinIO policy 语法校验
- [x] 2.2 在独立 MinIO Compose 项目中验证应用凭据读写目标 bucket
- [x] 2.3 验证应用凭据不能访问其他 bucket 或 MinIO 管理接口
- [x] 2.4 运行 #324/#332 合并后 LLM 定向 E2E 与 Judge E2E，确认组合行为无回归
