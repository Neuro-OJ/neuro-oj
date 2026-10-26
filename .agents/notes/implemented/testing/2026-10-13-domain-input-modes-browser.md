# Agent Note: 预测与界面题的域上下文真实浏览器验收

Status: implemented

## Problem

main 引入预测文件与题包界面后，原有 Public、Mixed
和教学旅程尚未覆盖新输入模式的真实 Judge 执行、iframe
结果回推、参数历史和比赛固定版本。静态组件与 API
测试不能证明浏览器消息可发送，也不能证明上传文件被评分器正确读取。

## Decision

新增独立浏览器测试及合法格式 2 题包 helper。API
只准备公开源题、两个成员域、普通学生邀请和比赛，以及读取真实评测结果；正式提交、自测、历史对比、回滚、撤销、两个标签页草稿均使用
Web 控件。测试不改写评测成绩、时间或数据库数据，不调整 main 或实例政策。

实际执行包含六个步骤：

- 独立源域和两个学校引用同一源题，不使用平台管理员进行学生提交。
- 上传同一 CSV，学校 A 的 exact(V1) 得 50 分，学校 B 的 any(V2) 得 100
  分；核对提交 Domain 和版本，并通过 Web 提交详情读取分数。
- iframe 填写参数后触发自测及正式提交，新版双容器 Judge 和 SDK 返回 100
  分，`NOJ.onResult` 在 iframe 显示结果。
- 再次提交取得 40
  分，刷新后仍能读取正式和自测历史，通过实际按钮对比、回滚及撤销，并核对 iframe
  参数。
- 两个学校、相同来源题与版本的标签页分别保存草稿，刷新后互不混用；题号使用来源完整标识，提交继续归使用域。
- 源题发布 V2、学校题库策略随后切回 any，已创建比赛仍使用固定 V1
  的界面与执行模板，实际 Judge 成绩仍为 100 分。

测试通过标准 `deno task test:browser --filter=workspace-input-modes`
执行。环境明确指定
`E2E_BASE_URL=http://localhost:8104`、`E2E_UI_URL=http://localhost:3003`、`NOJ_RUN_BROWSER_E2E=1`
和 `E2E_INPUT_MODES_IMAGE_TAG=20261013-main-final`。最终运行结果为 **1 passed（6
steps）、0 failed、19 filtered out**，日志
`/tmp/noj-integration-input-browser-fourth.log`，完整运行约 19 秒。

## Alternatives considered

- 只调用 API 提交：不能覆盖文件选择、iframe 协议、参数历史和本地草稿行为。
- 使用旧 Judge 镜像：旧评分路径不能证明预测模式及可信界面模板注入正常。
- 使用固定满分或写入数据库成绩：无法证明文件内容、版本差异和实际 SDK 评测。

## Consequences

验收发现并推动修复了真实 `UiFrame` 响应式对象的
`DataCloneError`，详见[消息边界记录](../bug-fix/2026-10-13-ui-frame-json-messages.md)。失败诊断保留在本地
ignored 的截图与 trace 中。测试资源使用唯一前缀保留用于
review；没有待恢复的实例或 main 政策。

本测试不代替模型别名治理、IOI/OI 裁剪全矩阵或整体产品验收。模型别名的真实 Web
管理由独立旅程负责。
