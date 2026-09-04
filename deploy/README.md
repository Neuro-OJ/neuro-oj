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
