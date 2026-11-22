## 0. 对齐

- [x] 0.1 确认 `kind` 取值、缺省值表与兼容策略（旧格式长期自动转换）
- [x] 0.2 盘点 `noj-problems` manifest 字段，确认转换规则覆盖

## 1. 单一校验实现（行为不变）

- [x] 1.1 noj-cli `lint` / `pack` 以相对路径直接引用 noj-core 校验与解析代码
- [x] 1.2 修正被引用 core 文件以满足 CLI `noUncheckedIndexedAccess`
- [x] 1.3 删除 `noj-cli/src/problem/vendor/` 与 CLI 契约测试；fixture 移入 core
      测试
- [x] 1.4 验证 `deno compile` 产物可用

## 2. 格式 3

- [x] 2.1 实现 `kind` 判别、通用字段表 + 每 `kind` 字段表、统一的不支持字段错误
- [x] 2.2 实现 `runtime_config` 缺省值补全（官方镜像按 `JUDGE_IMAGE_BASE`）与
      `llm` 隐含网络规则
- [x] 2.3 格式 3 拒绝未知顶层字段与 `is_objective` / `judge_type`
- [x] 2.4 `parseBundleZip` 与 `parseDomainDraftBundle` 改为按 `kind` 分支

## 3. 兼容与迁移

- [x] 3.1 实现 `upgradeBundleManifest`（格式 1 P / 2 → 3 纯函数，不注入缺省值）
- [x] 3.2 导入、`lint`、`pack` 共用该转换并返回升级告警
- [x] 3.3 新增 `noj problem migrate` 子命令

## 4. 文档与脚手架

- [x] 4.1 `noj problem init` 生成格式 3 最小 manifest
- [x] 4.2 改写 `noj-docs/docs/standards/problem-bundle.md` 与出题人指南示例
- [x] 4.3 新增 Agent Note

## 5. 后续（不在本变更内）

- [ ] 5.1 题包导入代码迁入 `features/problem-bundle/`
- [ ] 5.2 视需要在 `noj-problems` 运行 `noj problem migrate`
