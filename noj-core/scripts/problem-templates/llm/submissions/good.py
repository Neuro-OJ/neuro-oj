"""参考解答：指令 + 留言原文。submissions/ 不进题目包。"""


def build_prompt(message: str) -> str:
    return (
        "下面是一条客服留言，请找出其中形如 NO-12345 的订单号，"
        "只输出订单号本身，不要输出其他任何内容。\n\n"
        f"留言：{message}"
    )
