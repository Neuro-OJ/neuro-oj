## 1. 规范

- [x] 1.1 更新生产部署主规范的安装、升级、备份和反向代理场景
- [x] 1.2 补充 Agent Note 决策记录

## 2. 部署脚本

- [x] 2.1 修复 `--files-only` 的端口检查和 bootstrap 收尾行为
- [x] 2.2 修正 PostgreSQL dump 的 `pg_restore` 标准输入校验
- [x] 2.3 增加安装/升级时的备份口令文件准备与路径配置
- [x] 2.4 在应用健康后刷新 Nginx 上游容器
- [x] 2.5 改进固定 Release tag 下载失败提示

## 3. 测试与文档

- [x] 3.1 扩展 install、deploy、backup 和 noj 路由回归测试
- [x] 3.2 更新生产部署文档与命令帮助
- [x] 3.3 运行脚本语法、部署测试、OpenSpec 和 Agent Note 校验
