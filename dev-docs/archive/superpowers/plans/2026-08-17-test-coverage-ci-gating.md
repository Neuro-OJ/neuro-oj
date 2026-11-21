# 测试覆盖与 CI 门禁改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐当前测试覆盖评估中发现的 CI 漏跑、前端无测试、注释/任务过期等可靠性缺口，使“CI 绿灯”更可信（覆盖率门禁按用户要求取消，不在本次范围）。

**Architecture:** 本次改动集中在 CI 工作流、noj-tests 清单、noj-ui 纯工具函数单测三块；不触碰业务逻辑，不改动运行时代码，风险低。低覆盖模块的深度单测与覆盖率门禁拆为后续独立计划。

**Tech Stack:** Deno 2.9、GitHub Actions、Bash、Python 3（校验脚本）、TypeScript。

**Spec:** 依据本会话的《Neuro OJ 测试覆盖与可靠性评估》结论，重点修复：

1. `e2e.yml` 漏跑 3 个 E2E 文件（27_objective / 28_clarifications / 29_avatar，共 13 个用例）。
2. noj-ui 仅有 1 个工具函数测试，且 CI 不运行测试。
3. `noj-tests/deno.json` 的 `test:unit` 指向不存在的目录；`e2e.yml`/`ci.yml` 存在过期数量与目标清单注释。

## Global Constraints

- 遵守 `AGENTS.md`：禁止直接推送 main；提交必须 GPG 签名；提交信息用 Conventional Commits 中文描述。
- 测试/CI 改造不得改变现有业务行为，不得修改 `deno.lock` / `Cargo.lock` 手动内容。
- 所有改动必须保持现有测试套件继续通过；新增 CI 步骤失败会阻断合并。
- 中文注释、英文标识符。
- 涉及 OpenSpec 时先按仓库流程提案；本计划以测试与 CI 配置为主，若维护者要求功能性变更走 OpenSpec，则先创建 `/opsx:propose`。

---

### Task 1: 修复 E2E 漏跑文件并增加防漏校验

**Files:**
- Modify: `.github/workflows/e2e.yml`
- Test: 仓库根执行校验脚本（不新增文件）

**Interfaces:**
- Consumes: 现有 `noj-tests/e2e/*.test.ts` 30 个文件
- Produces: CI 中 `e2e-full` job 执行全部 30 个文件 / 204 个 `e2eTest` 用例

- [ ] **Step 1: 定位 e2e.yml 中显式 E2E 文件清单**

在 `.github/workflows/e2e.yml` 中找到 `run_group \` 三段清单，当前只列到 `e2e/28_announcements.test.ts`，缺少：

```
e2e/27_objective.test.ts
e2e/28_clarifications.test.ts
e2e/29_avatar.test.ts
```

- [ ] **Step 2: 在第三组中追加缺失文件**

将第三组 `run_group \` 修改为：

```yaml
          run_group \
            e2e/16_community.test.ts \
            e2e/17_problem_template.test.ts \
            e2e/18_search.test.ts \
            e2e/19_admin_endpoints.test.ts \
            e2e/20_password_reset.test.ts \
            e2e/21_rankings.test.ts \
            e2e/22_contest_lifecycle.test.ts \
            e2e/23_network_capability.test.ts \
            e2e/24_import_bundle.test.ts \
            e2e/25_rbac.test.ts \
            e2e/26_call_timeout.test.ts \
            e2e/27_objective.test.ts \
            e2e/28_announcements.test.ts \
            e2e/28_clarifications.test.ts \
            e2e/29_avatar.test.ts &
```

- [ ] **Step 3: 在 e2e-full 测试前增加“文件清单防漏”步骤**

在 `- name: E2E 测试 (noj-tests, 3 组并行)` 之前插入：

```yaml
      - name: 校验 E2E 文件均已加入 workflow 清单
        working-directory: noj-tests
        run: |
          python3 - <<'PY'
          from pathlib import Path
          files = sorted(p.name for p in Path('e2e').glob('*.test.ts'))
          wf = Path('../.github/workflows/e2e.yml').read_text(encoding='utf-8')
          missing = [f for f in files if f not in wf]
          if missing:
              raise SystemExit(f"E2E 文件未在 e2e.yml 清单中: {', '.join(missing)}")
          print(f"OK: {len(files)} 个 E2E 文件均已在 workflow 中")
          PY
