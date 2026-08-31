# friendly-production-config Specification

## Purpose

让没有部署经验的用户也能理解生产配置向导中的网站地址、完整网址、邮件服务和评测服务设置，并能安全地重新填写或暂时跳过邮件功能。

## Requirements

### Requirement: 配置向导使用易懂的用户提示

交互式配置向导 MUST 使用面向用户的中文说明解释网站地址和 HTTPS 选择，不得只展示内部配置变量名作为提问文字。

#### Scenario: 填写网站地址

- **WHEN** 向导询问网站地址
- **THEN** 提示 MUST 说明可以填写域名或服务器 IP
- **AND** 提示 MUST 说明不要填写 `https://` 前缀

#### Scenario: 清理误填的退出文字

- **WHEN** 已保存的网站地址是 `exit`、`quit` 或“取消”等退出文字
- **THEN** 向导 MUST 不把该文字作为网站地址默认值
- **AND** 向导 MUST 要求用户重新填写域名或服务器 IP

#### Scenario: 选择 HTTPS

- **WHEN** 向导询问是否使用 HTTPS
- **THEN** 提示 MUST 说明证书需要由宝塔或反向代理配置
- **AND** 提示 MUST 说明不使用 HTTPS 仅适合临时测试
