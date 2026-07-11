# 全文搜索设计（issue #100）

**日期**：2026-07-11
**状态**：设计稿（待评审）
**作者**：brainstorming 会话产出
**关联 issue**：[Neuro-OJ/neuro-oj#100](https://github.com/Neuro-OJ/neuro-oj/issues/100)

---

## 1. 目标与背景

当前 NOJ 缺乏通用全文搜索能力：题目列表只支持按 `display_id` 精确查询，用户搜索只在前缀匹配端点 `/users/search` 内。issue #100 要求实现跨题目 + 用户的全文搜索，且不引入 Elasticsearch 等外部依赖，复用 PostgreSQL 内置能力。

### 验收标准（来自 issue）

- [ ] problems 表添加 tsvector 列 + GIN 索引（通过迁移）
- [ ] 题目创建/更新时自动更新 tsvector
- [ ] 搜索 API 返回分页结果，含中文分词支持（pg_trgm 或简单分词）
- [ ] 前端导航栏新增搜索框（快捷键 Ctrl+K）
- [ ] 搜索结果页：题目 → 跳转题目页，用户 → 跳转用户主页（admin 可见）
- [ ] 搜索性能：10 万题 + 1 万用户时响应 < 500ms

---

## 2. 设计决策汇总

| 决策项 | 选择 | 理由 |
|---|---|---|
| API 结构 | 新增 `/api/v1/search`，保留 `/users/search` | 向后兼容，私信迁移另开 issue |
| 中文分词 | pg_trgm 三元组 + `simple` 词典 | 内置、无扩展依赖、亿级 < 50ms |
| 搜索框交互 | Ctrl+K 触发全屏 palette 弹窗 | GitHub/Linear/Notion 主流体验 |
| 用户搜索权限 | `?type=user` 仅 admin | 严格按 issue 要求 |
| 相关性排序 | ts_rank_cd + 多字段加权 | display_id 精确匹配跳前面 |
| tsvector 维护 | PG trigger（BEFORE INSERT/UPDATE） | 应用层零侵入、一致性最高 |

---

## 3. 架构

```
┌──────────┐  Ctrl+K / 按钮        ┌──────────────────┐
│  noj-ui  │ ──────────────────────>│ SearchPalette    │
│          │   GET /api/v1/search   │  (Vue 组件)      │
│          │ <─────────────────────│                  │
└──────────┘   分页 JSON 响应       └──────────────────┘
       │                                       │
       └─────── Nitro 代理 ───────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │   noj-core       │
              │ /search route    │
              │   ├─ problem    │── tsvector + GIN + pg_trgm
              │   └─ user (admin)│── trigram-only
              └──────────────────┘
                       │
                  PostgreSQL 16
```

---

## 4. 数据库层

迁移文件：`noj-core/drizzle/0019_search.sql`。

### 4.1 pg_trgm 扩展

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 4.2 problems 表新增列与 trigger

```sql
ALTER TABLE problems
  ADD COLUMN search_vector tsvector;

-- trigger 函数：拼接 title / description / display_id
CREATE OR REPLACE FUNCTION problems_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(
      NEW.type || NEW.number::text, '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_problems_search_vector
  BEFORE INSERT OR UPDATE OF title, description, type, number ON problems
  FOR EACH ROW EXECUTE FUNCTION problems_search_vector_update();

-- GIN 索引
CREATE INDEX idx_problems_search_vector ON problems
  USING gin(search_vector);

-- display_id 短查询兜底（trigram）
CREATE INDEX idx_problems_display_id_trgm ON problems
  USING gin((type || number::text) gin_trgm_ops);

-- 回填历史数据
UPDATE problems SET search_vector = NULL;
```

### 4.3 users 表 trigram 索引

```sql
CREATE INDEX idx_users_username_trgm ON users
  USING gin(username gin_trgm_ops);

CREATE INDEX idx_users_email_trgm ON users
  USING gin(email gin_trgm_ops);
```

---

## 5. 后端 API

### 5.1 端点

`GET /api/v1/search?q=<query>&type=problem|user&page=1&limit=20`

- `q`：1-100 字符，必填
- `type`：默认 `problem`；`user` 要求 admin 角色
- `page`：默认 1
- `limit`：默认 20，范围 1-100

### 5.2 响应结构

```json
{
  "data": {
    "items": [
      { "id": "...", "display_id": "P1001", "title": "...", "difficulty": "easy" }
    ],
    "total": 42,
    "page": 1,
    "limit": 20
  }
}
```

用户搜索的 item 结构：`{ id, username, email, role }`。

### 5.3 Service 层（`noj-core/src/services/search.ts`）

```
searchProblems(q: string, page: number, limit: number) → ProblemSearchPage
searchUsers(q: string, page: number, limit: number) → UserSearchPage
```

`searchProblems` 查询构造（`$1 = q`，`$2 = '%' || q || '%'`，`$3 = limit`，`$4 = offset`）：

```sql
SELECT id, type, number, title, difficulty,
  ts_rank_cd(search_vector, query, 32) AS rank,
  COUNT(*) OVER() AS total
FROM problems, plainto_tsquery('simple', $1) query
WHERE search_vector @@ query
   OR (type || number::text) ILIKE $2  -- trigram 索引加速
ORDER BY rank DESC, number ASC
LIMIT $3 OFFSET $4;
```

`searchUsers` 查询构造（仅 admin 调用）：

```sql
SELECT id, username, email, role,
  GREATEST(similarity(username, $1), similarity(email, $1)) AS rank
FROM users
WHERE username ILIKE $2 OR email ILIKE $2 OR username % $1 OR email % $1
ORDER BY rank DESC NULLS LAST, created_at DESC
LIMIT $3 OFFSET $4;
```

### 5.4 Route 层（`noj-core/src/routes/search.ts`）

```
search.get("/", async (c) => {
  const { q, type = "problem", page = 1, limit = 20 } = parseQuery(c);
  validate(q, type, page, limit);
  if (type === "user") requireAdmin(c);
  return c.json({ data: await dispatch(type, q, page, limit) });
});
```

### 5.5 兼容旧端点

`GET /api/v1/users/search`（私信用前缀搜索）保留。注释加 `@deprecated`。删除计划另开 issue。

---

## 6. 前端

### 6.1 组件：`SearchPalette.vue`（`noj-ui/components/shared/`）

- 全屏居中 modal，背景半透明 + 模糊（`backdrop-blur-sm`）。
- `<input>` 自动聚焦；输入触发 150ms 防抖 `$fetch /api/v1/search`。
- 结果列表分组：题目、用户（仅 admin）。
- 键盘：↑↓ 选择、Enter 跳转、Esc 关闭。
- 鼠标点击结果同样跳转。
- 空结果展示 "无匹配结果"。
- 加载状态：输入框右侧 spinner。

### 6.2 Composable：`useSearchPalette.ts`

- 暴露 `isOpen`、`open()`、`close()`、`toggle()`。
- `useState('search-palette:open', () => false)` 全局共享。

### 6.3 全局快捷键

`app.vue` `onMounted` 中挂全局 `keydown` 监听：

```typescript
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    toggle();
  }
});
```

### 6.4 页面：`pages/search.vue`

完整分页结果页，URL 同步：`?q=...&type=...&page=...`。
- 题目项 → `/problems/<id>`
- 用户项 → `/users/<id>/profile`

### 6.5 Navbar 集成

`Navbar.vue` 导航栏中部插入搜索图标按钮，hover 显示 "Ctrl+K" 提示。点击触发 `open()`。

---

## 7. 测试覆盖

### 7.1 后端

| 文件 | 覆盖场景 |
|---|---|
| `tests/services/search.test.ts` | mock DB，验证查询构造、分页参数、null q |
| `tests/routes/search.test.ts` | 三种身份（未登录/普通/admin）× 三种 type（缺省/problem/user）+ 长度 < 2 / limit > 100 |
| `tests/db/search-trigger.test.ts` | 迁移后 INSERT/UPDATE 触发器，`search_vector` 自动更新 |

### 7.2 前端

无单元测试框架；E2E 覆盖由 `noj-tests/e2e/14_search.test.ts` 补齐：
- Ctrl+K 打开 palette
- 输入触发查询，结果渲染
- 键盘 ↑↓ 选择 + Enter 跳转
- 管理员 type=user 命中，普通用户 type=user 返 403

### 7.3 性能 smoke

`scripts/perf-search.ts`：生成 10 万题 + 1 万用户（仅当 `NOJ_RUN_PERF=1` 时），断言 P95 < 500ms。不进 CI 默认。

---

## 8. 范围之外（YAGNI）

- 搜索结果高亮（`<em>` 包裹匹配词）：本期不做，留待后续 issue
- 搜索历史 / 自动补全 / 拼写纠错 / 同义词：超出 issue 范围
- 删除 `/users/search`：私信迁移另开 issue
- 跨字段搜索（submissions/categories）：仅题目 + 用户
- zhparser 扩展：被 pg_trgm 替代

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 10 万题 GIN 索引迁移耗时 | 回填放在 trigger 之后；脚本中允许 `CONCURRENTLY` 重建（生产环境） |
| pg_trgm 扩展在某些 PG 镜像中未安装 | `CREATE EXTENSION IF NOT EXISTS` + docker-compose 镜像验证 |
| 用户搜索泄露 email 给 admin | 按 issue 要求严格限制；admin 已有用户管理能力 |
| Palette 全局快捷键与 Monaco 冲突 | 在 `app.vue` 监听时检查 `e.target` 是否在 `<textarea>` / `<input>` 内，是则跳过 |

---

## 10. 实施拆分

按依赖顺序 3 个 PR：

1. **PR-1（DB）**：迁移 + 回填 + trigger 测试。零业务逻辑改动。
2. **PR-2（API + service + tests）**：后端 API、单元测试、e2e 测试。
3. **PR-3（UI）**：palette、composable、page、navbar 集成。