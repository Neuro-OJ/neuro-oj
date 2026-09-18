# Phase 2 noj-ui 组件/composable 测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 noj-ui 关键 composables 与核心组件建立测试，使关键 composables 覆盖率 ≥60%，并落地 5-10 个核心组件交互测试。

**Architecture:** 引入 Vitest + `@nuxt/test-utils` + `@vue/test-utils` 作为 UI 测试运行器，与现有 Deno 纯工具测试并存。composables 测试通过 `mockNuxtImport` 模拟 Nuxt auto-import；组件测试通过 `mountSuspended` 挂载真实组件。

**Tech Stack:** Vitest、@nuxt/test-utils、@vue/test-utils、happy-dom、Nuxt 4、Vue 3。

**Spec:** `dev-docs/superpowers/specs/2026-09-08-test-enhancement-roadmap-design.md`

## Global Constraints

- 遵守 AGENTS.md：提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述；禁止修改 `deno.lock` / `Cargo.lock` 手动内容。
- 现有 `deno task test`（纯工具测试）必须继续通过；新增 Vitest 测试通过 `deno task test:components` 或 npm script 运行，不破坏现有命令。
- 中文注释、英文标识符。
- 技术约束：Nuxt auto-import（`useState` / `useRoute` / `import.meta.client` 等）无法在纯 Deno 测试中解析，因此 composables 测试也使用 Vitest + `@nuxt/test-utils` 运行（这是对 spec 中“2a 用 Deno”的必要修正，验收目标不变）。

---

### Task 1: 引入 Vitest 与 @nuxt/test-utils

**Files:**
- Modify: `noj-ui/package.json`
- Create: `noj-ui/vitest.config.ts`
- Create: `noj-ui/tests/setup.ts`
- Modify: `noj-ui/deno.json`

**Interfaces:**
- Consumes: 现有 Nuxt 4 项目结构。
- Produces: `deno task test:components` 可运行 Vitest。

- [ ] **Step 1: 添加 devDependencies**

修改 `noj-ui/package.json` 的 `devDependencies`：

```json
{
  "devDependencies": {
    "@nuxt/test-utils": "^3.14.0",
    "@vue/test-utils": "^2.4.6",
    "happy-dom": "^15.7.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: 创建 vitest.config.ts**

创建 `noj-ui/vitest.config.ts`：

```ts
import { defineVitestConfig } from '@nuxt/test-utils/config';

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts'],
  },
});
```

- [ ] **Step 3: 创建 setup.ts**

创建 `noj-ui/tests/setup.ts`：

```ts
// Vitest 全局设置：清理 DOM 与 Nuxt 运行时状态。
import { afterEach } from 'vitest';
import { cleanup } from '@vue/test-utils';

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 4: 在 deno.json 增加任务**

修改 `noj-ui/deno.json` 的 `tasks`：

```json
{
  "tasks": {
    "test:components": "deno run -A npm:vitest run"
  }
}
```

- [ ] **Step 5: 安装依赖并验证空跑**

Run: `cd noj-ui && npm install`
Run: `cd noj-ui && deno task test:components`
Expected: Vitest 启动并报告“No test files found”（或 0 个测试通过），不报配置错误。

- [ ] **Step 6: 提交**

```bash
jj describe -m "build(ui): 引入 Vitest 与 @nuxt/test-utils"
```

---

### Task 2: usePolling composable 测试

**Files:**
- Create: `noj-ui/tests/composables/usePolling.spec.ts`

**Interfaces:**
- Consumes: `usePolling` 的 `PollingOptions`。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-ui/tests/composables/usePolling.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePolling } from '~/composables/usePolling';

