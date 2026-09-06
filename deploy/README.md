# Neuro OJ 生产部署文件

本目录包含公测部署所需的反向代理配置。

## 目录

- `nginx/default.conf`：Nginx 反向代理配置（容器内只处理 HTTP，转发到 `ui:3000`）。

## TLS 说明

容器内的 Nginx **不处理 TLS**。TLS 终止由宿主机 Nginx / Caddy / 云负载均衡等外部边缘完成，再将 HTTP 流量转发到本容器的 80 端口。

## 安全响应头职责

| 响应头 | core 直连 | Nitro 直连 | 容器 Nginx | TLS 终止边缘 |
| --- | --- | --- | --- | --- |
| `X-Content-Type-Options` | 基础头 | 基础头 | 统一输出 | 可复用 |
| `X-Frame-Options` | 基础头 | 基础头 | 统一输出 | 可复用 |
| `Referrer-Policy` / `Permissions-Policy` | 基础头 | 基础头 | 统一输出 | 可复用 |
| 强制 `Content-Security-Policy` | — | 页面直连输出 | 统一输出 | 可复用 |
| `Content-Security-Policy-Report-Only` | — | 页面直连输出 | 统一输出 | 可复用 |
| `Strict-Transport-Security` | 不设置 | 不设置 | 不设置 | **仅此处设置** |

应用会在直连部署中提供基础头和页面 CSP；经本配置的容器 Nginx 转发时会隐藏上游同名头，再由 Nginx 输出一份，避免重复 CSP 被浏览器合并。强制 CSP 保留现有兼容策略，Report-Only 使用更窄策略并上报到同源 `/api/csp-report`。报告端点仅接受小体积 JSON，不存储报告内容。

HSTS 必须由真正终止 TLS 的外部边缘设置，且仅对 HTTPS 响应发送。例如宿主机 Nginx 的 HTTPS `server` 块可使用：

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

不要在容器 HTTP Nginx、noj-core 或 Nitro 中添加 HSTS；否则直连 HTTP 或错误转发场景会把不安全来源错误标记为仅 HTTPS。

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

推荐使用仓库根目录的 `setup.sh` 一键安装入口。脚本会先检查环境，再下载部署文件并引导完成生产配置：

```bash
# 首次安装
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | \
  bash -s -- --dir /opt/neuro-oj

# 日常运维
noj-cli status
noj-cli logs core
noj-cli backup
noj-cli restart
noj-cli stop
noj-cli start
noj-cli config check
```

`noj-cli update` 按 `.env.prod` 中的版本升级，`noj-cli update --latest` 获取最新稳定版本。
`noj-cli uninstall` 默认保留数据卷，`noj-cli uninstall --all --yes` 才会执行完全删除。
安装器从同版本 Release 下载并校验 `noj-cli`，生产机无需安装 Deno。已有 `.env.prod`、备份和数据卷继续使用。
`noj-cli backup verify/restore/drill` 提供快照校验、恢复和演练；恢复需要显式 `--confirm`。
所选 Release 必须已发布 CLI 资产，旧 Release 不会被安装器静默切换成其他版本。

镜像拉取由 Docker daemon 负责。若官方源访问不稳定，请在 Docker daemon 配置
registry mirror 或 HTTP(S) proxy 后重试；评测镜像仍可通过 `JUDGE_IMAGE_BASE`
配置镜像前缀。部署脚本不会把代理凭据写入仓库或日志。

## 手动启动

```bash
cp .env.prod.example .env.prod
vim .env.prod
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

详细步骤见 `noj-docs/docs/operators/production-deploy.md`。
