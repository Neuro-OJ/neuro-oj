# Agent Note: PGlite 模板缓存两个静默失效缺陷（sidecar 不重建 / 指纹输入漂移）

Status: implemented

## Problem

`noj-core/src/shared/db/connection.ts` 的 PGlite 模板缓存由三个产物组成：

| 产物                     | 写入者                                         | 读取者                                            |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------- |
| `pglite-template.tgz`    | `ensurePGliteTemplateCached()`（全量重建分支） | `createPGliteInstanceFromTemplate()`（同步）      |
| `pglite-template.hash`   | 同上（异步内容 hash）                          | `ensurePGliteTemplateCached()` 判断是否重建       |
| `pglite-template.schema` | 同上（同步指纹 sidecar）                       | `createPGliteInstanceFromTemplate()` 判断是否过期 |

代码评审查出两个缺陷，二者都表现为**"调用方看到模板就绪，fast path
实际已失效"**， 即失败是静默的（正确性尚可，性能与数据新鲜度不可）。

### 缺陷 1：hash 命中路径提前 return，sidecar 被跳过

`ensurePGliteTemplateCached()` 在 `.hash` 与 `.tgz` 都命中时直接
`return PGLITE_TEMPLATE_FILE;`，而**写 sidecar
的代码在其后**（仅在全量重建分支里）。 于是 sidecar 缺失时：

- `createPGliteInstanceFromTemplate()` 读到空指纹 → 判定过期 → 返回 `null`；
- 每个测试文件都退化为 `new PGlite()` + 执行全部 DDL 的慢路径；
- `scripts/prepare-pglite-template.ts` 仍然打印"模板就绪"。

2026-09-17 实测：在只有 `.hash` + `.tgz` 的目录上运行准备脚本，sidecar
保持缺失。

### 缺陷 2：同步指纹与异步 hash 的输入集合不一致

- `computePGliteTemplateHash()`（异步）覆盖 `schema-ddl.ts` + `seed-rbac.ts` +
  `community-seed.ts` + 格式版本；
- `computeSchemaFingerprintSync()`（同步）**只**覆盖 `schema-ddl.ts`。

只改种子源码时 hash 变化、指纹不变 → 指纹校验认为模板未过期 → 模板 fast path
**静默加载旧种子数据**（RBAC 角色/权限、社区种子）。2026-09-17 实测：给
`community-seed.ts` 追加一行注释，hash 由 `22968e4a…` 变为 `8f2c7a9d…`，
指纹稳定在 `1:94282e7a:39703`。

## Decision

1. **合并输入清单为单一事实源**：新增 `PGLITE_TEMPLATE_INPUT_FILES` （schema
   DDL + RBAC/社区种子，相对 `shared/db` 的路径）与
   `resolveTemplateInputFiles()`； 异步 hash
   与同步指纹都只从该清单取输入，两者不再可能漂移。同步指纹保持**同步**
   （`Deno.readTextFileSync`），同步加载路径的约束不变。
2. **命中缓存也必须补齐产物**：`ensurePGliteTemplateCached()` 改掉"命中即
   return" 的写法 —— hash 命中且模板存在时，先调用 `writeSchemaFingerprint()`
   校验/补写
   sidecar，再返回。全量重建分支同样收敛到该函数，三个产物只有一个写入点。
3. **缓存目录可注入**：新增
   `PGLITE_TEMPLATE_CACHE_DIR`（`pgliteTemplatePaths()`）， 默认仍为
   `src/.test-cache`；三个产物路径由同一函数派生，测试与复现脚本可在临时
   目录运行，**绝不触碰开发者真实缓存**。
4. **回归测试**：`tests/shared/db/pglite-template-cache.test.ts` 覆盖 「sidecar
   缺失/陈旧时的补齐」与「输入集合共享、种子变更同时改变两个指纹」，
   全程临时目录、零 PGlite 构建（预置产物走命中分支）。

## Alternatives considered

- **把 sidecar 写入语句复制到命中分支**：两份写入逻辑会再次漂移， 正是缺陷 2
  的成因；改为收敛到 `writeSchemaFingerprint()` 单一写入点。
- **同步指纹改为 async 并 await hash**：`createPGliteInstanceFromTemplate()`
  及其 调用点（`getDb()` / `ensurePGliteSchemaForTest()`）是同步的，改动面过大；
  统一输入清单是等价且更小的修复（与 2026-09-14 note 的取舍一致）。
- **让同步指纹覆盖"全部相关文件"而不共享常量**：仍靠人工同步两份清单，
  下次新增种子文件会重演同类静默失效。
- **回归测试改为真实构建模板（`buildPGliteTemplateData()`）**：单次约数秒到数十秒
  且依赖 PGlite 运行时；本缺陷的判定逻辑全部在路径/指纹/命中分支上，
  预置产物即可精确覆盖，故不构建。
- **测试注入走模块级导出变量而非 env**：Deno 每个测试文件独立模块图， 但仍需在
  import 前设置；运行时读 env 同时让复现脚本（`prepare-pglite-template.ts`）
  可以复用同一个开关，避免第二套注入机制。

## Consequences

- 新增进入模板内容的输入（DDL / 索引 / 种子）**只**需改
  `PGLITE_TEMPLATE_INPUT_FILES`， 两个指纹自动生效；不兼容的内容变更用
  `PGLITE_TEMPLATE_FORMAT` 整体失效。
- 手工删除 `.test-cache/pglite-template.schema` 不再是"静默降级"： 下一次
  `deno task test` / `test:domain`（PGlite 模式）会就地补写。
- `PGLITE_TEMPLATE_CACHE_DIR` 是测试/工具级注入（非产品配置面）， 已在
  `scripts/check-config-usage.ts` 的 `REVERSE_EXEMPT` 中登记豁免理由。
- 指纹定义变化会让既有 sidecar 一次性过期 → 老缓存首次运行多花一次
  `computeSchemaFingerprintSync()`（毫秒级），不会触发模板重建（hash 未变）。
