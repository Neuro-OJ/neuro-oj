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

推荐使用仓库根目录的一键安装入口 `setup.sh`（仅下载/校验 `noj-cli`）与 `noj-cli`
命令。首次安装会先检查当前主机（Linux / amd64 / 基础工具），下载并 SHA-256 校验
`noj-cli-linux-amd64`，然后交由 `noj-cli` 完成环境检测与生产部署：

```bash
# 首次安装：仅使用仓库根目录的 setup.sh
curl -fsSL https://raw.githubusercontent.com/Neuro-OJ/neuro-oj/main/setup.sh | bash

# 日常运维
noj-cli doctor
noj-cli deploy status
noj-cli maintain logs server
noj-cli maintain backup create
noj-cli deploy restart
noj-cli deploy down
noj-cli deploy up
noj-cli maintain config check
```

`noj-cli` 不提供升级/卸载子命令；配置变更与数据管理见 `noj-cli maintain config`
与 `noj-cli maintain reset`。`deploy down` 不会删除数据卷；`maintain reset` 默认
只清数据，`--include-deploy-configs` 才连配置一起清。首次安装成功后 `noj-cli`
会安装到 `NOJ_INSTALL_DIR`（默认 `/opt/neuro-oj`）并注册 `noj` 软链接。

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