```

- [ ] **Step 4: 更新 e2e.yml 顶部与分组注释的数量**

将：

```yaml
#   - e2e-full：noj-tests 全量 E2E（70 API + 管道 + 队列可见性测试）
```

改为：

```yaml
#   - e2e-full：noj-tests 全量 E2E（30 个测试文件 / 204 个 e2eTest 用例）
```

将分组注释中的 `23 个测试文件` 改为 `30 个测试文件`（共两处：文件顶部与执行步骤注释）。

- [ ] **Step 5: 本地验证清单完整**

在仓库根运行：

```bash
python3 - <<'PY'
from pathlib import Path
files = sorted(p.name for p in Path('noj-tests/e2e').glob('*.test.ts'))
wf = Path('.github/workflows/e2e.yml').read_text(encoding='utf-8')
missing = [f for f in files if f not in wf]
assert not missing, f"missing: {missing}"
print(f"OK: {len(files)} files referenced")
PY
```

预期输出：`OK: 30 files referenced`

- [ ] **Step 6: 校验 YAML 语法**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/e2e.yml')); print('yaml ok')"
```

如环境无 PyYAML，可改跑 `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/e2e.yml'); puts 'yaml ok'"`。

- [ ] **Step 7: 提交**

```bash
git add .github/workflows/e2e.yml
jj describe -m "ci(e2e): 补跑 objective/clarifications/avatar E2E 并增加文件清单校验"
```

---

### Task 2: noj-ui 测试进入 CI 并补充纯工具函数单测

