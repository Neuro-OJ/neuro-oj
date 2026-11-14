## 0. 对齐

- [ ] 0.1 评审本提案，确认 `kind` 取值、缺省值表、兼容时间表与开放问题
- [ ] 0.2 盘点 `noj-problems` 全部 manifest 的字段使用情况，确认迁移规则覆盖

## 1. 单一校验实现（行为不变）

- [ ] 1.1 新建 `packages/problem-bundle/`，迁入 manifest / zip
      校验，同时支持格式 2 与格式 3，`fixtures/problem-bundle-manifest.json`
      用例转为其单元测试
- [ ] 1.2 noj-core 改为引用 `packages/problem-bundle/`，错误包装为
      `BadRequestError`
- [ ] 1.3 noj-cli `lint` / `pack` / `push` 改为引用
      `packages/problem-bundle/`，验证 `deno compile` 产物可用
- [ ] 1.4 删除 `noj-cli/src/problem/vendor/`、两侧契约测试与共享 fixture
- [ ] 1.5 CI 路径过滤将 `packages/problem-bundle/**` 同时映射到 core 与 cli
      任务； 根 `AGENTS.md` 登记 `packages/` 顶层目录

## 2. 格式 3

- [ ] 2.1 实现 `kind` 判别、通用字段表 + 每 `kind` 字段表、统一的不支持字段错误
- [ ] 2.2 实现 `runtime_config` 缺省值规范化与 `llm` 隐含网络规则
- [ ] 2.3 格式 3 拒绝未知顶层字段；已退役字段给出迁移提示
- [ ] 2.4 `parseDomainDraftBundle` 与导入服务改为消费 `kind`，删除基于
      `is_objective` / `judge_type` 的分支
- [ ] 2.5 Hydro 解析从 `parseBundleZip` 拆出为独立入口，上传入口按根级文件分派

## 3. 迁移与兼容

- [ ] 3.1 实现 `migrate.ts`（格式 1/2 → 3 纯函数）与 `noj problem migrate`
      子命令
- [ ] 3.2 格式 2 导入时经 `migrate.ts` 转换并在导入结果中返回告警
- [ ] 3.3 在 `noj-problems` 运行迁移并单独提交；`deno task dev-setup`
      种子导入通过
- [ ] 3.4 删除格式 1 导入期转换，错误信息提示 `noj problem migrate`
- [ ] 3.5 `noj-cli check` 增加「官方评测镜像已登记白名单」检查项

## 4. 文档与脚手架

- [ ] 4.1 `noj problem init` 生成格式 3 最小 manifest
- [ ] 4.2 改写 `noj-docs/docs/standards/problem-bundle.md` 与出题人指南示例
- [ ] 4.3 CHANGELOG 记录 BREAKING 与迁移命令；新增 Agent Note

## 5. 收尾（v0.13）

- [ ] 5.1 删除格式 2 读取路径与相应测试