describe('usePolling', () => {
  it('立即执行一次 fetcher', async () => {
    const fetcher = vi.fn(async () => {});
    usePolling({ intervalMs: 1000, fetcher, immediate: true });
    await nextTick();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('intervalMs 为 null 时不启动定时器', async () => {
    const fetcher = vi.fn(async () => {});
    usePolling({ intervalMs: ref<number | null>(null), fetcher, immediate: true });
    await nextTick();
    expect(fetcher).toHaveBeenCalledTimes(0);
  });

  it('stopWhen 满足后停止轮询', async () => {
    const fetcher = vi.fn(async () => {});
    let done = false;
    const { stop } = usePolling({
      intervalMs: 1000,
      fetcher,
      immediate: true,
      stopWhen: () => done,
    });
    done = true;
    await nextTick();
    stop();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-ui && deno task test:components`
Expected: FAIL，`usePolling` 在测试环境中 `import.meta.client` 为 false 导致 fetcher 未执行，或测试文件不存在。

- [ ] **Step 3: 让 @nuxt/test-utils 提供客户端运行时**

若 `import.meta.client` 在测试中为 false，在 `vitest.config.ts` 中启用 Nuxt 测试运行时（`@nuxt/test-utils/config` 已默认提供）；若仍为 false，在测试文件顶部添加：

```ts
// @ts-expect-error Nuxt 测试运行时注入
import.meta.client = true;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-ui && deno task test:components`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(ui): usePolling composable 测试"
```

---

### Task 3: useApi composable 测试

**Files:**
- Create: `noj-ui/tests/composables/useApi.spec.ts`

**Interfaces:**
- Consumes: `useApi` 返回的 `api` 对象。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-ui/tests/composables/useApi.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { mockNuxtImport } from '@nuxt/test-utils/runtime';
import { useApi } from '~/composables/useApi';

const toastError = vi.fn();
mockNuxtImport('useToast', () => () => ({ toast: { error: toastError } }));
mockNuxtImport('useI18n', () => () => ({ locale: { value: 'zh-CN' } }));
mockNuxtImport('useRoute', () => () => ({ path: '/problems', fullPath: '/problems' }));

describe('useApi', () => {
  it('成功请求返回数据', async () => {
    vi.stubGlobal('$fetch', vi.fn(async () => ({ ok: true })));
    const { api } = useApi();
    const data = await api.get('/api/v1/health');
    expect(data).toEqual({ ok: true });
  });

  it('非 2xx 错误提取 message 并重抛', async () => {
    const err = new Error('fetch error') as Error & { data?: unknown; status?: number };
    err.data = { error: '题目不存在' };
    err.status = 404;
    vi.stubGlobal('$fetch', vi.fn(async () => { throw err; }));
    const { api } = useApi();
    await expect(api.get('/api/v1/problems/x')).rejects.toThrow('fetch error');
    expect(toastError).toHaveBeenCalledWith('题目不存在');
  });

  it('silent 模式不弹 toast', async () => {
    const err = new Error('fetch error') as Error & { data?: unknown; status?: number };
    err.data = { error: '内部错误' };
    err.status = 500;
    vi.stubGlobal('$fetch', vi.fn(async () => { throw err; }));
    const { api } = useApi();
    await expect(api.get('/api/v1/x', { silent: true })).rejects.toThrow();
    expect(toastError).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-ui && deno task test:components`
Expected: FAIL，`useApi` 依赖的 `useRequestFetch` / `useState` / `useCookie` / `navigateTo` 未 mock 或 `$fetch` 未 stub。

- [ ] **Step 3: 补齐 Nuxt auto-import mock**

在测试文件顶部继续 mock 缺失的 auto-import：

```ts
mockNuxtImport('useState', () => (key: string) => {
  const state = ref(null);
  return state;
});
mockNuxtImport('useCookie', () => () => ({ value: null }));
mockNuxtImport('navigateTo', () => vi.fn());
mockNuxtImport('useRequestFetch', () => () => undefined);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-ui && deno task test:components`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(ui): useApi composable 测试"
```

---

### Task 4: 核心组件交互测试

**Files:**
- Create: `noj-ui/tests/components/CheckInCard.spec.ts`
- Create: `noj-ui/tests/components/SubmissionResult.spec.ts`

**Interfaces:**
- Consumes: `CheckInCard`、`SubmissionResult` 组件 props/emits。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

创建 `noj-ui/tests/components/CheckInCard.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import CheckInCard from '~/components/checkin/CheckInCard.vue';

describe('CheckInCard', () => {
  it('渲染连续签到天数', async () => {
    const wrapper = await mountSuspended(CheckInCard, {
      props: { streak: 3, checkedInToday: false },
    });
    expect(wrapper.text()).toContain('3');
  });

  it('今日已签到显示已签到状态', async () => {
    const wrapper = await mountSuspended(CheckInCard, {
      props: { streak: 1, checkedInToday: true },
    });
    expect(wrapper.text()).toContain('已签到');
  });
});
```

创建 `noj-ui/tests/components/SubmissionResult.spec.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import SubmissionResult from '~/components/submission/SubmissionResult.vue';

describe('SubmissionResult', () => {
  it('渲染 AC 状态与分数', async () => {
    const wrapper = await mountSuspended(SubmissionResult, {
      props: {
        result: { status: 'finished', score: 100, output: '', details: {} },
      },
    });
    expect(wrapper.text()).toContain('答案正确');
  });

  it('渲染 WA 状态', async () => {
    const wrapper = await mountSuspended(SubmissionResult, {
      props: {
        result: { status: 'finished', score: 0, output: 'wrong', details: {} },
      },
    });
    expect(wrapper.text()).toContain('答案错误');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-ui && deno task test:components`
Expected: FAIL，组件路径或 props 与实现不符。

- [ ] **Step 3: 按实际组件 props 修正测试**

阅读 `noj-ui/components/checkin/CheckInCard.vue` 与 `noj-ui/components/submission/SubmissionResult.vue`，将 props 名/文案调整为实际实现；若组件依赖 `useApi` 等 composable，用 `mockNuxtImport` 补齐。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-ui && deno task test:components`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
jj describe -m "test(ui): CheckInCard 与 SubmissionResult 组件测试"
```

---

### Task 5: 将组件测试纳入 CI（可选独立 job）

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `deno task test:components`。
- Produces: CI 中 `ui-components` job。

- [ ] **Step 1: 在 ci.yml 增加 ui-components job**

在 `ui-check` job 后追加：

```yaml
  ui-components:
    name: UI Components
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x
      - name: 安装依赖
        working-directory: noj-ui
        run: npm install
      - name: 组件测试
        working-directory: noj-ui
        run: deno task test:components
```

- [ ] **Step 2: 提交**

```bash
jj describe -m "ci(ui): 组件测试纳入 CI 独立 job"
```
