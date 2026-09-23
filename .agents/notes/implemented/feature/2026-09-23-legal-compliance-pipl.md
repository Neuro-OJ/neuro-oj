# Agent Note: 法律合规功能集（PIPL 告知—同意—行权闭环）

Status: implemented

## Problem

Neuro OJ 面向 IOAI / NOAI / LMCC 等场景处理未成年人个人信息、选手代码、LLM
prompt 与来源 IP，但在合规上存在系统性缺口：

1. **无同意留痕**：注册无任何条款同意环节，也无法证明"用户何时同意过哪一版"。
2. **政策不可版本化**：隐私政策/服务条款无页面、无历史版本，改政策无痕迹。
3. **权利无通道**：无个人信息导出、无删除/更正请求入口，不满足 PIPL 的
   查阅/复制/删除权。
4. **处理者与备案不可配**：部署者无法在页脚展示 ICP/公安备案与运营主体。
5. **第三方与留存不透明**：LLM Provider、内容审核等第三方共享与各表留存期限
   无集中告知；`llm_usage` 保留完整 prompt 未说明必要性。
6. **政策真实性无锚**：无法证明某版政策在某时刻已存在，存在"事后偷改条款"质疑。

## Decision

- 新增 `legal` 域（`schema/legal.ts`）：`legal_documents` /
  `legal_document_versions` / `user_consents` / `data_requests` 四表。版本行
  **只追加不可变**，`content_hash` 用规范化正文的 SHA-256 绑定"同意的是哪一版内容"。
- **重新同意只认重大版本**：`getRequiredConsentVersion` 取最近一个
  `is_material=true` 的版本，错字/排版类编辑不打扰用户。
- **注册硬门槛且原子**：`RegisterInput.accepted_legal` 必须为 `true`；
  `registerUser` 在同一事务内写 privacy+terms 两条同意记录（版本/时间/IP/UA）。
- **`/auth/me` 注入 `legal` 状态**：`{ required_version, agreed_version,
  needs_consent, is_material }`，供前端弹窗判定，无需额外请求。
- **配置化而非硬编码**：`settings-registry` 新增 `legal` 分类（运营主体、联系
  方式、ICP/公安备案、第三方清单）与 `tsa_*`；旧 `data_policy_*` 经 0088
  自定义迁移搬运到 `legal_*` 并删旧键。
- **公开只读端点**：`GET /api/v1/legal/documents`、`/documents/:kind/versions`、
  `/site/meta`（备案+第三方），均只读、无认证。
- **TSA 可选且不阻塞**：`tsa_provider` 默认 `disabled`；只对政策版本哈希打
  RFC 3161 时间戳，失败仅告警不阻塞发布，须保存证书链。免费 Provider
  （freetsa/digicert）标注"仅技术验证"，中国法律场景建议 `custom` 接国内 TSA。
- **权利通道**：`GET /api/v1/users/me/data-export`（聚合本人账户/提交/社区/
  同意）；`POST/GET /api/v1/legal/data-requests` 提交与查看；管理端
  `GET/PATCH /api/v1/admin/legal/data-requests` 按状态机
  `pending→processing→resolved|rejected` 处置。
- **前端**：新增 `/legal/privacy`、`/legal/terms` 渲染页；注册页加
  「我已年满 14 周岁，或在监护人陪同下已阅读并同意…」复选框（未勾选禁用提交）；
  页脚按 `/site/meta` 渲染备案；`/admin/legal` 管理页（政策编辑+发布、备案主体、
  第三方、TSA），交互复用社区配置页的"本地草稿 + 未保存标识 + 统一保存"，但
  **不提供 preset**。
- **CI 接线**：`ci.yml` 增补 `core-legal` job 与路径过滤；`legal` 域测试目录登记
  进 `test-parallel-shards.ts` 的 `db` 分片。

## Alternatives considered

- **政策变更一律要求重新同意**：错字修订也会打扰全体用户，损害体验；改为只认
  重大版本。
- **对每次用户同意打时间戳**：高频且成本高、法律价值低；只对政策版本哈希打戳。
- **第三方共享单独弹窗同意**：与"告知即可"的行业实践不符且打断流程；并入政策
  告知。
- **手改 `_journal.json` 添加数据迁移**：违反 AGENTS §8.1；改用
  `drizzle-kit generate --custom` 生成 0088，自动登记 journal。
- **为备案键写 `config-usage: exempt`**：豁免只掩盖"只登记不消费"；改为新增
  `/site/meta` 端点真正接线。
- **在平台侧执行真实年龄验证/监护人回执**：NOJ 作为独立社区部署，注册环节采用
  与行业一致的自我声明式同意（复选框文案已含年满 14 周岁或监护人陪同的声明），
  并将未成年人条款交由部署者在隐私政策中按适用法规补充；平台不代为判断监护人关系。
- **`llm_usage` 去掉完整 prompt 以最小化**：会丧失审查选手代码/检测作弊/防非法
  内容致 API 封禁的申诉证据；维持留存并在政策中如实告知。

## Consequences

- 未发布政策时注册仍成功但不写同意记录；**部署者必须先发布政策再开放注册**
  （`noj-docs/docs/operators/legal-compliance.md` 已写明）。
- 页脚备案位未配置时不渲染，境外托管（无 ICP）可留空。
- TSA 根证书当前无代码读取点（仅签发不校验），在注册表以 `config-usage: exempt`
  登记并注明原因，留待后续离线验证实现。
