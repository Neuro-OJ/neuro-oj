## 1. P0 图谱基座

- [ ] 1.1 起草首版图谱 YAML（依据 IOAI / NOAI 公开考纲，150–250
      节点），平台维护者评审
- [ ] 1.2 新增 `knowledge_nodes` / `knowledge_edges` 表与迁移；用 schema
      测试验证约束
- [ ] 1.3 实现 `knowledge:check`（唯一、悬挂、无环、deprecated 替代合法）并接入
      CI；单元测试覆盖各类非法图
- [ ] 1.4 实现幂等 `knowledge:import`，接入 `dev-setup` 与生产
      `init`；验证重复导入无变化、deprecated 迁移挂载
- [ ] 1.5 公开图谱读取 API（节点、边、领域分组）与进程内只读缓存，登记到
      domain-boundaries
- [ ] 1.6 noj-ui 图谱浏览页（按领域分组 + 前置关系可视化）

## 2. P1 AI 打标

- [ ] 2.1 网关新增 `POST /internal/platform-completions`、`purpose`
      白名单、平台额度主体与审计；网关测试覆盖鉴权与计费
- [ ] 2.2 新增 `problem_knowledge`、`knowledge_tag_runs` 表与迁移
- [ ] 2.3 新增任务类型 `knowledge.tag`：输入白名单构造、JSON Schema
      校验、重试、内容 hash 去重；用 mock 网关测试成功、低置信、非法输出、未配置
- [ ] 2.4 发布流程成功后投递打标任务；验证草稿保存不触发、内容未变不重复调用
- [ ] 2.5 人工优先规则与审核队列 API（接受 / 修改 / 驳回），平台管理员权限守卫
- [ ] 2.6 存量回填命令（管理 API + noj-cli），限速与进度查询
- [ ] 2.7 noj-ui 审核队列页面；题目页展示知识点（含「待确认」标记与保密隐藏）

## 3. P2 难度与阶梯

- [ ] 3.1 新增 `problem_difficulty` 表；题目元数据增加可选及格线
- [ ] 3.2 `knowledge.calibrate`
      定时任务与校准公式；单元测试覆盖少样本/多样本边界
- [ ] 3.3 三档 `difficulty` 改为派生展示，保留出题人值作回退
- [ ] 3.4 节点阶梯 API（可访问性过滤、比赛保护过滤、跨域链接）
- [ ] 3.5 noj-ui 节点页（阶梯 + 下一题）与题目页「同类下一题」

## 4. P3 掌握度与推荐

- [ ] 4.1 新增 `user_knowledge_mastery` 物化表；`knowledge.mastery`
      增量任务在有效成绩变更后投递
- [ ] 4.2 掌握规则与前沿节点推荐；测试覆盖进行中比赛成绩不计入、保护结束后计入
- [ ] 4.3 图谱页按掌握度点亮；个人主页展示掌握概览
- [ ] 4.4 覆盖度面板（题量不足、难度断层、待审核比例）
- [ ] 4.5 noj-docs 新增用户文档 `features/knowledge-graph.md`
      与出题人说明；Agent Note

## 5. 验收

- [ ] 5.1 noj-tests 跨域 E2E：发布题目 → 自动打标 → 提交达标 → 掌握度更新 →
      推荐变化
- [ ] 5.2 特性开关灰度与回滚演练
