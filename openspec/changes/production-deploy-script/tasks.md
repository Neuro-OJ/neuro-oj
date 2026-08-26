## 1. 部署脚本基础能力

- [x] 1.1 新增 `scripts/deploy/deploy.sh`，解析仓库根目录、生产环境文件、Compose 文件和命令参数，并验证 Bash、Docker 与 Docker Compose 可用；通过 `bash scripts/deploy/deploy.sh --help` 验证帮助输出。
- [x] 1.2 实现生产配置初始化、占位值检查、必填项检查、`.env.prod` 权限检查和 Compose 配置检查；通过临时配置文件验证缺失项/占位值返回非零且不打印 secret。
- [x] 1.3 实现 Docker daemon、宿主端口和 `JUDGE_DOCKER_SOCKET` 隔离配置检查；通过模拟缺失/危险 socket 配置验证脚本在启动前失败。

## 2. 生命周期与初始化

- [x] 2.1 实现 `install`，在首次安装时创建并保护 `.env.prod`、生成必要随机密钥、提示用户补齐人工配置，并在配置完整后拉取镜像、运行迁移初始化、启动服务和等待健康状态；通过 shell smoke test 验证命令顺序和失败传播。
- [x] 2.2 实现 `start`、`stop`、`status` 和 `logs [service] [--follow]`，确保停止操作不使用 `down -v` 或删除数据卷；通过 shell 单元测试验证 Compose 参数和退出码传递。
- [x] 2.3 实现 `upgrade`，按配置的 `NOJ_VERSION` 拉取镜像、执行 Compose 更新、等待健康状态并保留数据卷；通过 dry-run/模拟 Compose 验证升级不会调用破坏性清理。
- [x] 2.4 实现 `backup`，使用 PostgreSQL 容器创建带时间戳的 custom-format 备份，设置受限文件权限且不覆盖已有文件；通过模拟数据库容器验证备份路径、权限和失败传播。

## 3. 文档与可运维性

- [x] 3.1 更新 `scripts/README.md` 和生产部署文档，记录安装前置条件、命令、配置文件、镜像源/代理排查、LLM Gateway、Judge 隔离 socket、备份边界和回滚方式；通过文档链接和命令示例检查确认内容完整。
- [x] 3.2 更新部署模板或必要的 Compose 配置说明，确保脚本使用的变量与 `.env.prod.example`、`docker-compose.prod.yml` 一致；通过 `docker compose --env-file .env.prod.example -f docker-compose.prod.yml config`（使用测试替换值）验证配置可解析。

## 4. 验证

- [x] 4.1 为脚本增加不依赖真实生产资源的 shell 测试，覆盖帮助、初始化保护、secret 不泄露、非法配置、命令退出码和数据卷安全边界；通过项目约定的脚本测试命令运行。
- [x] 4.2 运行 ShellCheck（若环境可用）、Compose 配置校验、完整 Bash 语法检查和生产部署 smoke test，并记录未覆盖的真实 Docker/网络前置条件；通过所有可执行检查后完成本变更。
