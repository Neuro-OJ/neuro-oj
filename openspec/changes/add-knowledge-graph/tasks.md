## 0. 内容

- [ ] 0.1 依据 IOAI / NOAI 公开考纲起草官方内容包初稿（150–250
      节点、前置关系、考纲标注），懂 AI 竞赛的维护者评审后合入
- [ ] 0.2 内容包 `pack.yaml` 与 `LICENSE`（CC BY-SA 4.0）；README
      说明贡献与评审流程

## 1. P0 图谱基座（`src/features/knowledge/`）

- [x] 1.1 新建 `src/features/knowledge/`（照 `features/trainings` 样例）并在
      `src/features.ts` 登记；`knowledge.enabled` 等配置项登记到 settings
      registry
- [x] 1.2 `src/shared/db/schema/knowledge.ts`：`knowledge_packs` /
      `knowledge_nodes` / `knowledge_edges` 表与迁移
- [x] 1.3 内容包加载与校验（唯一、悬挂、无环、`extends` 冲突、deprecated
      替代合法），官方包校验接入 CI；单元测试覆盖各类非法包
- [x] 1.4 幂等导入 `scripts/noj.ts knowledge import [--pack <dir>]`，接入
      `dev-setup` 与生产 `init`，`noj-cli`
      提供对应命令；验证重复导入无变化、替换包时旧节点 deprecated、`replaced_by`
      迁移
- [x] 1.5 只读 API（节点、边、领域分组、当前包版本）与进程内只读缓存，登记到
      domain-boundaries；总开关关闭时返回未启用
- [ ] 1.6 noj-ui 图谱浏览页（按领域分组 + 前置关系可视化）——暂缓（2026-11-13）
- [x] 1.7 按「新增功能 ≤6 个手动改动文件」指标复盘功能切片结构，记录在 Agent
      Note

## 2. P1 挂载、审核与 AI 打标（默认关闭）

- [x] 2.1 `problem_knowledge`、`knowledge_tag_runs` 表与迁移
- [x] 2.2 人工挂载 API 与题目编辑页入口（出题人编辑权限 /
      实例管理员）；人工优先规则
- [x] 2.3 网关新增 `POST /internal/platform-completions`、`purpose`
      白名单、平台额度主体与审计；网关测试覆盖鉴权与计费；运维文档给出本地模型（Ollama
      / vLLM）配置示例
- [x] 2.4 `knowledge.tag` 任务：输入白名单、JSON Schema 校验、重试、内容 hash
      去重；mock 网关测试成功、低置信、非法输出、未配置、未开启
- [x] 2.5 发布流程经 `modules/runtime` 出口投递 `knowledge.tag`（不 import
      功能代码）；验证草稿保存不触发、内容未变不重复调用、未开启时不投递
- [x] 2.6 审核队列 API（接受 / 修改 / 驳回）；开启 AI
      时回填全部未归类题目（限速与进度查询），回填前展示预计题数 / token /
      费用并经确认
- [x] 2.6a 成本控制：网关按 `purpose` 的月度 token /
      金额预算与超额暂停（含测试）；提示词「固定在前、题面在后」以命中缓存，候选仅
      id+name，输入字符上限与输出 `max_tokens`；预算类错误不重试；登记
      `knowledge_ai_monthly_budget` 等配置；后台展示打标累计
      token、费用与剩余预算
- [x] 2.7 noj-ui 审核队列；题目页展示知识点（「待确认」标记、保密隐藏）

## 3. P2 难度、阶梯与讲解

- [x] 3.1 `problem_difficulty` 表；题目元数据可选及格线
- [x] 3.2 `knowledge.calibrate` 定时任务与校准公式（无 AI
      时以出题人三档为先验）；测试覆盖少样本 / 多样本边界
- [x] 3.3 三档 `difficulty` 改为派生展示，保留出题人值作回退
- [x] 3.4 节点阶梯 API（可访问性、比赛保护过滤、跨域链接、只显示有题节点）
- [x] 3.5 noj-ui 节点页（讲解 + 阶梯 + 下一题）与题目页「同类下一题」
- [x] 3.6 讲解文档渲染；试点 10–20 个基础节点讲解（AI 起草、人工审核、原创）

## 4. P3 掌握度、推荐与覆盖度

- [ ] 4.1 `user_knowledge_mastery` 物化表；有效成绩变更时经 `modules/runtime`
      出口投递 `knowledge.mastery`
- [ ] 4.2 掌握规则与前沿节点推荐；测试覆盖进行中比赛成绩不计入、保护结束后计入
- [ ] 4.3 图谱页按掌握度点亮；个人主页掌握概览
- [ ] 4.4 覆盖度面板（题量不足、难度断层、未归类、待确认、失效挂载）
- [ ] 4.5 讲解试点效果对比（看过讲解 vs 未看的达标率），决定是否扩充内容

## 5. P4 教练视角

- [ ] 5.1 班级 × 知识点掌握矩阵 API（仅该班级教学人员可见）与 noj-ui 热力图
- [ ] 5.2 按知识点挑题生成作业题目列表（复用现有作业创建流程）

## 6. 文档与验收

- [ ] 6.1 noj-docs 用户文档
      `features/knowledge-graph.md`、出题人与运维（内容包替换/扩展、AI
      打标开启、本地模型）说明；Agent Note
- [ ] 6.2 noj-tests 跨域 E2E：人工挂载 / AI 打标 → 提交达标 → 掌握度更新 →
      推荐与热力图变化
- [ ] 6.3 总开关与回滚演练
