# Neuro OJ

Neuro OJ (NOJ) 是一个面向 LMCC（大语言模型能力认证）的在线评测系统。

## 快速开始

### 环境要求

- [Deno](https://deno.com/) — noj-core 后端
- [Node.js](https://nodejs.org/) >= 20 — noj-ui 前端
- [Rust](https://www.rust-lang.org/) — noj-judge 评测 Worker
- [Docker](https://www.docker.com/) — 评测环境沙箱 & Redis

### 启动开发环境

```bash
# 启动 Redis（消息队列）
docker compose up -d

# 启动后端
(cd noj-core && deno task dev)

# 启动前端
(cd noj-ui && npm run dev)

# 启动评测 Worker
(cd noj-judge && cargo run)
```

## 项目结构

| 目录         | 说明                   |
| ------------ | ---------------------- |
| `noj-core/`  | 核心后端 (Deno + Hono) |
| `noj-ui/`    | 核心前端 (Nuxt.js)     |
| `noj-judge/` | 评测 Worker (Rust)     |

## 贡献指南

### GPG 签名要求

本项目**强制要求**所有提交使用 GPG 密钥签名。签名的意义：

- **身份验证** — 确保提交者身份真实可信，防止冒名提交
- **完整性保证** — 任何代码在传输过程中被篡改都会被检测到
- **供应链安全** — 构建可追溯的代码来源链，满足安全审计要求

#### 配置 GPG 签名

```bash
# 1. 生成 GPG 密钥（如尚未拥有）
gpg --full-generate-key

# 2. 列出已有密钥，记下 KEY_ID
gpg --list-secret-keys --keyid-format LONG

# 3. 配置 git 全局签名
git config --global user.signingkey <KEY_ID>
git config --global commit.gpgsign true

# 4. 导出公钥并添加到 GitHub
gpg --armor --export <KEY_ID>
# 将输出粘贴到 https://github.com/settings/gpg/new
```

### PR 工作流

本项目**不接受直接推送**到 main 分支。贡献流程：

1. 从 main 分支创建新分支
2. 在新分支上进行修改，确保每个提交都有 GPG 签名
3. 推送到 GitHub 并创建 Pull Request
4. PR 通过审核后合并

## 许可证

详见 [LICENSE](./LICENSE)
