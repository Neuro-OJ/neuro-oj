"""参考解答（满分）。submissions/ 不进题目包，只用于 noj-cli problem test。"""

import json


def solve(input_str: str) -> str:
    nums = json.loads(input_str)["nums"]
    return json.dumps({"sum": sum(nums), "max": max(nums) if nums else None})
