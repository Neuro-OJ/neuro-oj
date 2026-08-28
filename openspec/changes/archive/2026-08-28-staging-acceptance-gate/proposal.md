## Why

当前生产部署可以启动服务，但发布前缺少一条可重复的 staging 验收路径，无法稳定证明候选镜像、生产 Compose、反向代理、认证、对象存储和真实评测链路协同工作。发布依赖人工记忆会增加漏测和无法诊断的风险。

## What Changes

- 新增 staging 验收入口，校验候选源码来自干净的 main/release 分支或版本标签。
- 构建并启动与生产一致的六类镜像和 `docker-compose.prod.yml`。
- 验证 HTTPS、健康检查、Cookie 属性、CORS 和反向代理。
- 运行覆盖认证/改密/2FA、题目包导入、真实代码评测、SSE、对象存储和重测的 staging smoke test。
- 验收失败时保存 Compose 状态、服务日志和候选版本元数据，便于排查。
- 提供发布前清单，明确 staging 通过、签名提交/tag 和人工批准是 Release 前置条件。

## Capabilities

### New Capabilities

- `staging-acceptance`: 可重复执行生产候选版本 staging 验收并保留诊断结果。

### Modified Capabilities

<!-- 无。 -->

## Impact

影响根目录 staging/部署脚本、生产镜像发布 workflow、生产 Compose 的镜像配置、跨模块 E2E 测试和运营文档。不改变线上 API 协议；真实 staging 域名、密钥、隔离 Docker socket 和人工批准仍由部署环境提供。
