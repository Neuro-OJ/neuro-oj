# 界面题脚本模板：平台会在本文件前注入 PARAMS（界面提交的参数 JSON）。
# 选手看不到本文件，只能通过 ui.html 填参数；不要假设参数一定存在或类型正确。
# TODO(出题人)：按你的题目改写参数解析与判定逻辑，并同步 statement.md 与 ui.html。


def _keywords() -> list[str]:
    raw = PARAMS.get("keywords", "")  # noqa: F821 — PARAMS 由平台注入
    if not isinstance(raw, str):
        return []
    return [k.strip() for k in raw.split(",") if k.strip()][:50]


def _min_hits() -> int:
    value = PARAMS.get("min_hits", 1)  # noqa: F821
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 1
    return min(5, max(1, int(value)))


def classify(text: str) -> bool:
    """评测脚本调用的入口：True 表示判为营销短信。"""
    words = _keywords()
    if not words:
        return False
    hits = sum(1 for w in set(words) if w in text)
    return hits >= _min_hits()
