## 1. 网关镜像加固

- [x] 1.1 在 LLM Gateway Dockerfile 中创建固定 UID 的非 root 用户并将 `/app` 交给该用户，验证 Dockerfile 包含用户切换和权限设置
- [x] 1.2 保持既有网关启动命令、端口和 Deno 运行环境，运行 Dockerfile 静态检查确认未引入配置回退

## 2. 回归验证

- [ ] 2.1 运行供应链检查、OpenSpec 严格校验和可用的 Docker smoke test，确认网关镜像以非 root 用户运行
