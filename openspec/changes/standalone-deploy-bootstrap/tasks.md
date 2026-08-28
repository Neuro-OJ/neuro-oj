## 1. Bootstrap 下载器

- [x] 1.1 新增可脱离仓库运行的 `scripts/deploy/install.sh`，解析仓库、ref、目标目录、dry-run 和 download-only 参数，并验证 Bash、curl/wget 与 tar 可用；通过 `bash scripts/deploy/install.sh --help` 验证帮助输出。
- [x] 1.2 实现 HTTPS 归档下载、ref 校验、临时目录管理、单顶层目录校验和危险路径拒绝；通过伪造下载器和测试 tar 归档验证失败清理与安全解压。
- [x] 1.3 实现目标目录为空时安装、非空时拒绝覆盖、下载完成后调用 `deploy.sh install` 和参数/退出码传递；通过 fake 项目归档验证调用参数与目录保护。
- [x] 1.4 增加 `check` 命令，检测 Linux、架构、基础工具、Docker/Compose、内存、磁盘和默认端口，并对阻断性问题返回非零；通过 fake 命令和临时环境验证输出及退出码。
- [x] 1.5 增加 `install-env` 命令，按受支持的 Linux 包管理器安装基础工具，Docker 缺失时仅输出安装提示且不修改 Docker 软件源或 daemon；通过 fake 包管理器验证命令选择与失败边界。

## 2. 文档与测试

- [x] 2.1 新增 bootstrap shell smoke test，覆盖帮助、dry-run、下载失败、危险归档、空目录安装、非空目录保护和部署失败传播；通过项目约定命令运行。
- [x] 2.2 更新 `scripts/README.md` 和生产部署文档，记录单脚本下载命令、固定 ref、目标目录、首次配置和后续升级边界；通过文档中的命令与脚本参数保持一致验证。
- [x] 2.3 扩展 bootstrap smoke test，覆盖 `check`、`install-env`、不支持系统、Docker 缺失和资源摘要；通过离线测试运行。

## 3. 验证

- [x] 3.1 运行 Bash 语法检查、OpenSpec 校验、bootstrap smoke test，并在 ShellCheck 可用时运行 ShellCheck；记录真实网络、Docker 和生产环境未覆盖的前置条件。
