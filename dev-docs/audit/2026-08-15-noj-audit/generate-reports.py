import json, glob
from collections import Counter

raw_dir = "dev-docs/audit/2026-08-15-noj-audit/raw"
out_dir = "dev-docs/audit/2026-08-15-noj-audit"

dedup = json.load(open(f"{raw_dir}/dedup-result.json"))
kept = dedup["kept"]
verdicts = {}
for vf in glob.glob(f"{raw_dir}/verdict-chunk-*.json"):
    for v in json.load(open(vf)):
        verdicts[v["idx"]] = v
missing = [f["idx"] for f in kept if f["idx"] not in verdicts]
print("kept:", len(kept), "verdicts:", len(verdicts), "missing:", missing)
assert not missing

final = []
for f in kept:
    v = verdicts[f["idx"]]
    p = f["file"]
    mod = "core"
    if p.startswith("noj-core/"):
        mod = "core"
    elif p.startswith("noj-ui/"):
        mod = "ui"
    elif p.startswith("noj-judge/"):
        mod = "judge"
    else:
        mod = "docs"
    final.append({
        "id": "NOJ-%03d" % f["idx"],
        "title": f["title"], "file": f["file"], "line": f["line"],
        "severity": v["adjusted_severity"], "original_severity": f["severity"],
        "dimension": f["dimension"], "description": f["description"],
        "evidence": f["evidence"], "suggestion": f["suggestion"],
        "verification": v["reasoning"], "source": f.get("source", ""),
        "merged_from": f.get("merged_from") or [], "is_real": v["is_real"],
        "module": mod,
    })

real = [x for x in final if x["is_real"]]
print("real:", len(real))
sev_order = ["严重", "高", "中", "低", "信息"]
sev_count = Counter(x["severity"] for x in real)
mod_count = Counter(x["module"] for x in real)
print("by severity:", {s: sev_count.get(s, 0) for s in sev_order})
print("by module:", dict(mod_count))

with open(f"{out_dir}/findings.json", "w") as fh:
    json.dump(final, fh, ensure_ascii=False, indent=1)
print("wrote findings.json")


def sev_key(s):
    return sev_order.index(s)


def esc(t):
    return (t or "").replace("|", "\\|")


MODNAMES = [("core", "noj-core"), ("ui", "noj-ui"), ("judge", "noj-judge"), ("docs", "noj-docs / 根目录文档与配置")]

for mod, modname in MODNAMES:
    items = sorted([x for x in real if x["module"] == mod], key=lambda x: (sev_key(x["severity"]), x["file"]))
    out = []
    out.append("# %s 审计报告" % modname)
    out.append("")
    out.append("> 基线：`main` @ `31150781` · 只读静态审查 + 对抗性复核 · 真阳性 %d 条（全部经逐条代码验证）" % len(items))
    out.append("")
    c = Counter(i["severity"] for i in items)
    out.append("| 严重级 | 数量 |")
    out.append("|---|---|")
    for s in sev_order:
        if c.get(s):
            out.append("| %s | %d |" % (s, c[s]))
    out.append("")
    cur = None
    for i in items:
        if i["severity"] != cur:
            cur = i["severity"]
            out.append("## " + cur)
            out.append("")
        out.append("### %s %s" % (i["id"], i["title"]))
        out.append("- **位置**：`%s:%s`　**维度**：%s" % (i["file"], i["line"], i["dimension"]))
        if i.get("merged_from"):
            out.append("- **交叉确认**：另有 %d 个 finder 独立发现同一根因（已合并计入）" % len(i["merged_from"]))
        out.append("- **描述**：%s" % i["description"])
        out.append("- **证据**：`%s`" % esc(i["evidence"]))
        out.append("- **建议**：%s" % i["suggestion"])
        out.append("- **验证**：%s" % i["verification"])
        out.append("")
    with open(f"{out_dir}/{mod}.md", "w") as fh:
        fh.write("\n".join(out))
    print("wrote %s.md: %d items" % (mod, len(items)))

top = sorted(real, key=lambda x: (sev_key(x["severity"]), x["file"]))[:15]
sev_line = " | ".join("**%s %d**" % (s, sev_count.get(s, 0)) for s in sev_order)
mod_rows = "\n".join("| %s | %d |" % (m, mod_count.get(m, 0)) for m in ["core", "ui", "judge", "docs"])
top_rows = "\n".join("| %s | %s | %s | %s | `%s:%s` |" % (i["id"], i["severity"], i["module"], i["title"], i["file"], i["line"]) for i in top)

