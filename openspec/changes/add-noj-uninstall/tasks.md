## 1. 部署命令实现

- [x] 1.1 在 `scripts/deploy/deploy.sh` 增加 `uninstall` 参数解析、帮助说明和轻量运行时检查，并验证缺少确认时不会调用 Docker
- [x] 1.2 实现带 `UNINSTALL`/`DELETE ALL` 确认词和 `--yes` 非交互确认的普通/完全卸载流程，验证普通模式使用 `--rmi local` 且不包含 `--volumes`，`--all` 才使用 `--rmi all --volumes`
- [x] 1.3 在根目录 `noj` 增加 uninstall 路由、PATH 软链接安全清理和 `--all` 安装目录删除保护，验证其他安装及 Git 工作区不会被删除

## 2. 测试与文档

- [x] 2.1 扩展 `scripts/deploy/test-deploy.sh` 和 `scripts/deploy/test-noj.sh`，覆盖交互确认、`--yes`、`--all`、拒绝卸载、数据卷保护和链接清理
- [x] 2.2 更新 `README.md`、`deploy/README.md` 和生产部署文档，验证普通卸载和完全删除的边界与恢复方式
- [x] 2.3 运行 Shell 语法检查、卸载相关测试和 OpenSpec 校验，确认全部通过
