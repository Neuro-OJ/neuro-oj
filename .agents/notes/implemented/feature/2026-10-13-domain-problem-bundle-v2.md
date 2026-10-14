# Agent Note: 工作空间题包格式 2 与 CLI 同步

Status: implemented

## Problem

旧题包把 P/U 分类写入清单，CLI 和 core 的校验副本还存在公开样例与 OI
导入规则漂移。题包携带旧
Provider/模型字段时，校验器虽然宣称忽略字段，实际仍会把它们原样返回，不能准确表达由使用域决定执行配置的契约。

## Decision

- 新清单使用 `format_version: 2`，无 P/U `type`，可携带数字 `number`。目标
  Domain 由导入路径或 CLI `--domain` 指定，不随题包保存部署 Domain ID。
- 格式 1 只转换显式 P 题包，并通过解析结果的 `warnings` 提示升级。U
  包及缺分类的旧包要求作者先转换，未修改独立私有题源仓库。
- 规范化时仅保留 LLM 单次预算 `max_calls`、`max_tokens`，移除
  Provider、模型、密钥和其他部署执行字段。空对象仍表示启用 LLM。
- CLI `init`、`pack` 只生成 v2；`lint`
  报告旧格式转换提示。`problem import --domain <slug>`
  沿用部署容器命令透传。移除脚手架与交互引导的 P/U 提问。
- 同步 core/CLI 校验副本、公开样例校验、Hydro/OI
  解析、共享契约夹具、默认样例与恢复演练题包，Hydro 自动规范为 v2。
- manifest TypeScript 接口暂保留标记弃用的可选
  `type`，仅供旧内部导入编排过渡；校验器及新包的实际输出均无该字段。

## Alternatives considered

- 把题包绑定某部署的 Domain ID
  会使跨实例复用困难，因此目标工作空间由导入请求指定。
- 放行旧 U 包会让已取消的分类继续影响权限和题号；首版要求作者显式转换。
- CLI 直接复用 core
  的导入映射会破坏独立编译，继续保留标注原始路径的副本，并通过同一份共享夹具验证行为。

## Consequences

CLI 添加与 core 相同的 YAML 解析依赖，由 Deno
自动更新锁文件；无手工锁文件修改。使用私有题源的维护者须将版本改为 2、删除顶层
`type`，并移除 LLM Provider/模型/密钥字段。旧无域 CLI 导入仍定位默认域
`main`；全包导入、域内编号与发布流程由 core 域服务统一处理。

验证：CLI 标准全量测试 755 通过、0 失败、4 条按现有环境条件跳过；core
`test:domain catalog` 360 通过、0 失败；共享标准脚本 292 通过、0 失败、16
条按现有条件跳过。回归覆盖 P 包升级提示、U 包拒绝、打包实际 v2
输出及输入不变性、来源执行配置去除、Hydro 解析、交互引导回退、`--domain`
参数透传与 core 脚手架真实 evaluator 执行。
