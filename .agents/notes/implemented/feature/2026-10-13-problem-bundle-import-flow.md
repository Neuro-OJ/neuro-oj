# Agent Note: 题目上传流程重构（题包直接建题、未发布题可传支持包、noj-cli problem push）

Status: implemented

## Problem

出题人在线上按「新建题目 → 上传支持包」上传三道 LMCC 模拟题时，流程在多处走不通：

1. **新建题目永远无法上传支持包**：`import-bundle` 的目标题目模式（编辑器支持包上传）
   要求目标题目已有发布版本，否则一律 428，且文案是「保存草稿必须携带 If-Match」，
   与真实原因无关。新建题目必然未发布，这条主路径在任何情况下都失败。限制随
   #622（题目版本管理）引入，测试只覆盖了已发布题目。
2. **没有「用题目包直接建题」的界面入口**：`POST /problems/import-bundle`（不带
   problem_id）早已支持一步建题，但前端只把它用作支持包上传；出题人必须先手填一整套
   会被题包覆盖的表单（标题、题面、镜像、LLM、提交模式……）。
3. **P 型题可见性 bug**：可见性选择只在 U 型下渲染，默认值「私有」在切到 P 型后残留，
   提交被拒「P 型题目必须公开」。
4. **建题后跳到「我的题目」**：该列表只显示 U 型题，新建的 P 型题「消失」；创建模式下
   的支持包上传区永远禁用（`savedProblemId` 赋值后立即跳走，是死代码）。
5. 编辑器回填草稿时只认 `code`/`artifact`，prediction / ui 题打开编辑页被显示成 code。
6. 命令行只能 lint/pack，不能把题包推到线上平台。

## Decision

- **core**：目标题目模式去掉「必须已发布」限制，保留 `If-Match` 乐观锁（缺失 428、
  过时 409）。`updateProblem` 对未发布题目本就按草稿 revision 写入，无需其他改动。
  新增路由测试覆盖「建题 → 上传支持包」，并确认在旧限制下该测试失败。
- **ui**：
  - 新增 `BundleImportPanel`（前台 `/problems/new/bundle`、后台 `/admin/problem-import`），
    选 zip 即调用不带 problem_id 的 import-bundle 建题，可选「导入后立即发布」，成功后
    跳转到该题编辑页。
  - 抽出共用的 `ZipDropZone`（点击/拖拽选 zip，禁用时拖拽也不生效），
    `SupportPackageUpload` 改用它。
  - 纯逻辑放在 `utils/bundleImport.ts`（zip 校验、`effectiveVisibility`、成功/错误文案），
    Deno 单测覆盖；428（题包 number 撞到已有题目）改写为可操作提示。
  - 表单建题后跳到该题编辑页（前台 `/problems/:id/edit`、后台 `/admin/problem-edit/:id`）；
    创建模式不再渲染必然禁用的上传区，改为说明并链接到题包导入。
  - P 型可见性：切换题型时同步为公开，提交时统一走 `effectiveVisibility`（OI 编辑器同）。
  - 草稿回填接受全部四种提交模式。
- **cli**：新增 `noj-cli problem push <目录|zip> --server <url> [--publish]`。目录先 lint
  再内存打包（与 `pack` 共用 `packDirectory`）；认证优先 `NOJ_TOKEN`，否则在 TTY 交互
  登录（密码不回显、支持 TFA），令牌取自响应体（直连 core）或 `noj:token` Set-Cookie
  （经网页 Nitro 代理）；非回环地址强制 HTTPS；令牌不落盘。

## Alternatives considered

- **只修 UI、保留"先建空题再传包"**：仍需手填一套会被覆盖的字段，且 core 的 428 限制
  会继续挡住新建题目，治标不治本。
- **把题包导入塞进现有建题表单（创建时附带 zip）**：表单字段与题包 manifest 双重事实
  来源，冲突时以谁为准难以解释；独立入口语义更清晰。
- **CLI 用个人访问令牌（PAT）**：平台尚无 PAT 机制，新增需要 schema 与吊销设计，超出
  本次范围；先用现有 JWT（环境变量或交互登录），PAT 落地后可平滑替换。
- **CLI 把令牌缓存到磁盘**：省去重复登录，但引入凭据文件权限与清理问题；本次不做。

## Consequences

- 新建题目（未发布）可以直接在编辑页上传支持包；主题库题目不会再因隐藏的可见性字段
  建题失败。
- 已有题包的出题人可以一步建题（网页或 `noj-cli problem push`），导入默认是草稿，
  核对后发布。
- 管理员导入的题包若写了与已有题目重复的 `number`，新建入口给出明确提示（去编辑页
  上传或删除 number），不会误改已有题目。
- `noj-cli problem push` 只访问 `--server` 指定的平台 API，不路由到 Tier 3 容器；
  `problem build|import`（服务端命令）不受影响。
