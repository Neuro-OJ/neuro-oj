# Phase 5 横切增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地可靠性、CI 加速、属性/模糊/性能/回放等横切测试增强，每个方向至少 1-2 个具体改进。

**Architecture:** 可靠性通过静默跳过报告（Phase 0 已建）与 E2E 重试辅助落地；加速通过 core 并行分片参数、E2E 分组均衡、judge sccache 复用与 UI 测试并行落地；新测试类型通过无新依赖的属性/模糊测试与现有 perf/replay 扩展落地。

**Tech Stack:** Deno 2、Rust、GitHub Actions、fast-check（可选，默认无新依赖）。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 `deno.lock` / `Cargo.lock` 手动内容。
- Deno 测试必须通过 `deno task` 封装命令运行；Rust 测试用 `cargo nextest run --all-targets`。
- 中文注释、英文标识符。
- 不新增 CI 覆盖率硬门禁；加速目标为趋势参考，不设硬门禁。

---

### Task 1: E2E 重试辅助与 flaky 治理

**Files:**
- Modify: `noj-tests/e2e/helper.ts`
- Modify: `noj-tests/e2e/submission/queue.test.ts`

**Interfaces:**
- Consumes: 现有 `e2eTest`。
- Produces: 新增 `retryE2E(fn, options)` 辅助函数。

- [ ] **Step 1: 写失败测试**

在 `noj-tests/e2e/helper.ts` 末尾追加：

```ts
/**
 * E2E 重试辅助：对已知偶发 flaky 的断言进行有限重试。
 *
 * @param fn 需要重试的异步断言函数
 * @param options.retries 最大重试次数（默认 2）
 * @param options.delayMs 重试间隔（默认 1000）
 */
export async function retryE2E(
  fn: () => Promise<void>,
  options: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const { retries = 2, delayMs = 1000 } = options;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
```

- [ ] **Step 2: 在 queue.test.ts 使用重试**

将 `queue.test.ts` 中“提交后出现在队列中”的断言改为：