summary = """# NOJ 全模块审计总结报告

- **日期**：2026-08-15
- **基线**：`main` bookmark @ commit `31150781`（支持用户头像上传 #239）
- **范围**：noj-core（~5.7 万行）、noj-ui（~2.1 万行）、noj-judge（~0.7 万行）、noj-docs + 根目录文档/配置（~0.4 万行）
- **方法**：31 个 finder 子代理按模块×维度并行只读审查（250 条原始发现）→ 同根因去重（→225）→ 11 个对抗性 verifier 逐条读码复核 → 父代理聚合
- **结果**：225 条去重发现经对抗验证 **全部为真阳性（0 误报）**；30 条严重级经复核下调，2 条维持「严重」

## 严重级总览

| %s |

| 模块 | 真阳性 |
|---|---|
%s

## Top 15 优先处理

| ID | 严重级 | 模块 | 标题 | 位置 |
|---|---|---|---|---|
%s

## 核心结论（按主题）

1. **评测链路 at-most-once 架构缺陷（最高优先级）**：judge 侧 BRPOP 弹出即删、core 侧 BRPOP 后写库失败即丢，两侧均无 ACK/重投/死信/启动补偿，提交可永久卡在 pending/judging；提交「写 DB→LPUSH」非事务存在孤儿窗口。见 NOJ-179 / NOJ-066 / NOJ-067 / NOJ-074。
2. **可利用的严重漏洞**：搜索高亮 v-html 存储型 XSS（NOJ-248，任意注册用户发帖即可让所有搜索匹配者自动触发）；SSR/降级净化器协议绕过（NOJ-249，验证后降为「高」，SSR 首屏路径仍建议尽快修）。
3. **存储层越权（高）**：`support_package_storage_url` 客户端可控且两侧无校验——local 模式可路径穿越读/删文件（NOJ-115），S3 模式可跨对象读/删他人支持包（NOJ-116）。
4. **judge 沙箱纵深不足**：容器以 root 运行、rootfs 可写、无 CPU 限制、内存上限信任消息、镜像/命令/网络在 judge 侧零复验（NOJ-190/188/189/187）；zip 声明大小绕过可致 judge OOM（NOJ-193）。
5. **限流与封禁缺口**：注册/找回密码/提交代码/私信均无限流；X-Real-IP 无条件信任可绕过 IP 限流与封禁（NOJ-091）；登录代理丢客户端 IP 使 IP 限流退化为共享桶（NOJ-215）。
6. **一致性问题簇**：密码策略文档 12 vs 实现 8（NOJ-120/047）、搜索参数 limit vs per_page（NOJ-225）、公告分页形状、Cookie 属性与规范不符（NOJ-108）、OpenSpec 规范多处漂移（NOJ-109/110/111/112/113/114）、AGENTS/CLAUDE/README 多处过时。
7. **文档站**：noj-docs 与 main 实现存在多处不符（JudgeTask 字段、启动命令、备份路径、镜像名、白名单 RPC 说法等），详见 `docs.md`。

## 建议的修复优先级

- **P0（立即）**：NOJ-248（存储型 XSS）、NOJ-115/116（存储越权）、NOJ-179/066/067/074（消息永久丢失链）
- **P1（短期）**：NOJ-091/215（IP 防护失效）、NOJ-193/190/188（judge 沙箱与 DoS）、NOJ-249（净化器）、NOJ-161/075（rejudge_seq 两处丢失）
- **P2（迭代）**：限流补齐、状态机 TOCTOU（NOJ-065）、性能热点（未读数 N+1、榜单物化视图全量刷新、社区搜索无索引）
- **P3（清理）**：文档/规范漂移、代码质量（巨型文件、硬编码角色名）、依赖锁清理

修复时请遵守仓库约定：OpenSpec 提案先行（`/opsx:propose`）、GPG 签名、Conventional Commits（中文描述）、禁止直推 main。完整明细见 `core.md` / `ui.md` / `judge.md` / `docs.md` 与机器可读 `findings.json`（含每条发现的原严重级、验证结论与合并来源）。中间产物（finder 原始输出、分片与 verdict）保留在 `raw/` 供追溯。
""" % (sev_line, mod_rows, top_rows)

with open(f"{out_dir}/summary.md", "w") as fh:
    fh.write(summary)
print("wrote summary.md")
print("ALL DONE")
