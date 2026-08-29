## 1. 统一命令入口

- [x] 1.1 新增根目录可执行 `noj` 脚本，解析自身所在的生产安装目录并在底层部署脚本缺失时返回清晰错误；使用 `bash -n noj` 和 `./noj --help` 验证
- [x] 1.2 实现 `install`、`start`、`stop`、`update`、`status`、`logs`、`backup`、`verify` 命令映射，并透传底层参数；使用伪造部署脚本测试每个命令的转发和退出码
- [x] 1.3 实现 `restart` 和 `config check`，验证停止/启动顺序、配置检查不改变服务状态，并验证失败时返回非零退出码

## 2. 安装与更新集成

- [x] 2.1 扩展已有安装更新流程，使 `scripts/deploy/install.sh` 更新生产部署文件时同步复制根目录 `noj` 并恢复执行权限；使用临时安装目录测试新安装和已有安装更新均保留 `.env.prod`
- [x] 2.2 确认旧的 `scripts/deploy/deploy.sh upgrade`、`install` 和其他既有命令保持兼容；运行现有 `scripts/deploy/test-deploy.sh` 并验证原命令行为不变

## 3. 文档与测试

- [x] 3.1 为 `noj` 增加无 Docker 的命令路由测试，覆盖帮助、未知命令、参数透传、`restart`、`update` 和配置检查；运行新增测试脚本并检查断言通过
- [x] 3.2 更新 README、生产部署文档和 scripts 索引，说明 `./noj` 的常用命令、版本来源、数据卷安全边界和高级命令兼容入口；运行 Markdown 链接检查
- [x] 3.3 执行 Shell 语法检查、OpenSpec 校验和相关部署脚本测试，确认没有 secret 输出、数据卷删除或宿主机 Docker socket 自动挂载行为

## 4. PATH 注册

- [x] 4.1 使 `noj install` 和 bootstrap 安装成功后自动注册标准 PATH 命令，解析软链接定位真实安装目录，拒绝覆盖同名命令
- [x] 4.2 扩展无 Docker 测试，覆盖全局 PATH 注册、用户级 PATH 回退、重复注册和同名命令保护
- [x] 4.3 更新帮助与生产部署文档，说明直接执行 `noj` 的生效条件及权限不足时的处理方式；完成 Shell 语法和 OpenSpec 校验

## 5. 统一安装与更新入口

- [x] 5.1 将 setup.sh 定义为唯一推荐首次安装入口，并让内部 bootstrap 将首次部署委托给目标目录的 `noj install`，保留旧脚本兼容
- [x] 5.2 让 `noj update` 按 `.env.prod` 的 `NOJ_VERSION` 同步部署文件和 CLI，再执行原有带备份的生产升级流程，并支持 `--dry-run`
- [x] 5.3 更新所有生产安装/升级文档和脚本索引，补充无 Docker 测试覆盖 setup 委托与 update 同步；完成回归测试