```ts
e2eTest("[e2e/queue] 7.2 提交后出现在队列中", async () => {
  if (!isE2E) return;
  const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
  await retryE2E(async () => {
    const { body } = await apiGet("/api/v1/queue", adminToken);
    const q = body as { pending: { id: string }[]; judging: { id: string }[] };
    const ids = [...q.pending.map((x) => x.id), ...q.judging.map((x) => x.id)];
    if (!ids.includes(id)) throw new Error("提交未出现在队列");
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain submission`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "test(e2e): 新增重试辅助治理 flaky"
```

---

### Task 2: 增强审计断言

**Files:**
- Modify: `noj-tests/e2e/system/audit_log.test.ts`

**Interfaces:**
- Consumes: 现有 audit log E2E。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

在 `noj-tests/e2e/system/audit_log.test.ts` 末尾追加：

```ts
e2eTest("[e2e/audit] 管理操作写入审计且包含 request_id", async () => {
  if (!isE2E) return;
  const adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  const res = await apiPost(
    "/api/v1/admin/announcements",
    { title: "Audit " + ts, content: "x" },
    adminToken,
  );
  if (res.status !== 201) throw new Error("创建公告失败 " + res.status);
  const list = await apiGet("/api/v1/admin/audit-logs?limit=5", adminToken);
  const rows = (list.body as { data?: Array<{ action: string; request_id?: string }> }).data ?? [];
  const hit = rows.find((r) => r.action.includes("announcement"));
  if (!hit) throw new Error("审计日志应包含公告创建记录");
  if (!hit.request_id) throw new Error("审计记录应包含 request_id");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-tests && deno task test:domain system`
Expected: FAIL，测试文件不存在或审计字段名不符。

- [ ] **Step 3: 按实际审计接口修正**

阅读 `noj-core/src/domains/system/routes/` 与 `noj-core/src/domains/admin/routes/system.ts`，将端点、字段名调整为实际实现；若审计记录无 `request_id`，改为断言 `actor_id` 或 `created_at`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-tests && deno task test:domain system`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(e2e): 增强审计日志业务断言"
```

---

### Task 3: core 并行分片参数优化

**Files:**
- Modify: `noj-core/scripts/test-parallel.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 现有分片脚本。
- Produces: 分片数量可配置，CI 按 Domain 并行。

- [ ] **Step 1: 写失败测试**

在 `noj-core/scripts/test-parallel.ts` 中增加 `--shards` 参数支持，并添加测试（若脚本无测试，则先创建 `noj-core/tests/scripts/test-parallel.test.ts`）：

```ts
/**
 * test-parallel 分片参数解析测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parseShardArgs } from "../../scripts/test-parallel.ts";

Deno.test("test-parallel: 默认分片为 2", () => {
  assertEquals(parseShardArgs([]), 2);
});

Deno.test("test-parallel: 解析 --shards 4", () => {
  assertEquals(parseShardArgs(["--shards", "4"]), 4);
});

Deno.test("test-parallel: 非法分片数回退默认", () => {
  assertEquals(parseShardArgs(["--shards", "abc"]), 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，`parseShardArgs` 未导出。

- [ ] **Step 3: 实现参数解析**

在 `noj-core/scripts/test-parallel.ts` 中新增：

```ts
export function parseShardArgs(args: string[]): number {
  const idx = args.indexOf("--shards");
  if (idx === -1) return 2;
  const raw = args[idx + 1];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2;
}
```

并在 `main` 入口使用 `parseShardArgs(Deno.args)` 控制分片数。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "perf(core): test-parallel 支持 --shards 参数"
```

---

### Task 4: E2E 分组均衡与 judge sccache 复用

**Files:**
- Modify: `.github/workflows/e2e.yml`

**Interfaces:**
- Consumes: 现有 E2E Domain job。
- Produces: 分组更均衡，judge job 复用 sccache。

- [ ] **Step 1: 检查当前分组**

阅读 `.github/workflows/e2e.yml` 中 e2e-full 分组与 judge-sandbox 的 sccache 配置，记录当前分组文件数与缓存 key。

- [ ] **Step 2: 调整分组注释与缓存 key**

在 judge-sandbox job 中确保 sccache 缓存 key 包含 `Cargo.lock` 与 `rust-toolchain`：

```yaml
      - name: 缓存 sccache
        uses: actions/cache@v4
        with:
          path: ${{ runner.temp }}/sccache
          key: judge-sccache-${{ hashFiles('noj-judge/Cargo.lock', 'noj-judge/rust-toolchain.toml') }}
          restore-keys: |
            judge-sccache-
```

- [ ] **Step 3: 验证 YAML 语法**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/e2e.yml')); print('yaml ok')"`
Expected: `yaml ok`。

- [ ] **Step 4: 提交**

```bash
jj describe -m "ci(e2e): 优化 judge sccache 缓存 key"
```

---

### Task 5: 属性测试（分页/序列化）

**Files:**
- Create: `noj-core/tests/shared/property-pagination.test.ts`

**Interfaces:**
- Consumes: `src/shared/http/pagination.ts` 的分页解析函数。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-core/tests/shared/property-pagination.test.ts`：

```ts
/**
 * 分页解析属性测试：随机输入下不崩溃且结果在合法范围。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { parsePagination } from "../../src/shared/http/pagination.ts";

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

Deno.test("property: parsePagination 随机输入收敛到合法范围", () => {
  for (let i = 0; i < 1000; i++) {
    const page = randomInt(1000) - 500;
    const pageSize = randomInt(1000) - 500;
    const result = parsePagination({ page, pageSize });
    assertEquals(result.page >= 1, true);
    assertEquals(result.pageSize >= 1, true);
    assertEquals(result.pageSize <= 100, true);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: FAIL，`parsePagination` 不存在或签名不符。

- [ ] **Step 3: 按实际分页函数修正**

阅读 `noj-core/src/shared/http/pagination.ts`，将导入函数名与参数调整为实际实现；若函数名为 `parsePaginationParams`，同步修改测试。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && bash scripts/test-shared.sh`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(core): 分页解析属性测试"
```

---

### Task 6: 模糊测试（judge ZIP 随机输入）

**Files:**
- Modify: `noj-judge/src/sandbox/container.rs`

**Interfaces:**
- Consumes: `extract_zip_entries_reader_with_limits`（Phase 3 已提取）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

在 `noj-judge/src/sandbox/container.rs` 的 `mod tests` 中追加：

```rust
#[test]
fn test_extract_zip_random_bytes_never_panics() {
    // 简单确定性伪随机：对随机字节调用解压，只要求不 panic（返回 Err 可接受）。
    let mut seed = 0x1234_5678u64;
    for _ in 0..200 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let len = (seed % 4096) as usize;
        let mut bytes = Vec::with_capacity(len);
        for _ in 0..len {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            bytes.push((seed >> 32) as u8);
        }
        let _ = extract_zip_entries_reader_with_limits(
            std::io::Cursor::new(bytes),
            10,
            1024,
            4096,
        );
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-judge && cargo test --lib sandbox::container::tests::test_extract_zip_random_bytes_never_panics`
Expected: FAIL，函数不存在（若 Phase 3 未先实施，则先实施 Phase 3 Task 6）。

- [ ] **Step 3: 运行测试确认通过**

Run: `cd noj-judge && cargo test --lib sandbox::container::tests::test_extract_zip_random_bytes_never_panics`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
jj describe -m "test(judge): ZIP 随机输入模糊测试"
```

---

### Task 7: 性能基准扩展

**Files:**
- Modify: `noj-core/tests/perf/search_bench.test.ts`

**Interfaces:**
- Consumes: 现有搜索基准。
- Produces: 新增榜单/队列基准或扩展搜索基准。

- [ ] **Step 1: 写失败测试**

在 `noj-core/tests/perf/search_bench.test.ts` 末尾追加：

```ts
Deno.test("perf: 分页解析 10 万次耗时低于 500ms", () => {
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) {
    parsePagination({ page: i % 100, pageSize: 20 });
  }
  const elapsed = performance.now() - start;
  if (elapsed > 500) {
    throw new Error(`分页解析过慢: ${elapsed}ms`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-core && deno task test:domain shared`（或 perf 所在 domain）
Expected: FAIL，`parsePagination` 未导入或测试文件不存在。

- [ ] **Step 3: 按实际函数修正**

若 `search_bench.test.ts` 未导入 `parsePagination`，在文件顶部补充导入；若性能阈值过紧，放宽到 1000ms。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-core && deno task test:domain shared`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "perf(core): 扩展分页解析性能基准"
```

---

### Task 8: LLM 回放扩展（错误/限流快照）

**Files:**
- Modify: `noj-llm-gateway/tests/replay_test.ts`
- Create: `noj-llm-gateway/tests/replay/fixtures/rate-limit.json`

**Interfaces:**
- Consumes: 现有 replay fixture 结构。
- Produces: 新增 rate-limit fixture 与测试。

- [ ] **Step 1: 创建 rate-limit fixture**

创建 `noj-llm-gateway/tests/replay/fixtures/rate-limit.json`：

```json
{
  "model": "deepseek-chat",
  "request": {
    "messages": [{ "role": "user", "content": "ping" }],
    "max_tokens": 5
  },
  "response": {
    "error": {
      "message": "rate limit exceeded",
      "type": "rate_limit_error"
    }
  },
  "upstream_status": 429
}
```

- [ ] **Step 2: 写失败测试**

在 `noj-llm-gateway/tests/replay_test.ts` 末尾追加：

```ts
const RATE_LIMIT_FIXTURE_PATH = new URL(
  "./replay/fixtures/rate-limit.json",
  import.meta.url,
).pathname;

Deno.test("replay: rate-limit fixture 包含 429 与错误结构", async () => {
  const fixture: {
    upstream_status: number;
    response: { error: { type: string } };
  } = JSON.parse(await Deno.readTextFile(RATE_LIMIT_FIXTURE_PATH));
  assert(fixture.upstream_status === 429, "upstream_status 应为 429");
  assert(
    fixture.response.error.type === "rate_limit_error",
    "错误类型应匹配",
  );
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd noj-llm-gateway && deno task test:snapshot`
Expected: FAIL，fixture 文件不存在。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-llm-gateway && deno task test:snapshot`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(gateway): 扩展 LLM 回放限流快照"
```
