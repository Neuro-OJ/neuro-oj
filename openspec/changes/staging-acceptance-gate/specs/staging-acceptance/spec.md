## Purpose

为生产候选版本提供可重复、可诊断的 staging 验收门禁，验证从镜像构建到用户认证、对象存储和真实评测的关键闭环。

## ADDED Requirements

### Requirement: 只允许干净且可追溯的候选源码

staging 验收 SHALL 在工作区无未提交修改的情况下运行，并 SHALL 记录候选 commit、分支或版本标签和镜像版本；非 `main`、`release/*` 或版本标签的候选 SHALL 被拒绝，除非显式启用本地调试例外。

#### Scenario: 干净版本候选通过来源检查

- **WHEN** 工作区干净且 HEAD 为 `main`、`release/*` 或版本标签
- **THEN** 验收记录候选来源并继续执行

#### Scenario: 脏工作区或非发布来源被拒绝

- **WHEN** 工作区存在未提交修改，或来源不是允许的发布分支/标签
- **THEN** 验收在启动服务前失败并说明原因

### Requirement: 使用生产镜像和 Compose 验证服务健康

staging 验收 SHALL 构建或使用指定版本的 core、UI、judge、evaluator、solution 和 LLM gateway 镜像，并 SHALL 使用 `docker-compose.prod.yml` 启动生产栈；生产 Compose 配置解析失败或任一必需服务未健康 SHALL 使验收失败。

#### Scenario: 生产候选栈健康启动

- **WHEN** 六类镜像可用、生产环境配置完整且 Compose 服务启动
- **THEN** 验收等待迁移/初始化完成及服务健康检查通过后继续 smoke test

#### Scenario: 镜像构建或服务健康失败

- **WHEN** 任一镜像构建失败、Compose 配置无效或服务健康检查超时
- **THEN** 验收失败并保存当前 Compose 状态和服务日志

### Requirement: 验证外部访问与关键业务闭环

staging 验收 SHALL 验证 HTTPS 入口、健康探针、Cookie 安全属性、CORS 和反向代理，并 SHALL 运行认证/改密/2FA、题目导入、对象存储、真实代码评测、SSE 和重测 smoke test。

#### Scenario: 关键生产链路全部通过

- **WHEN** staging HTTPS 地址可访问且测试凭据、评测镜像和隔离 Docker socket有效
- **THEN** 所有指定 smoke test 通过，验收返回成功

#### Scenario: 入口或业务链路失败

- **WHEN** HTTPS、Cookie、CORS、认证、题目导入、对象存储、评测、SSE 或重测任一项失败
- **THEN** 验收返回失败，不得将候选标记为可发布

### Requirement: 保留失败诊断并要求发布前批准

验收 SHALL 在失败时保留脱敏的候选元数据、Compose 服务状态和最近服务日志；发布流程文档 SHALL 要求 staging 验收成功、签名提交/tag 和人工批准全部完成后才能发布 Release。

#### Scenario: 验收失败可定位

- **WHEN** 任一验收步骤失败
- **THEN** 输出诊断目录路径，并在目录中保存候选信息、服务状态和日志

#### Scenario: 验收成功满足发布前置条件

- **WHEN** staging 验收成功且人工完成签名/tag与批准
- **THEN** 候选可进入 Release 发布流程