**Files:**
- Create: `noj-ui/tests/submissionFormat_test.ts`
- Create: `noj-ui/tests/validatePassword_test.ts`
- Create: `noj-ui/tests/isAdminUser_test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `noj-ui/utils/submissionFormat.ts`、`noj-ui/utils/validatePassword.ts`、`noj-ui/utils/isAdminUser.ts` 的现有导出
- Produces: CI `ui-check` job 在构建后运行 `deno task test`；三个纯工具模块获得基本单测覆盖

- [ ] **Step 1: 新增 `noj-ui/tests/submissionFormat_test.ts`**

```ts
/**
 * utils/submissionFormat.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  formatAcceptanceRate,
  formatDateTime,
  formatMemory,
  formatScore,
  formatTime,
  getLanguageLabel,
  getResultDef,
  getStatusColor,
  getStatusLabel,
} from '../utils/submissionFormat.ts';

Deno.test('formatScore: 正常值、零值与空值', () => {
  assertEquals(formatScore(100), '1.0');
  assertEquals(formatScore(0), '0.0');
  assertEquals(formatScore(null), '--');
  assertEquals(formatScore(undefined), '--');
});

Deno.test('formatTime: 毫秒与秒', () => {
  assertEquals(formatTime(500), '500ms');
  assertEquals(formatTime(1500), '1.50s');
  assertEquals(formatTime(null), '--');
});

Deno.test('formatMemory: KB/MB/GB', () => {
  assertEquals(formatMemory(512), '512KB');
  assertEquals(formatMemory(1536), '1.5MB');
  assertEquals(formatMemory(2097152), '2.00GB');
  assertEquals(formatMemory(null), '--');
});

Deno.test('getStatusColor: result 优先，state 回退，未知兜底', () => {
  assertEquals(getStatusColor('finished', 'Accepted'), '#10b981');
  assertEquals(getStatusColor('pending', null), '#9ca3af');
  assertEquals(getStatusColor('unknown', null), '#6b7280');
});

Deno.test('getStatusLabel: result 优先，state 回退，未知原样返回', () => {
  assertEquals(getStatusLabel('finished', 'Accepted'), '答案正确');
  assertEquals(getStatusLabel('pending', null), '等待评测');
  assertEquals(getStatusLabel('unknown', null), 'unknown');
});

Deno.test('getLanguageLabel: 已知语言映射，未知原样返回', () => {
  assertEquals(getLanguageLabel('cpp'), 'C++');
  assertEquals(getLanguageLabel('java'), 'Java');
  assertEquals(getLanguageLabel('pascal'), 'pascal');
});

Deno.test('formatAcceptanceRate: 0-1 转百分号，空值占位', () => {
  assertEquals(formatAcceptanceRate(0.756), '75.6%');
  assertEquals(formatAcceptanceRate(1), '100.0%');
  assertEquals(formatAcceptanceRate(null), '--');
});

Deno.test('formatDateTime: 空值占位，合法时间非占位', () => {
  assertEquals(formatDateTime(null), '--');
  assertEquals(formatDateTime(undefined), '--');
  const out = formatDateTime('2026-08-17T00:00:00Z');
  assertEquals(out.includes('2026'), true);
});

Deno.test('getResultDef: 已知/未知状态返回定义', () => {
  assertEquals(getResultDef('Accepted').label, '答案正确');
  assertEquals(getResultDef('Accepted').class, 'accepted');
  assertEquals(getResultDef('Nope').label, 'Nope');
  assertEquals(getResultDef(undefined).label, '未知');
});
```

- [ ] **Step 2: 新增 `noj-ui/tests/validatePassword_test.ts`**

```ts
/**
 * utils/validatePassword.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  validateEmail,
  validatePassword,
  validatePasswordMatch,
} from '../utils/validatePassword.ts';

Deno.test('validatePassword: 空值、长度与字符组成校验', () => {
  assertEquals(validatePassword(''), { valid: false, message: '请输入密码' });
  assertEquals(validatePassword('short'), { valid: false, message: '密码长度不能少于 8 位' });
  assertEquals(validatePassword('UPPERCASE1234'), { valid: false, message: '密码必须包含至少一个小写字母' });
  assertEquals(validatePassword('lowercase1234'), { valid: false, message: '密码必须包含至少一个大写字母' });
  assertEquals(validatePassword('LowercaseLetters'), { valid: false, message: '密码必须包含至少一个数字' });
  assertEquals(validatePassword('ValidPass1234'), { valid: true, message: '' });
});

Deno.test('validatePasswordMatch: 空确认与不一致', () => {
  assertEquals(validatePasswordMatch('a', ''), '请确认密码');
  assertEquals(validatePasswordMatch('a', 'b'), '两次输入的密码不一致');
  assertEquals(validatePasswordMatch('a', 'a'), null);
});

Deno.test('validateEmail: 空值、非法格式与合法格式', () => {
  assertEquals(validateEmail(''), '请输入邮箱地址');
  assertEquals(validateEmail('  '), '请输入邮箱地址');
  assertEquals(validateEmail('bad'), '邮箱格式不正确');
  assertEquals(validateEmail('a@b.com'), null);
});
```

- [ ] **Step 3: 新增 `noj-ui/tests/isAdminUser_test.ts`**

```ts
/**
 * utils/isAdminUser.ts 单元测试。
 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本，与 noj-core 测试写法一致
import { assertEquals } from 'jsr:@std/assert@^1';
import { isAdminUser } from '../utils/isAdminUser.ts';

Deno.test('isAdminUser: 空值返回 false', () => {
  assertEquals(isAdminUser(null), false);
  assertEquals(isAdminUser(undefined), false);
});

Deno.test('isAdminUser: is_admin 字段优先', () => {
  assertEquals(isAdminUser({ is_admin: true }), true);
  assertEquals(isAdminUser({ is_admin: false }), false);
  assertEquals(isAdminUser({ is_admin: false, role: 'admin' }), false);
});

Deno.test('isAdminUser: 无 is_admin 时兼容 role 字段', () => {
  assertEquals(isAdminUser({ role: 'admin' }), true);
  assertEquals(isAdminUser({ role: 'user' }), false);
});
```

- [ ] **Step 4: 本地运行 noj-ui 测试**

```bash
cd noj-ui
deno task test
```

预期：全部通过（含原有 10 个 + 新增 15 个 = 25 个）。

- [ ] **Step 5: 在 ci.yml 的 ui-check job 中增加测试步骤**

在 `ui-check` job 的 `deno task build` 步骤之后、上传失败日志之前插入：

```yaml
      - name: 单元测试 (deno task test)
        working-directory: noj-ui
        run: deno task test
```

- [ ] **Step 6: 提交**

```bash
git add noj-ui/tests/submissionFormat_test.ts noj-ui/tests/validatePassword_test.ts noj-ui/tests/isAdminUser_test.ts .github/workflows/ci.yml
jj describe -m "test(ui): 补充纯工具函数单测并纳入 CI"
```

---

### Task 3: 清理过期任务与注释

**Files:**
- Modify: `noj-tests/deno.json`
- Modify: `.github/workflows/e2e.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: 无
- Produces: 仓库内不再存在指向不存在目录的任务；CI 注释数量与实际一致

- [ ] **Step 1: 删除 noj-tests 中无效的 test:unit 任务**

`noj-tests/deno.json` 当前有：

```json
    "test:unit": "deno test -A unit/"
```

但 `noj-tests/unit/` 目录不存在。删除该行；若后续补上单元测试再重新添加。

- [ ] **Step 2: 修正 ci.yml 中“71 个测试文件”注释**

将：

```yaml
  # 性能优化（2026-07）：原 core-test 单一 job 串行跑全部 71 个测试文件
```

改为：

```yaml
  # 性能优化（2026-07）：原 core-test 单一 job 串行跑全部测试文件
```

- [ ] **Step 3: 修正 ci.yml judge-e2e 与 e2e.yml judge-sandbox 目标清单注释**

将 ci.yml 中：

```yaml
          # 与 e2e.yml 保持完全一致的 5 个目标清单（e2e_container_pool 已随
          # 容器池移除而删除，见 remove-container-pool 变更）。
```

改为：

```yaml
          # ci.yml 此处跑 5 个基础沙箱目标；dual_container / network_capability
          # 由 e2e.yml 的 judge-sandbox job 覆盖（共 7 个目标）。
```

- [ ] **Step 4: 本地验证 noj-tests tasks 可执行**

```bash
cd noj-tests && deno task --list
```

预期输出中不再包含 `test:unit`。

- [ ] **Step 5: 提交**

```bash
git add noj-tests/deno.json .github/workflows/e2e.yml .github/workflows/ci.yml
jj describe -m "chore(root): 清理过期测试任务与 CI 注释"
```

---

## 后续独立计划（不在本 plan 中实施）

以下工作量大且独立，建议各建独立 plan，避免本 plan 过大：

1. **noj-ui 组件/composable 测试扩展**：为 `useApi`、`useAuth`、`usePolling`、`useProblemFilters` 等补测试，需要引入 Nuxt 测试运行器（如 `@nuxt/test-utils`）或 mock auto-import。
2. **noj-core 低覆盖模块测试**：`event-bus`、`sse-stream`、`storage/factory`、`seed-system`、`routes/sse`、CLI `scripts/noj.ts` 的针对性单测。
3. **消除静默跳过**：为依赖真实 PG/S3 的测试增加显式 skip 汇总报告，或默认在 CI 中缺失环境时 fail。

---

## Self-Review

- **Spec coverage**：Task 1 覆盖“e2e.yml 漏跑 3 文件”；Task 2 覆盖“noj-ui 测试缺失且 CI 不跑”；Task 3 覆盖“过期任务/注释”。覆盖率门禁已按用户要求取消，低覆盖模块测试已明确拆为后续计划。
- **Placeholder scan**：所有代码/YAML/命令均给出实际内容，无 TBD/TODO。
- **Type consistency**：新增测试只导入现有导出函数，无新接口；CI 步骤与现有 job 命名、路径、环境变量约定一致。