- 政策重大变更同意弹窗（`LegalConsentModal`）已交付：登录用户存在未同意的
  `is_material` 版本时展示，**不可关闭**，同意后调用 `/legal/consent` 并刷新状态。
- OAuth 注册同样受硬门槛约束：`intent=login` 的授权需带 `accepted_legal=true`，
  回调建号时校验，且与用户插入同事务写同意记录；绑定（`intent=link`）不建号不受影响。
- `legal` 域已登记进 `check-domains.ts` 的 `DOMAINS`，域边界门禁对新域生效；
  `test-domain.sh` 与 `ci.yml` 的 `core-legal` job 可用。
- `/admin/legal` 的配置草稿在加载后由已保存值初始化（secret 项除外），"放弃"可还原到
  服务器值，运营者可见本部署已配置内容。
- **验证教训**：noj-core 的 CI 静态门禁是 `deno lint` + `find src -name '*.ts' | xargs
  deno check`（覆盖测试文件），**不是** `deno check src/mod.ts`；`deno test --no-check`
  会掩盖测试文件的类型错误。新增域/测试后必须跑上述精确命令。

## P1（权利保障）补充

- **D5 变更弹窗**：`/auth/me` 的 `legal.<kind>` 新增 `change_summary`（仅需同意时查
  询），弹窗展示版本区间 + 变更摘要 + 「查看全文」链接。
- **D6 数据导出**：设置页「个人信息与隐私」提供「导出我的数据」，前端将
  `/users/me/data-export` 的 JSON 存为文件下载。
- **D7 删除/更正请求**：设置页提交与查看自己的请求；`/admin/legal` 新增「删除/更正
  请求」Tab，按状态过滤并执行 `受理/办结/驳回`（复用状态机与限流）。管理端展示
  提交人（user_id）与完整 target_id；办结/驳回需录入**处理说明**（驳回必填），
  用户侧展示该说明，形成权利保障闭环。
- **D8 处理者信息**：`/site/meta` 增补 `operator_name` / `contact`（不含 secret）；
  隐私政策与服务条款页尾展示处理者与第三方清单（`buildThirdPartyList` 容错解析，
  非法 JSON/空 name 均安全降级）。
- E2E 扩展：请求全生命周期与状态机、未认证 401、`/site/meta` 不泄密。
- 新增公开端点（`/legal/*`、`/site/meta`）均为只读白名单，不暴露完整系统设置。
- `users.ts` 写路由（改资料/头像/注销）补齐限流，偿还了限流门禁中的一笔欠债。

## 2026-09-25 三轮评审修正

- **登录页 OAuth 不再"死路"**：登录页第三方登录不携带 `accepted_legal`（老用户登录
  不应被迫重新勾选），新账号建号被硬门槛拒绝时，回调把 `LEGAL_CONSENT_REQUIRED`
  原样映射为 `oauth_error=legal_consent_required`，登录页据此展示"去注册页勾选同意"
  的指引。此前该错误被折叠成 `provider_error`，用户只看到"稍后重试"且永不成功。
- **注册同意留痕**：未发布政策时除跳过记录外，另记一条 WARN（含 kind 列表），
  避免"开放注册但政策未发布"的部署静默产出零同意记录。首次发布政策后，存量用户
  会因 `needs_consent` 弹窗补同意，无需数据修复。
- **发布版本并发安全**：`publishVersion` 改为按读到的 `current_version` 做条件更新
  （命中 0 行 → 409 `ConflictError`；首发布撞 `legal_documents_kind_unique` 同样转
  409），消除并发发布导致的未翻译 500。
- **正文与哈希同源**：落库正文改用 `normalizeContent()`（`\r\n`→`\n`、去首尾空白）
  的结果，与 `content_hash` 一致，保证"哈希可独立复核正文"。
- **旧 env 名兼容**：新增 `legal_deployment_notes`（`LEGAL_DEPLOYMENT_NOTES`）承载
  原 `data_policy_deployment` 的"部署补充说明"语义；旧 env 名
  `DATA_POLICY_CONTACT` / `DATA_POLICY_DEPLOYMENT` 以 `visible: false` 的别名项登记
  并在读取链中兜底，升级后不会静默失去联系方式/部署说明。0088 迁移的搬运目标同步
  改为 `legal_deployment_notes`（此前误搬进 `legal_operator_name`，会让
  `/api/v1/data-policy` 把多行说明渲染成"处理者：<说明>"）。
- **管理端审计筛选**：`legal.publish_version` / `legal.data_request_update` 登记进
  `AUDIT_ACTIONS`（写入侧早已落库，此前筛选清单没有这两项）。
- **读路径校验与限流**：`GET /admin/legal/data-requests?status=…` 非法状态由"静默
  返回空列表"改为 400，与写路径口径一致。
- **公开轮播图片**：`getCarouselImageBytes` 增加 `is_enabled=true AND kind='image'`
  过滤，停用后的图片不再可按 UUID 从公开端点取到。
- **部署探针修复**：`noj-cli backup drill` 与 `scripts/deploy/restore-drill-verify.ts`
  的注册探针补 `accepted_legal: true`，否则恒 400 并被误归因为"邮件提供方问题"。
- **i18n**：同意相关文案补齐 en-US，并新增"两语言键集合一致"单测；登录页提示加
  `data-testid` 便于 E2E 定位。
- **TSA 复核的信任模型**见提交「TSA 时间戳校验与离线复核」的说明（未配置
  `tsa_root_cert` 时返回 `trusted:false`，不再给出无信任锚的 `ok:true`）。
