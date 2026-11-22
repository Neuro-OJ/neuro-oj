# 构建、单二进制与环境变量

命令清单在 [AGENTS.md](../AGENTS.md) §2；这里只留命令背后的机制、标志与配置。

## 任务前置

`dev` / `build` / `compile` 都先跑 `copy-monaco` —— 把 `monaco-editor`
的静态资源复制到 `public/monaco` 自托管（不走
CDN）。手动改编辑器相关代码时，若资源缺失先跑 `deno task copy-monaco`。

## 编译单二进制（`deno task compile`）

`deno task compile` 等价于依次执行（先复制 Monaco 静态资源，再构建、编译）：

```bash
deno task copy-monaco
deno run -A npm:nuxt build
mkdir -p dist
deno compile -A --no-check \
  --unstable-byonm \
  --unstable-node-globals \
  --include .output/public \
  --output dist/noj-ui \
  .output/server/index.mjs
```

续行的反斜线必须是**行尾最后一个字符**：写成 `--unstable-byonm \  # 注释` 会让
Bash 提前结束命令，后面的标志被当成独立命令执行；注释只能放在命令块之外。

运行产物：

```bash
cd dist && ./noj-ui      # 默认 http://localhost:3000
```

为什么每个标志都要：

- `--unstable-byonm`：Nitro 输出依赖大量 CJS npm 包（Vue 编译器、highlight.js
  等），Deno 默认 npm 解析处理不了它们的 `require()`；byonm 让 Deno 按原生
  `node_modules` 结构解析。
- `--unstable-node-globals`：提供 `process` / `Buffer` 等 Node 全局（Nitro 产物
  按 Node 语义运行）。
- `--include .output/public`：`deno compile`
  只打包入口模块及其依赖，不含客户端静态资源； 漏了它启动后所有 `/_nuxt/*` 返回
  404。
- `--output dist/noj-ui`：产物路径，与 `deno task compile` 一致。
- `nitro.preset: "deno-server"`：Deno 部署预设，`deno compile` 必需。
- `hooks.close`：`nuxt.config.ts` 的 `close: () => process.exit(0)`，防止 Nitro
  关闭时 Deno 进程 hang。

## 环境变量

| 变量                             | 默认值                  | 说明                                                                                                                               |
| -------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_API_BASE`                  | `http://localhost:8000` | noj-core API 地址（服务端私有）                                                                                                    |
| `NUXT_PUBLIC_AUTH_COOKIE_PREFIX` | `noj`                   | 身份 Cookie 前缀；同一主机跑多套 UI 时分别设置，避免跨端口互相覆盖登录                                                             |
| `NUXT_BFF_REDIS_URL`             | 空                      | BFF 公共元信息 Redis 缓存；空值禁用，故障时绕过（[bff.md](bff.md)）                                                                |
| `NUXT_BFF_CACHE_PREFIX`          | `noj:ui:bff:v1`         | 部署缓存命名空间；共用 Redis 的部署必须换前缀                                                                                      |
| `NUXT_SITE_URL`                  | 空                      | sitemap / canonical 的**权威站点地址**（如 `https://noj.example.com`）。未配置时按 Host 分键缓存；生产必须配置，否则有缓存投毒风险 |

改前缀会要求重新登录，不迁移已有令牌。

## 浏览器类验证的前提

```bash
deno run -A npm:playwright@1.65.1 install chromium          # 首次
E2E_UI_URL=http://127.0.0.1:3000 deno task test:theme # 需先起 UI
```

`test:bff:ssr` 用 `scripts/verify-bff-ssr.mjs` 起独立模拟 Core +
生产构建，检查初始 HTML、 HTTP
状态与水合；不访问生产、不改真实数据。共享缓存验收要独立本机 Redis：

```bash
BFF_TEST_REDIS_URL=redis://127.0.0.1:6379 deno task test:bff:cache
```
