# 上传上限契约（代理 ⇄ 应用）

> 2026-11-02 rc/v0.11 审计 F6：生产 Nginx 曾对**全部**业务请求设 `client_max_body_size 64m`，
> 而后端题包/支持包上限 128 MiB、产物硬上限默认 2 GiB —— 走默认代理时超过 64 MiB 的请求
> 在边缘就被拒绝，后端宣称的上限从未可达。

本文件是**唯一契约表**：改任何一侧都必须同步另一侧，`scripts/check-upload-limits.ts` 会
校验「代理上限 ≥ 应用上限」，并在端点未登记时失败。

| 端点（应用视角） | 代理上限（`deploy/nginx/default.conf`） | 应用上限（常量/环境变量） | 接收方式 | 授权前置 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/domains/:slug/problems/import-bundle` | 128m | `MAX_SUPPORT_PACKAGE_SIZE` = 128 MiB | `parseBody()` 整包内存解析（fflate 不落盘） | ✅ 读体前 `problem:import` + `Content-Length` 预检 |
| `POST /api/v1/domains/:slug/problems/:reference/import-bundle` | 128m | 同上 | 同上 | ✅ 同上 |
| `POST /api/v1/domains/:slug/problems/:reference/files/save` | 128m | 同上 | `parseBody({all:true})` | ✅ 读体前草稿授权 |
| `POST /api/v1/domains/:slug/problems/:reference/support-package` | 128m | 同上 | 同上 | ✅ 读体前草稿授权 |
| `POST /api/v1/domains/:slug/submissions`（multipart artifact） | 2048m | `getArtifactHardLimit()`，默认 2 GiB（`NOJ_ARTIFACT_MAX_SIZE_MB`） | **流式**（busboy → 分片写对象存储） | ⚠️ 参考需从 multipart 读取，限流/受理在读流之后 |
| `POST /api/v1/domains/:slug/contests/:id/problems/:label/submissions`（multipart） | 2048m | 同上 | 流式 | ✅ 参考来自路径，可在读流前解析 |
| 其他业务请求（`location /`） | 64m | 无业务上限（JSON/表单） | — | — |

## 约束与已知限制

1. **代理上限必须 ≥ 应用上限**：否则后端上限是空话。上限一律按"最大合法请求体"取，
   不为了拒绝攻击者而低于应用上限（攻击面靠限流与授权治理）。
2. **`Content-Length` 预检只用于快速失败**：客户端可以不发或谎报该头，因此它只与
   `client_max_body_size` 共同构成第一道闸门，不能替代流式字节上限。
3. **题包导入仍是整包内存解析**：`bundle-parser.ts` 明确选择"纯内存、不落盘"。128 MiB
   上限即内存预算；提高上限必须同时评估 core 容器 `mem_limit`。
4. **`proxy_request_buffering off`**：上传端点关闭请求体缓冲，避免边缘把整个请求写入临时
   文件后再转发；超时按端点分别放宽。
5. **外部边缘**：若宿主机 Nginx / 云 LB 在容器之前还有一层，必须同步配置同等上限，
   否则容器内的配置不起作用（部署文档需随本表更新）。
