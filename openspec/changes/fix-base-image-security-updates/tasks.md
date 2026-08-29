## 1. 镜像安全更新

- [x] 1.1 在 Python evaluator/solution Dockerfile 中加入 Debian 安全包更新并保留固定 digest、非 root 用户，使用 Dockerfile 检查确认
- [x] 1.2 在 LLM Gateway Dockerfile 中加入 Alpine 安全包更新并保留现有 Deno 启动方式，使用 Dockerfile 检查确认

## 2. 供应链回归检查

- [x] 2.1 扩展供应链检查和测试，验证三份受影响 Dockerfile 必须有安全更新步骤，并验证删除步骤会失败

## 3. 验证

- [x] 3.1 运行 Shell 语法、供应链正负向测试、OpenSpec 严格校验和受影响镜像构建/Trivy 扫描；若本地镜像仓库不可用，记录并依赖 Release workflow 验证
