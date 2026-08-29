## Context

生产配置目前要求 `APP_URL` 和跨域地址使用 HTTPS，前端生产 Cookie 也固定启用 Secure。配置向导还分别询问网站地址和完整网址，导致普通用户重复填写。

## Goals / Non-Goals

**Goals:**

- 通过一次网站地址输入生成两个相关地址。
- 默认使用 HTTPS，并允许用户明确选择临时 HTTP。
- 让临时 HTTP 模式在浏览器中可以完成登录。
- 让后端和部署脚本对 HTTP 的安全门禁保持一致。

**Non-Goals:**

- 不自动申请、续期或安装 SSL 证书。
- 不改变宝塔、Caddy、Nginx 或云负载均衡器的证书配置。
- 不允许用户在未明确开启开关时通过 HTTP 启动生产服务。

## Decisions

- 使用 `NOJ_ALLOW_INSECURE_HTTP=false` 作为默认关闭的显式开关；选择临时 HTTP 时由向导写为 `true`。相比仅根据 URL 协议推断，显式开关更不容易因手工改配置而意外降低安全性。
- 向导询问“是否使用 HTTPS 证书”，默认选择“是”。选择“是”只生成 HTTPS 地址并提示证书需由外部反向代理或面板提供；脚本不调用面板 API。
- 选择“否”时生成 HTTP 地址，并同步设置后端协议校验和前端 Cookie 行为。这样 HTTP 选项是可用的临时模式，而不是部署到一半才失败。
- 生产配置校验同时放行 HTTP 应用地址和 HTTP 跨域地址，且只在显式开关为 true 时放行；HTTPS 仍是默认和推荐路径。

## Risks / Trade-offs

- [HTTP 传输可能泄露密码和 Cookie] → 默认关闭，向导强提示临时用途，文档明确建议尽快启用 HTTPS。
- [用户选择 HTTPS 但尚未配置证书] → 向导说明证书不会自动安装，并给出面板/反向代理配置提醒。
- [IP 地址无法申请常规公网证书] → IP 仍可用于 HTTP 临时模式；正式 HTTPS 使用域名。

## Migration Plan

升级后已有 HTTPS 配置继续有效；未设置新开关时按 `false` 处理。已有 HTTP 配置必须补充 `NOJ_ALLOW_INSECURE_HTTP=true`，否则生产校验会拒绝启动。
