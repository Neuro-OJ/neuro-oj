"""典型错解：最大值初值取 0，全负数与空列表都会算错。"""

import json


def solve(input_str: str) -> str:
    nums = json.loads(input_str)["nums"]
    best = 0
    for x in nums:
        best = max(best, x)
    return json.dumps({"sum": sum(nums), "max": best})
