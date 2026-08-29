# 设计：前后端服务器面板兼容

## 检测与参数传递

- `install.sh` 和 `deploy.sh` 都支持 `--panel auto|baota|none`。
- `install.sh` 的参数在 `--` 后传给下载后的 `deploy.sh`，因此 bootstrap 与直接执行生产脚本的行为一致。
- `auto` 检测宝塔常见的 `/www/server/panel` 目录或 `/usr/bin/bt` 命令；测试通过环境变量覆盖检测路径，不修改真实系统。
- `baota` 强制显示宝塔提示，`none` 禁用提示。

## 用户引导

检测到宝塔后，在前后端环境检查阶段说明：

1. 可以在宝塔 Docker 页面确认 Docker/容器状态。
2. 脚本继续使用系统 Docker CLI 和 Compose v2。
3. 前后端 Compose 自带 Nginx，面板反向代理应指向 `127.0.0.1:${NGINX_PORT}`，默认端口为 `8080`。
4. 如果宝塔或其他服务已占用该端口，应修改 `.env.prod` 的 `NGINX_PORT`，并同步修改反向代理目标。
5. 脚本不会修改已有站点、反向代理、证书、容器和面板配置。

## 安全边界

面板模式不绕过生产配置校验、镜像签名验证和 Judge 专用 rootless Docker socket 校验。不会为了适配面板而挂载共享 `/run/docker.sock` 或 `/var/run/docker.sock`。

## 测试策略

- bootstrap 测试自动检测、强制和禁用面板模式，并确认参数传递给 `deploy.sh`。
- deploy 测试自动检测、强制和禁用面板模式，并确认提示包含反向代理端口和不修改面板配置的边界。
- 运行两个部署脚本的现有回归测试、语法检查和 OpenSpec 校验。
