## Why

当前向导分别询问网站地址和完整网址，普通用户难以理解两者区别。用户希望能在没有证书时先用 HTTP 临时访问，同时正式环境仍必须明确选择 HTTPS，避免不知情地降低安全性。

## What Changes

- 只询问一次网站访问地址，自动生成完整网址。
- 增加“是否使用 HTTPS 证书”确认，默认选择 HTTPS。
- 选择 HTTP 时要求显式确认，并标记为临时不安全模式。
- 生产配置校验仅在显式开启 HTTP 选项时允许 HTTP 的应用地址和跨域地址。
- HTTP 模式关闭生产 Cookie 的 `Secure` 标志，确保临时访问仍可登录。
- 更新配置模板、部署文档、配置向导测试和后端测试。
- 配置向导先把用户输入写入临时文件，最后确认后才写入正式配置；已有邮件配置时明确说明回车会继续使用，避免误问密钥。

## Capabilities

### New Capabilities

- `optional-https-install`: 生产部署支持一次填写网站地址并显式选择 HTTPS 或临时 HTTP。

### Modified Capabilities

无。

## Impact

- 修改生产配置向导、生产配置校验、前端登录 Cookie 和生产 Compose 环境变量。
- 增加一个明确的临时 HTTP 配置开关；默认值仍为关闭。
- 不自动申请或安装证书，HTTPS 证书仍由宝塔、Caddy、Nginx 或其他反向代理配置。
