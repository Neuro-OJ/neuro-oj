## 1. 配置与 Compose

- [x] 1.1 增加 `JUDGE_ENABLED` 配置向导和兼容默认值；通过交互测试验证选择安装/跳过分支
- [x] 1.2 为 Compose Judge 服务增加 profile 和安全默认插值；通过 Compose config 验证跳过时无 socket 错误
- [x] 1.3 让配置校验、socket 检查、镜像签名校验和 Compose 生命周期按 Judge 状态分支；通过 fake Docker 日志验证服务集合

## 2. 用户提示与文档

- [x] 2.1 更新配置模板、安装完成提示和状态提示；确认跳过后明确说明评测不可用及后续启用方式
- [x] 2.2 更新生产部署文档和脚本索引；确认一键安装和手动启用说明一致

## 3. 验证

- [x] 3.1 增加跳过 Judge、启用 Judge、旧配置兼容和后续启用回归测试
- [x] 3.2 运行 Shell、Deno、Compose 和 OpenSpec 校验；所有相关命令返回成功
