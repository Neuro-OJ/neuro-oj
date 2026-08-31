# optional-https-install Specification

## Purpose

让用户只填写一次网站地址即可完成访问地址配置，并在明确了解风险后选择 HTTPS 或临时 HTTP，同时保证默认生产部署仍然安全。

## Requirements

### Requirement: 网站地址只需填写一次

生产配置向导 MUST 只询问一次网站访问地址，并根据用户选择自动生成完整访问网址和跨域允许地址。

#### Scenario: 使用 HTTPS

- **WHEN** 用户填写域名或服务器 IP 并选择使用 HTTPS
- **THEN** 系统 MUST 生成以 `https://` 开头的应用地址
- **AND** 系统 MUST 使用同一个地址生成跨域允许地址

#### Scenario: 选择临时 HTTP

- **WHEN** 用户填写网站地址并明确选择不使用 HTTPS
- **THEN** 系统 MUST 生成以 `http://` 开头的应用地址
- **AND** 系统 MUST 写入明确允许临时 HTTP 的配置
- **AND** 向导 MUST 提醒用户该模式不适合正式生产环境

### Requirement: HTTP 必须显式开启且默认关闭

生产配置校验 MUST 默认拒绝 HTTP；只有配置明确开启临时 HTTP 时，应用地址和跨域允许地址才可以使用 HTTP。

#### Scenario: 默认生产配置使用 HTTP

- **WHEN** 应用地址使用 HTTP 且未明确开启临时 HTTP
- **THEN** 生产配置校验 MUST 失败

#### Scenario: 明确开启临时 HTTP

- **WHEN** 应用地址和跨域允许地址使用 HTTP 且临时 HTTP 开关已开启
- **THEN** 生产配置校验 MUST 通过地址协议检查

### Requirement: HTTP 模式仍可完成登录

在明确开启临时 HTTP 后，前端认证 Cookie MUST 不设置仅 HTTPS 可用的标志，确保用户可以在 HTTP 临时模式下登录；HTTPS 模式 MUST 继续设置该安全标志。

#### Scenario: HTTP 临时模式登录

- **WHEN** 前端运行在生产标记且临时 HTTP 开关已开启
- **THEN** 登录 Cookie MUST 可通过 HTTP 发送

#### Scenario: HTTPS 生产模式登录

- **WHEN** 前端运行在生产标记且临时 HTTP 开关未开启
- **THEN** 登录 Cookie MUST 继续要求 HTTPS

### Requirement: 配置写入必须经过最终确认

交互式生产配置向导 MUST 先将输入保存到权限受保护的临时文件，只有用户在所有问题结束后明确确认，才可以写入正式生产配置并继续部署。

#### Scenario: 用户确认写入配置

- **WHEN** 用户完成配置填写并确认写入
- **THEN** 系统 MUST 将临时配置一次性替换为正式配置
- **AND** 系统 MUST 继续进行配置校验和部署

#### Scenario: 用户取消写入配置

- **WHEN** 用户完成配置填写但拒绝最终写入
- **THEN** 系统 MUST 删除临时配置
- **AND** 系统 MUST 保留原正式配置不变
- **AND** 系统 MUST 停止本次部署

### Requirement: 邮件服务提示必须符合已有配置

邮件服务向导 MUST 根据是否存在已有邮件服务配置，清楚说明直接回车和停用选项的含义。

#### Scenario: 没有已有邮件服务配置

- **WHEN** 邮件服务尚未配置
- **THEN** 直接回车 MUST 选择暂不配置
- **AND** 系统 MUST NOT 要求填写邮件服务密钥

#### Scenario: 已有邮件服务配置

- **WHEN** 当前邮件服务是阿里云或腾讯云
- **THEN** 向导 MUST 说明直接回车会继续使用当前服务
- **AND** 用户输入 `skip` 或“暂不配置”时 MUST 清除邮件服务配置并停用邮件
