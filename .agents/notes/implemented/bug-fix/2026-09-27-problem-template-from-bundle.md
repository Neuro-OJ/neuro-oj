# Agent Note: 编辑器初始代码模板改为随题包导入落库（线上全部题目模板恒 404）

Status: implemented

## Problem

线上（`https://neuro-oj.icu/editor/P5`「魔法 Agents 的推理审判」）打开编辑器时
**代码框始终空白**，题目 `problem.json` 明明声明了 `template: "template.py"`。
前端不是没请求：`EditorWorkspace.vue` 在无本地草稿时会拉
`GET /api/v1/problems/:id/template`，而该端点返回
`404 {"error":"该题目没有初始代码模板"}`；前端把 404 当作"这题本来就没有模板"
静默忽略（`err.statusCode !== 404` 才提示），于是表现为"什么都不发生"。

后端 `getProblemTemplate()` 当时的解析方式是**扫服务器本地源码目录**
`Deno.cwd()/data/problems-src`，命中条件为
`manifest.number === problem.number && manifest.title === problem.title`。
三个缺陷叠加，使**所有**线上题目的模板都取不到（不止 P5）：

1. **题号对不上**：题号 `number` 是导入时由数据库自增分配的（P5 → 5），出题人本地
   `problem.json` 普遍**不写** `number`（`noj-problems/` 下 5 道题全部如此，只有
   仓库自带的样例题 `1001` 有）。`undefined === 5` 恒为假 → `srcDirs.length !== 1`
   → 返回 null。实测：把私有题源直接当作 `srcRoot` 传入，仍然返回 null。
2. **生产没有该目录**：`noj-core/Dockerfile` 构建时 `COPY data/ ./data/`，镜像里只有
   git 里那份 `data/problems-src/1001`；`docker-compose.prod.yml` 的 core 只挂载
   `data/packages` 与 `data/storage`。正式题目走题包上传（statement 落 `description`、
   评测包落对象存储），私有题源**从不进入容器**。
3. **模板文件本身被排除出题包**：`noj-cli problem pack` 与 `noj-core/scripts/noj.ts`
   都按旧规范「模板不要放入包中」把 `template.py` 排除。于是"既不进包、平台也不读包"
   ——模板内容只剩出题人本地一份。唯一例外是私有题源自己的 `build_bundle.sh`
   （显式把 `template.py` 打进包），所以 P1–P5 的**已存储**支持包里其实是有模板的，
   只是没人读它。

源码里早有 TODO 承认这条路径不可用于生产：
`support-package.ts` 原文「生产环境需要将模板单独存储（TODO: 上传至 S3/对象存储）。
目前 dev 模式：直接从源码目录读取。」

## Decision

把模板**当作题包元数据**处理，与题面（`statement.md` → `problems.description`）
完全同策略：**随包上传、导入时持久化、运行期读库**。

1. **新增列 `problems.template_content`（text，可空）**。`importProblemBundle`
   从上传 zip 的条目中按 `manifest.template`（缺省 `template.py`）读取模板并落库；
   重新导入时用新包内容覆盖。取值为**空串**表示"导入时已核对、包内没有模板"
   （NULL 只留给本列引入前的存量行）——解析时据此跳过回源读包，否则**没有模板**的
   题目每打开一次编辑器都要把整个支持包（上限 128 MiB）从对象存储拉一遍。
   模板超过 `MAX_TEMPLATE_BYTES`（256 KiB）按"无模板"处理并在导入日志告警；
   **显式声明** `manifest.template` 但包内没有该条目时同样告警（此前正是这类静默
   失配导致线上 404）。转为客观题套卷时清空。
2. **解析顺序**（`resolveProblemTemplate`，路由与 admin 预检的唯一入口）：
   ① `template_content`（空串则跳过第 ② 级）→ ② 已存储支持包内的 `template.py`
   → ③ 本地源码目录（仅开发环境有意义）。
   第 ② 级用 fflate 的 `filter` 只在中央目录阶段选中目标条目，**不会**为一个几 KB 的
   模板把上百 MiB 评测数据全量解压；它存在的原因是让**本次改动之前导入的存量题目**
   （字段为 NULL、但包里有模板）无需重新导入即可恢复——线上 P1–P5 属于这一类。
   包内 `problem.json` 在导入时已被剥离，因此第 ② 级只能按默认名 `template.py`
   探测：存量题目若用自定义模板名，仍需重新导入后才能取到。
3. **打包侧改为保留模板**：`noj-cli problem pack` 与 `problems:build` 不再排除
   `template.py` / `manifest.template` 指定的文件（`submission*`、`__pycache__`、
   `.git` 仍排除）。不这样做，"从包读模板"对守规范的出题人就是死路。
4. **匹配规则放宽为"题号可选"**（本地源码目录回退路径）：标题必须一致；manifest
   **显式声明** `number` 时题号也必须一致；未声明则按标题唯一匹配。仍要求候选目录
   唯一，避免串入同题号/同名其他题目的模板。
5. **`template_content` 与 `support_package_storage_url` 同级管控**：仅服务端导入
   流程可写，客户端 `PUT /problems/:id` 直传一律 400（`allowServerDerivedFields`）。

## Alternatives considered

- **只在请求时从对象存储读支持包**（不落库）：能修存量题目，但每次打开编辑器都要
  下载整个支持包（上限 128 MiB），热路径代价不可接受。因此只保留它作为**存量回退**，
  新增导入走落库快路径。
- **只让出题人给 manifest 补 `number`**：对容器化生产无效（题源不在容器里），且把
  题号硬编码进 manifest 会让导入从"新增"变成按 `(type, number)` 覆盖，换实例即失配。
- **把模板内联进题面**：出题人侧成本高、编辑器仍拿不到 starter code，不解决端点问题。
- **新增 `problems.template_file` 只存文件名**：解析时仍需回源（读包），不能消除热
  路径代价；而模板正文只有几 KB，直接落库最简。文件名仅在导入日志与告警中使用。
- **保留旧规范（模板不进包）、另建模板上传通道**：新增一套上传/权限/审计面，
  收益不抵复杂度。

## Consequences

- 线上存量题目（P1–P5）**无需重新导入**即可恢复模板（走支持包回退）；重新导入后走
  落库快路径。
- 新导入的题目一并获得模板与告警；出题人若仍按旧规则手工删掉模板文件，导入日志会
  出现 `manifest.template 声明的模板文件不在包内`。
- 新增一列与迁移 `0094`（可空列，无回填，`check-migration-safety` 通过）；
  `SCHEMA_DDL`（PGlite 测试建表）同步更新。
- `problems` 响应 DTO 不包含该字段（`toProblemResponse` 显式列举字段），模板仍只经
  `GET /problems/:id/template` 下发，可见性口径不变。
- 文档同步：`noj-docs/docs/standards/problem-bundle.md`、`quality.md`、
  `noj-docs/docs/problemsetters/ab-example.md`、`quick-start.md`、`web-editor.md`、
  `noj-docs/docs/reference/glossary.md`。
- 测试：`problem-template.test.ts`（题号可选匹配、包内提取、题包条目读取与自定义名/
  非法名回退/超限、非法 zip）、`problem-bundle.test.ts`（随包落库 + 端点返回 +
  存量题目回退读包 + 重导入置为"已核对无模板"）。新用例并入既有
  `ignore: skipEnv` 测试块，不新增静默跳过点（棘轮基线保持 1014）。
