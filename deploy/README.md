# Neuro OJ 生产部署文件

本目录包含公测部署所需的反向代理配置。

## 目录

- `nginx/default.conf`：Nginx 反向代理配置（容器内只处理 HTTP，转发到 `ui:3000`）。

## TLS 说明

容器内的 Nginx **不处理 TLS**。TLS 终止由宿主机 Nginx / Caddy / 云负载均衡等外部边缘完成，再将 HTTP 流量转发到本容器的 80 端口。

例如使用宿主机 Nginx 时：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        # 默认容器 Nginx 映射到宿主机 8080；若设置 NGINX_PORT=80 则改为 80
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

## 首次安装与生产运维

推荐使用仓库根目录的 `noj` 入口。首次安装会先展示最低要求和当前主机环境，随后检查生产配置、
保护环境文件、复用生产 Compose、等待健康检查，并且不会删除数据卷：

```bash
# 首次安装：仅使用仓库根目录的 setup.sh
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- --dir /opt/neuro-oj

# 日常运维
./noj status
./noj logs core
./noj backup
./noj update
./noj update --latest
./noj restart
./noj uninstall
./noj uninstall --all
./noj config check
```

`update` 默认按 `.env.prod` 中的 `NOJ_VERSION` 升级；`update --latest` 会查询最新稳定 Release（不含
RC/预发布）。两者都会先同步部署文件和 `noj` 命令，再创建并校验完整备份、拉取镜像并等待 Compose
健康检查。`stop`、`restart` 和 `update` 都不会删除数据卷。`noj` 支持的部署选项
会继续传递给底层脚本；需要高级命令或完整参数时仍可执行
`bash scripts/deploy/deploy.sh <命令> [选项]`。首次安装成功后会优先创建
`/usr/local/bin/noj` 软链接；没有权限时使用 `~/.local/bin/noj` 并更新登录 PATH，已有同名
命令不会被覆盖。

`noj uninstall` 会要求输入 `UNINSTALL` 确认；自动化环境请使用 `noj uninstall --yes`。该命令会
删除当前 Compose 栈的容器、网络和本地镜像，但不会执行 `down -v`，因此 PostgreSQL、Redis、MinIO、
题目包、Judge 缓存等数据卷、`.env.prod`、备份和部署目录都会保留。卸载后可在安装目录执行
`./noj start` 重新拉取镜像并恢复服务；宿主机 Nginx/Caddy/宝塔站点和证书不会被修改。

如果需要完全删除 NOJ 及其数据，使用 `./noj uninstall --all`。该命令会要求输入 `DELETE ALL`；自动化环境
必须使用 `./noj uninstall --all --yes`。它会额外删除全部 Compose 数据卷、当前安装目录、配置和备份，执行前请
确认备份已经保存到其他位置。检测到 Git 工作区时，命令会拒绝删除安装目录。

镜像拉取由 Docker daemon 负责。若官方源访问不稳定，请在 Docker daemon 配置
registry mirror 或 HTTP(S) proxy 后重试；评测镜像仍可通过 `JUDGE_IMAGE_BASE`
配置镜像前缀。部署脚本不会把代理凭据写入仓库或日志。

## 手动启动

```bash
cp .env.prod.example .env.prod
vim .env.prod
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

详细步骤见 `docs/operators/production-deploy.md`。
