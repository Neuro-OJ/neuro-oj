## 1. 镜像安全更新

- [x] 1.1 在三个 Python Dockerfile 中统一加入 Debian 安全包更新并保留固定 digest、非 root 用户，使用 Dockerfile 检查确认
- [x] 1.2 在 LLM Gateway Dockerfile 中加入 Alpine 安全包更新并保留现有 Deno 启动方式，使用 Dockerfile 检查确认
- [x] 1.3 在三个 Python Dockerfile 中统一升级 setuptools、wheel 和 jaraco.context 到规范要求的安全版本

## 2. 供应链回归检查

- [x] 2.1 扩展供应链检查和测试，验证三份受影响 Dockerfile 必须有安全更新步骤，并验证删除步骤会失败
- [x] 2.2 扩展供应链检查和测试，验证任一 Python Dockerfile 缺少 Python 打包工具升级步骤时会失败

## 3. 验证

- [x] 3.1 运行 Shell 语法、供应链正负向测试、OpenSpec 严格校验和受影响镜像构建/Trivy 扫描；若本地镜像仓库不可用，记录并依赖 Release workflow 验证
- [x] 3.2 运行统一安全更新检查；本地 Docker 拉取固定基础镜像时因网络 EOF 未完成构建，依赖 Release workflow 完成真实镜像和 Trivy 验证
