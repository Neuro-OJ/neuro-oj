## 0. 对齐与基线

- [ ] 0.1 与其他开发者评审本提案，确认目标结构、三条规则、验收指标与「不做」清单
- [ ] 0.2 记录基线：以题单为例列出新增一个普通功能需改动的全部文件
- [ ] 0.3 约定搬迁 PR 的合入窗口与进行中分支的处理方式

## 1. 先砍开销（不搬代码）

- [ ] 1.1（已移至 2.6，见下）
- [x] 1.2 删除已空转的门禁（`check-domains.ts` 等），PR 中逐项写明理由
- [x] 1.3 路由目录、事件目录改为按需生成，移出 CI 失败条件
- [x] 1.4 逐项评估导出 JSDoc 覆盖率、日志迁移、Agent Note
      格式等门禁，保留或删除并说明理由
- [x] 1.5 精简根目录与 noj-core 的 `AGENTS.md`

## 2. 骨架

- [x] 2.1 ~~`shared/` 改名为 `kernel/`~~ 取消：需改 789 个文件、2283 行
      import，只换名字却让所有并行分支冲突；底座直接沿用 `shared/`
- [x] 2.2 实现 `defineFeature` 与 `features.ts`；`createApp` / `create-system`
      支持清单装配，与旧装配并存；路由与中间件顺序快照前后一致
- [x] 2.3 任务类型改为由功能声明汇总，启动时校验重名；保留旧 `TASK_TYPES`
      直至旧模块迁完
- [x] 2.4 新增 `scripts/check-feature-boundaries.ts`（三条规则 +
      修复提示）及测试，接入 CI
- [x] 2.5 `test:domain` 与 CI 路径选择支持 `features/<name>/`
      自动识别；比对切换前后测试文件集合
- [ ] 2.6 系统设置读取等底座能力迁入 `shared/` 后，再将 66
      个跨模块转出文件合并为各模块出口（`check-contract-reexports` 已在阶段 1
      删除）。原因：2026-11-11 实验表明在此之前合并会产生 access →
      platform（system-settings → LLM 网关 → 系统初始化）→ access 的运行时循环

## 3. 试点：题单

- [x] 3.1 将题单迁入 `features/trainings/`（路由、服务、表结构、测试、README）
- [x] 3.2 删除题单在 `application/`、合同层、`module-boundaries.json` 中的残留
- [x] 3.3 按基线指标验收（≤6 文件、无登记表）；不达标则先调整结构
- [x] 3.4 将 `features/trainings` 定为官方样例并写入 `AGENTS.md`

## 4. 按需迁移

- [x] 4.1 根 `AGENTS.md` 写明「新功能一律进 `features/`；改旧模块时顺手迁移」
- [ ] 4.2 各旧模块改到即迁，每次迁移同步删除其编排代码、合同文件与登记项
      （2026-11-11：legal、tags、checkin 已迁移）
- [ ] 4.3 最后一个旧模块迁出后，删除
      `modules/`、`application/`、`module-boundaries.json`、`module-test-metadata.ts`
      与旧边界门禁

## 5. core 与 ui 接口类型

- [ ] 5.1 决定类型共享方案（Hono RPC 类型推导或 schema 生成）
- [ ] 5.2 打通一个功能的端到端类型作为样例
- [ ] 5.3 随功能迁移逐步替换 noj-ui 手写类型

## 6. 收尾

- [ ] 6.1 新增 Agent Note（architecture）记录本次结构决策
- [ ] 6.2 归档或删除 `dev-docs/engineering/` 中描述旧模块边界的文档
