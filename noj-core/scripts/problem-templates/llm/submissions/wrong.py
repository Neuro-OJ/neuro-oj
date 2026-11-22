"""典型错解：忘了把留言放进提示词，模型拿不到订单号。"""


def build_prompt(message: str) -> str:
    return "请只输出这条客服留言中的订单号。"
