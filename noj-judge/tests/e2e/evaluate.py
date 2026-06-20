#!/usr/bin/env python3
"""测试用评测脚本——模拟 evaluate.py 的各种行为。

支持参数：
  --exit-code N    指定退出码（默认 0）
  --no-result      不输出 ---RESULT--- 标记
  --result-json S  自定义结果 JSON 字符串
  --memory-test    分配大量内存触发 OOM
  --hang           进入无限循环（配合超时测试）
"""

import argparse
import json
import sys
import time


def main():
    parser = argparse.ArgumentParser(description="Test evaluation script")
    parser.add_argument("--exit-code", type=int, default=0)
    parser.add_argument("--no-result", action="store_true")
    parser.add_argument("--result-json", type=str, default=None)
    parser.add_argument("--memory-test", action="store_true")
    parser.add_argument("--hang", action="store_true")
    args = parser.parse_args()

    if args.hang:
        while True:
            time.sleep(1)

    if args.memory_test:
        data = []
        while True:
            data.append([0] * 10_000_000)
            time.sleep(0.1)

    user_code = ""
    try:
        with open("/tmp/submission.py") as f:
            user_code = f.read()
    except FileNotFoundError:
        pass

    print(f"evaluate.py started")
    if user_code:
        print(f"user code: {user_code.strip()}")
    else:
        print("no user code found")

    if not args.no_result:
        result = args.result_json or json.dumps({
            "status": "Accepted", "score": 1000, "details": {}
        })
        print("---RESULT---")
        print(result)

    sys.exit(args.exit_code)


if __name__ == "__main__":
    main()
